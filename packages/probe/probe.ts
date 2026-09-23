/**
 * probe: bounded status-probe tool for pi (tool-burn reduction T2).
 *
 * Replaces the systemctl/journalctl/hyprctl/pgrep bash-call clusters
 * (~175 bash calls per 3 days, each returning multi-KB raw output) with
 * ONE tool call per check, hard-bounded output.
 *
 * Auto-detects the target kind:
 *   - systemd unit  (target ends in .service/.target/.timer/.socket/.path)
 *                     → is-active + last N journal lines + pgrep match count
 *   - process name  → pgrep -af (capped)
 *   - hyprctl       (hyprctl: true) → hyprctl <target> (capped)
 *
 * Output is always bounded: unit ≤ lines journal + 2 lines status,
 * proc ≤ 20 lines, hyprctl ≤ 40 lines / 4 KB. Long output never enters
 * the conversation.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argNumber, argText, clip, type HeaderPart, safeToolHeader } from "@tinoy/pi-ext-lib";
import { Type } from "typebox";

const JOURNAL_COLORS = "--no-pager";

function exec(
	cmd: string,
	args: string[],
	timeoutMs = 10_000,
): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(err, stdout, stderr) => {
				// A missing binary produces no stdout and no stderr, only an error message; without
				// it the refusal would name the command and then say nothing about why (R8).
				const spawnMessage = err && !stdout && !stderr ? `\n${(err as Error).message}` : "";
				resolve({
					code:
						err && typeof (err as { code?: number }).code === "number"
							? (err as { code: number }).code
							: err
								? 1
								: 0,
					out: `${stdout}${stderr ? "\n" + stderr : ""}${spawnMessage}`.trim(),
				});
			},
		);
	});
}

function cap(text: string, maxLines: number, maxBytes = 4096): string {
	const lines = text.split("\n");
	let out = lines.slice(0, maxLines).join("\n");
	if (lines.length > maxLines) out += `\n… (+${lines.length - maxLines} lines)`;
	if (out.length > maxBytes) out = out.slice(0, maxBytes) + `… (+${out.length - maxBytes}B)`;
	return out;
}

const UNIT_RE = /\.(service|target|timer|socket|path|scope)$/;

const probeTool = {
	name: "probe",
	label: "Probe",
	description:
		"Bounded status probe for a systemd unit, process, or hyprctl query. " +
		"Unit targets (.service/.timer/…) return is-active + last N journal lines + process match count in ONE call. " +
		"Process targets return capped `pgrep -af`. Use this instead of clustered bash systemctl/journalctl/pgrep calls.",
	parameters: Type.Object({
		target: Type.String({
			description:
				"Unit name (foo.service), process pattern (ags-shell), or hyprctl subcommand arguments (clients -j)",
		}),
		lines: Type.Optional(
			Type.Number({ description: "Journal lines for unit probes (default 10, max 40)" }),
		),
		hyprctl: Type.Optional(
			Type.Boolean({ description: "Treat target as a hyprctl subcommand (e.g. 'clients -j')" }),
		),
	}),

	// Header only (display): the probe target plus its non-default mode.
	renderCall(args: Record<string, unknown>, theme: Parameters<typeof safeToolHeader>[0]) {
		return safeToolHeader(theme, "probe", () => {
			const parts: HeaderPart[] = [
				["accent", ` ${clip(argText(args, "target") ?? "(no target)", 80)}`],
			];
			const extras: string[] = [];
			if ((args as { hyprctl?: unknown } | undefined)?.hyprctl === true) extras.push("hyprctl");
			const lines = argNumber(args, "lines");
			if (lines !== undefined) extras.push(`lines ${lines}`);
			if (extras.length) parts.push(["dim", ` (${extras.join(", ")})`]);
			return parts;
		});
	},

	async execute(
		_toolCallId: string,
		params: { target: string; lines?: number; hyprctl?: boolean },
	) {
		const { target } = params;
		const lines = Math.min(Math.max(params.lines ?? 10, 1), 40);

		if (params.hyprctl) {
			const args = target.split(/\s+/).filter(Boolean);
			const r = await exec("hyprctl", args);
			return {
				details: {},
				content: [
					{ type: "text" as const, text: `hyprctl ${target} (exit ${r.code}):\n${cap(r.out, 40)}` },
				],
			};
		}

		if (UNIT_RE.test(target)) {
			const unit = target;
			const [active, journal, procs] = await Promise.all([
				exec("systemctl", ["--user", "is-active", unit]),
				exec("journalctl", [
					"--user",
					"-u",
					unit,
					"-n",
					String(lines),
					JOURNAL_COLORS,
					"-o",
					"short-precise",
				]),
				exec("pgrep", ["-fc", unit.replace(/\.(service|target|timer|socket|path|scope)$/, "")]),
			]);
			const parts = [
				`${unit}: ${active.out || "unknown"} (exit ${active.code})`,
				`processes: ${procs.out || "0"}`,
				`last ${lines} journal lines:`,
				cap(journal.out || "(no entries)", lines),
			];
			return { details: {}, content: [{ type: "text" as const, text: parts.join("\n") }] };
		}

		const procs = await exec("pgrep", ["-af", target]);
		const out = procs.out || "(no matches)";
		return {
			details: {},
			content: [
				{
					type: "text" as const,
					text: `pgrep -af ${target} (exit ${procs.code}):\n${cap(out, 20)}`,
				},
			],
		};
	},
};

export default function (pi: ExtensionAPI): void {
	pi.registerTool(probeTool);
}
