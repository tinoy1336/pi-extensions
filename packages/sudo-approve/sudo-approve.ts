/**
 * sudo-approve: user-approved root command execution for pi.
 *
 * Registers the sudo_approve tool. The agent passes one or more commands with
 * per-command and/or collective justifications. Approval flow, in order:
 *
 * 1. PRIMARY — ags/promptd (io.Astal.promptd): one centered window shows the
 *    command list + justifications + a masked password field. The password is
 *    validated INSIDE promptd (`sudo -S -v`, window stays open on wrong
 *    attempts, red text until edited, max 3); on success promptd writes it to
 *    a 0600 temp file and returns only the path; the commands run via
 *    `sudo -A` with SUDO_ASKPASS pointing at a cat-that-file script, and the
 *    temp file is deleted afterwards. The password never enters pi.
 *
 * There is NO timeout on the promptd request — the window stays open until
 * the user answers (the user's "indef" choice; a timeout is what caused the
 * dreaded double-prompt when it fired while the window was legitimately up).
 * FALLBACK (2): when the promptd INVOCATION fails with an error (service
 * down / unreachable / broken reply), the TUI confirm dialog + the yad
 * askpass bridge run instead. Fallback triggers on errors ONLY.
 *
 * Every attempt (approve/deny/result) is appended as JSONL to
 * ~/.local/share/sudo-approve/audit.log.
 *
 * Commands run non-interactively: commands that normally prompt (e.g. pacman)
 * must carry their own flags (e.g. --noconfirm) in the approved command line.
 */

import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argText, clip, type HeaderPart, safeToolHeader } from "@tinoy/pi-ext-lib";
import { type Static, Type } from "typebox";

const ASKPASS_BRIDGE = join(homedir(), ".local/bin/sudo-approve-askpass");
const ASKPASS_CAT = join(homedir(), ".local/bin/sudo-approve-password-cat");
const AUDIT_DIR = join(homedir(), ".local/share/sudo-approve");
const AUDIT_LOG = join(AUDIT_DIR, "audit.log");
const MAX_COMMANDS = 20;
const MAX_OUTPUT_PER_COMMAND = 20000; // chars returned to the model per command
const MAX_TOTAL_OUTPUT = 40000; // chars returned to the model for the whole batch

const sudoApproveSchema = Type.Object({
	commands: Type.Array(
		Type.Object({
			command: Type.String({
				description: "Exact shell command line to run as root",
			}),
			justification: Type.Optional(Type.String({ description: "Why this command is needed" })),
		}),
		{
			minItems: 1,
			maxItems: MAX_COMMANDS,
			description: "Commands to run as root",
		},
	),
	justification: Type.Optional(
		Type.String({
			description: "Collective justification for the whole batch",
		}),
	),
});

export type SudoApproveInput = Static<typeof sudoApproveSchema>;

interface CommandSpec {
	command: string;
	justification?: string;
}

function audit(entry: Record<string, unknown>): void {
	try {
		mkdirSync(AUDIT_DIR, { recursive: true });
		appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
	} catch {
		// Logging must never break the tool.
	}
}

/** The checkout root — the same rule the tree's own common/path/tree-root.ts uses:
 *  TINSHELL_HOME when a launcher exports it, else the dev checkout. */
function checkoutRoot(): string {
	return process.env.TINSHELL_HOME || join(homedir(), "dev", "tinshell");
}

/** The request router's location — RESOLVED, never hard-coded. It routes
 *  "promptd …" to the live instance (shell first, dev island fallback) and
 *  cold-starts when neither is up. SUDO_APPROVE_ROUTE wins (tests, a
 *  non-standard install); otherwise it is derived from the checkout root,
 *  because a literal path is a promise about where the tree sits. */
function resolveRouterPath(): string {
	return process.env.SUDO_APPROVE_ROUTE || join(checkoutRoot(), "common/shell/tinshell-route.sh");
}

const AGS_ROUTE = resolveRouterPath();

/** A missing router is an ENVIRONMENT fault, not an approval decision. Name the
 *  path and the variables that fix it, and never let the call site fall through
 *  to the confirm dialog: a UI-less session answers that with an empty reason,
 *  which reads to the model (and to the operator) as a human denial. */
function routerMissingRefusal(): string | null {
	if (existsSync(AGS_ROUTE)) return null;
	return (
		`error: router-missing: ${AGS_ROUTE} does not exist, so the approval window is unreachable. ` +
		"Set SUDO_APPROVE_ROUTE to the router path, or TINSHELL_HOME to the checkout root. " +
		"No approval was requested and none was denied."
	);
}

/** Instances that may host promptd, route-map.conf order (production first).
 *  SUDO_APPROVE_INSTANCES overrides (tests only — never probe real shells). */
function promptdInstances(): string[] {
	if (process.env.SUDO_APPROVE_INSTANCES) {
		return process.env.SUDO_APPROVE_INSTANCES.split(",").filter(Boolean);
	}
	try {
		const map = readFileSync(join(checkoutRoot(), "common/shell/route-map.conf"), "utf8");
		for (const line of map.split("\n")) {
			const m = /^promptd=([\w,-]+)\s*$/.exec(line);
			if (m) return m[1].split(",").filter(Boolean);
		}
	} catch {
		// Missing map → fall back to the documented default order.
	}
	return ["shell", "promptd"];
}

/** Bus-name ownership check — `busctl --user status <name>` exits 0 iff
 *  owned. Bounded at 2s; a vanished name is the fast death signal. */
function busOwned(name: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v: boolean): void => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const timer = setTimeout(() => finish(false), 2000);
		execFile("busctl", ["--user", "status", name], (err) => {
			clearTimeout(timer);
			finish(!err);
		});
	});
}

/** Servable probe — the same empty-request check ags-route.sh uses: a
 *  healthy instance answers instantly with its command namespaces. Catches
 *  the alive-but-frozen case (bus owned, mainloop wedged — 2026-08-31 OOM
 *  storm) that bus ownership alone cannot see. */
function probeServable(instances: string[], timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		let remaining = instances.length;
		const finish = (v: boolean): void => {
			if (!done) {
				done = true;
				resolve(v);
			}
		};
		if (remaining === 0) {
			finish(false);
			return;
		}
		for (const inst of instances) {
			const child = execFile("ags", ["-i", inst, "request", ""], (err, stdout) => {
				if (done) return;
				if (!err && stdout.split(/\s+/).includes("promptd")) {
					finish(true);
				} else if (--remaining === 0) {
					finish(false);
				}
			});
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			}, timeoutMs);
			child.on("close", () => clearTimeout(timer));
		}
	});
}

/** Probe cadence: a round every 3s; 3 consecutive failed rounds (after the
 *  channel was once servable) declare the channel dead. ~9-12s from a live
 *  host wedging to a hard reject — never an unconditional timeout. */
const PROBE_INTERVAL_MS = 3000;
const PROBE_TIMEOUT_MS = 2500;
const MAX_FAILED_ROUNDS = 3;

/** Run `ags-route promptd <cmd>`; resolves with stdout ("" on failure).
 *
 *  NO timeout while the host is alive and answering — the prompt window
 *  stays open until the user answers (the user's "indef" choice).
 *
 *  MID-WAIT DEATH DETECTION (2026-08-31): while waiting, bus ownership of
 *  a hosting instance + the servable probe run every PROBE_INTERVAL_MS.
 *  If the owning bus name vanishes, or the probe fails MAX_FAILED_ROUNDS
 *  consecutive times after the channel was once servable, the channel is
 *  declared dead: the child is killed and the reply is "error:
 *  channel-dead" — the call site hard-rejects instead of falling back (a
 *  frozen host also can't serve the fallback path, and an agent must
 *  re-issue rather than hang). A child exit with no reply after the
 *  channel was servable resolves "error: channel-dead" too; a child error
 *  while never servable keeps the invocation-failure semantics ("") that
 *  trigger the TUI fallback. On agent abort the child is killed and the
 *  reply is "error: aborted". */
export function promptdRequest(cmd: string, signal: AbortSignal | undefined): Promise<string> {
	return new Promise((resolve) => {
		const missing = routerMissingRefusal();
		if (missing) {
			audit({
				decision: "router-missing",
				path: AGS_ROUTE,
				hint: "SUDO_APPROVE_ROUTE|TINSHELL_HOME",
			});
			resolve(missing);
			return;
		}
		const instances = promptdInstances();
		let settled = false;
		let poll: ReturnType<typeof setInterval> | null = null;
		let roundBusy = false;
		let failedRounds = 0;
		let everServable = false;

		const finish = (value: string): void => {
			if (settled) return;
			settled = true;
			if (poll) clearInterval(poll);
			resolve(value);
		};

		const child = execFile(AGS_ROUTE, ["promptd", cmd], { signal }, (err, stdout, stderr) => {
			if (settled) return;
			if (err) {
				audit({
					decision: "promptd-call-failed",
					error: String(err.message ?? err).slice(0, 500),
					stderr: String(stderr ?? "").slice(0, 500),
				});
				finish(signal?.aborted ? "error: aborted" : everServable ? "error: channel-dead" : "");
			} else {
				finish(stdout.trim());
			}
		});

		const declareDead = (): void => {
			if (settled) return;
			audit({ decision: "promptd-channel-dead" });
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
			finish("error: channel-dead");
		};

		poll = setInterval(() => {
			if (signal?.aborted || roundBusy || settled) return;
			roundBusy = true;
			void (async () => {
				try {
					let owned = false;
					for (const inst of instances) {
						if (await busOwned(`io.Astal.${inst}`)) {
							owned = true;
							break;
						}
					}
					if (!owned) {
						declareDead();
						return;
					}
					const servable = await probeServable(instances, PROBE_TIMEOUT_MS);
					if (settled) return;
					if (servable) {
						everServable = true;
						failedRounds = 0;
					} else if (everServable && ++failedRounds >= MAX_FAILED_ROUNDS) {
						declareDead();
					}
				} finally {
					roundBusy = false;
				}
			})();
		}, PROBE_INTERVAL_MS);
	});
}

/** Non-elevating probe of THIS process's sudo credential slot — the same
 *  slot `sudo -n` will actually use when the batch runs (same parent PID →
 *  same timestamp record). Per-terminal/per-parent-PID timestamps make
 *  promptd's own probe meaningless for the commands that run here — it
 *  warms a different slot. `-n` never prompts, so the 4s bound is paranoia. */
function sudoCacheValidHere(signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, 4000);
		execFile("sudo", ["-n", "-v"], { signal }, (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(!err);
		});
	});
}

function spawnSudo(
	argv: string[],
	askpass: string | null,
	passwordFile: string | null,
	signal: AbortSignal | undefined,
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("sudo", argv, {
			env: {
				...process.env,
				...(askpass ? { SUDO_ASKPASS: askpass } : {}),
				...(passwordFile ? { SUDO_APPROVE_PASSWORD_FILE: passwordFile } : {}),
			},
		});
		let out = "";
		const onData = (d: Buffer | string): void => {
			if (out.length < MAX_OUTPUT_PER_COMMAND) {
				out += String(d);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		const onAbort = (): void => {
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: -1, output: `failed to spawn sudo: ${err.message}` });
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, output: out });
		});
	});
}

function runSudo(
	command: string,
	askpass: string | null,
	passwordFile: string | null,
	signal: AbortSignal | undefined,
): Promise<{ code: number | null; output: string }> {
	// askpass set → password path (promptd temp file / yad bridge).
	// askpass null → cache path (`sudo -n` — the promptd window already
	// confirmed the timestamp; each invocation refreshes it; a mid-batch
	// expiry past 5 min fails visibly instead of hanging).
	const argv = askpass ? ["-A", "bash", "-c", command] : ["-n", "bash", "-c", command];
	return spawnSudo(argv, askpass, passwordFile, signal);
}

/** Desktop notification on final auth failure (user may be away). */
function notifyAuthFailed(attempt: number): void {
	try {
		spawn("notify-send", [
			"--urgency=critical",
			"--icon=dialog-error",
			"sudo authentication failed",
			`${attempt} incorrect password attempts — the approved batch was aborted.`,
		]);
	} catch {
		// Notifications must never break the tool.
	}
}

/** Run the whole batch; returns the summary text (also appended to audit). */
async function runBatch(
	commands: CommandSpec[],
	askpass: string | null,
	passwordFile: string | null,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<{ text: string; results: unknown[] }> {
	const results: Array<{
		command: string;
		exitCode: number | null;
		output: string;
		truncated: boolean;
	}> = [];
	let totalOutput = 0;
	let aborted = false;

	for (let i = 0; i < commands.length; i++) {
		const command = commands[i].command;
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${i + 1}/${commands.length}: ${command}`,
				},
			],
			details: undefined,
		});
		let { code, output } = await runSudo(command, askpass, passwordFile, signal);
		// CACHE-MODE FALLBACK (2026-08): sudo timestamps are PER-TTY. promptd's
		// cache probe warms the no-tty slot, but this process's sudo inherits
		// the agent session's pty, so `sudo -n` can miss the timestamp and fail
		// instantly with "a password is required" right after a cache-mode
		// approval. Retry ONCE via the askpass bridge (promptd password window);
		// the retry also warms this slot, so the rest of the batch keeps running
		// `sudo -n` without further prompts. Other failures pass through as-is.
		if (askpass === null && code !== 0 && /a password is required/i.test(output)) {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: "Cache miss (per-tty sudo timestamp) — requesting password",
					},
				],
				details: undefined,
			});
			audit({ decision: "cache-miss-retry", command });
			const r = await runSudo(command, ASKPASS_BRIDGE, null, signal);
			code = r.code;
			output = r.output;
		}
		results.push({
			command,
			exitCode: code,
			output,
			truncated: output.length >= MAX_OUTPUT_PER_COMMAND,
		});
		totalOutput += output.length;
		audit({ decision: "result", command, exitCode: code });
		if (signal?.aborted) {
			aborted = true;
			break;
		}
	}

	const lines: string[] = [];
	if (aborted) {
		lines.push("Aborted mid-batch.");
	}
	let emitted = 0;
	for (const r of results) {
		const status = r.exitCode === 0 ? "ok" : `FAILED (exit ${r.exitCode})`;
		const line = `${status} - ${r.command}`;
		lines.push(line);
		if (r.output.length > 0 && emitted < MAX_TOTAL_OUTPUT) {
			const room = MAX_TOTAL_OUTPUT - emitted;
			const chunk = r.output.slice(0, room);
			lines.push(chunk);
			emitted += chunk.length;
			if (chunk.length < r.output.length) {
				lines.push("[output truncated]");
				break;
			}
		}
	}
	if (emitted >= MAX_TOTAL_OUTPUT) {
		lines.push("[total output truncated]");
	}

	return { text: lines.join("\n"), results };
}

function buildRequestText(commands: CommandSpec[], collective?: string): string {
	const lines: string[] = [];
	if (collective) {
		lines.push(collective);
		lines.push("");
	}
	commands.forEach((c, i) => {
		lines.push(`${i + 1}. ${c.command}`);
		if (c.justification) {
			lines.push(`   Why: ${c.justification}`);
		}
	});
	return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sudo_approve",
		label: "Sudo Approve",
		description:
			"Run one or more commands with root privileges after the user approves them. " +
			"Every command and its justification is shown to the user in a single approval " +
			"window (ags/promptd); nothing runs without explicit user approval, and denial " +
			"returns the user's reason (if any) to the model. The user's sudo password is " +
			"entered by the user in a masked field and never passes through pi: it is " +
			"validated inside promptd (wrong password = window stays open with red text, " +
			"max 3 attempts, then a critical desktop notification + abort) and on success " +
			"written to a 0600 temp file consumed directly by sudo. Commands run " +
			"sequentially and non-interactively: commands that normally prompt (e.g. pacman) " +
			"must carry their own flags (e.g. --noconfirm) in the command line. Output is " +
			`truncated to ${MAX_OUTPUT_PER_COMMAND} chars per command and ${MAX_TOTAL_OUTPUT} chars total. ` +
			"Use this tool for any privileged operation instead of attempting sudo directly.",
		promptSnippet: "Run approved commands as root after explicit user approval",
		promptGuidelines: [
			"Use sudo_approve when a task requires root privileges; never attempt sudo, pkexec, or other privilege escalation directly.",
			"Provide a justification for every sudo_approve command so the user can make an informed approval decision.",
			"Batch related privileged commands into a single sudo_approve call with a collective justification.",
			"Make sudo_approve commands non-interactive (e.g. pacman -Syu --noconfirm) because they run without a terminal.",
		],
		parameters: sudoApproveSchema,
		// Header only (display): how many root commands, and why they are needed.
		renderCall(args, theme) {
			return safeToolHeader(theme, "sudo_approve", () => {
				const commands = (args as { commands?: unknown } | undefined)?.commands;
				const list = Array.isArray(commands) ? commands : [];
				const first = list[0] as { command?: unknown; justification?: unknown } | undefined;
				const why =
					argText(args, "justification") ??
					argText(first, "justification") ??
					argText(first, "command");
				const parts: HeaderPart[] = [
					["accent", ` ${list.length} command${list.length === 1 ? "" : "s"}`],
				];
				if (why) parts.push(["muted", " — "], ["dim", clip(why, 90)]);
				return parts;
			});
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const commands = params.commands as CommandSpec[];
			const collective = params.justification;

			// ── PRIMARY: promptd approve window ────────────────────────────────
			// Probe THIS process's sudo slot (the slot `sudo -n` uses when the
			// batch runs) and hand the real answer to promptd, so the "cached"
			// message reflects the cache that actually matters.
			const cacheValid = await sudoCacheValidHere(signal);
			const payload = Buffer.from(
				JSON.stringify({ commands, justification: collective, cacheValid }),
			).toString("base64");
			const reply = await promptdRequest(`approve ${payload}`, signal);
			if (reply === "error: aborted" || signal?.aborted) {
				return {
					content: [{ type: "text", text: "sudo_approve aborted." }],
					details: { decision: "aborted" },
				};
			}
			if (reply === "error: cancelled") {
				// User dismissed the promptd window — that IS the denial; do not
				// re-prompt in the TUI.
				audit({ decision: "deny", channel: "promptd", commands });
				return {
					content: [
						{
							type: "text",
							text: "User denied approval in the promptd window.",
						},
					],
					details: { decision: "deny", channel: "promptd" },
				};
			}
			if (reply.startsWith("error: router-missing")) {
				// Environment fault, not an approval decision: hard reject and NAME it.
				audit({ decision: "router-missing", reply, channel: "promptd", commands });
				return {
					content: [{ type: "text", text: reply }],
					details: { decision: "router-missing", channel: "promptd" },
				};
			}
			if (reply === "error: channel-dead") {
				// The approval window died mid-wait (host crash/restart). Hard
				// reject — no TUI fallback: a dead/frozen host can't serve one, and
				// silently re-asking in the terminal would bypass the desktop
				// approval flow. The model re-issues sudo_approve for a fresh window.
				audit({ decision: "channel-dead", channel: "promptd", commands });
				return {
					content: [
						{
							type: "text",
							text: "approval channel died (host crash/restart) — no approval granted; re-issue sudo_approve to open a fresh window",
						},
					],
					details: { decision: "channel-dead", channel: "promptd" },
				};
			}
			if (reply.startsWith("{") && reply.endsWith("}")) {
				try {
					const result = JSON.parse(reply) as
						| { decision: "approve"; passwordFile?: string }
						| { decision: "deny" }
						| { decision: "auth-failed"; error: string; attempts: number };
					if (result.decision === "approve") {
						audit({ decision: "approve", channel: "promptd", commands });
						const passwordFile = result.passwordFile ?? null;
						try {
							// Cache-mode approval (no passwordFile) runs with plain
							// `sudo -n`; password-mode uses the cat askpass. The credential
							// was validated inside promptd either way.
							const { text, results } = await runBatch(
								commands,
								passwordFile ? ASKPASS_CAT : null,
								passwordFile,
								signal,
								onUpdate,
							);
							return {
								content: [{ type: "text", text }],
								details: { decision: "approve", channel: "promptd", results },
							};
						} finally {
							if (passwordFile) {
								try {
									unlinkSync(passwordFile);
								} catch {
									// Temp file already gone — fine.
								}
							}
						}
					}
					if (result.decision === "auth-failed") {
						audit({
							decision: "auth-failed",
							channel: "promptd",
							attempts: result.attempts,
							error: result.error.slice(0, 300),
						});
						notifyAuthFailed(result.attempts);
						return {
							content: [
								{
									type: "text",
									text: `sudo authentication failed after ${result.attempts} attempt(s): ${result.error}`,
								},
							],
							details: {
								decision: "auth-failed",
								channel: "promptd",
								error: result.error,
								attempts: result.attempts,
							},
						};
					}
					audit({ decision: "deny", channel: "promptd", commands });
					return {
						content: [
							{
								type: "text",
								text: "User denied approval in the promptd window.",
							},
						],
						details: { decision: "deny", channel: "promptd" },
					};
				} catch {
					// Malformed JSON — treat as a failed invocation below.
				}
			}

			// ── promptd invocation FAILED with an error (down/unreachable/broken)
			// — the legitimate fallback trigger. NO timeout anywhere: a live
			// promptd window waits as long as the user needs. ──
			// R8: the channel that is missing is named FIRST, ahead of the request it
			// is about to run through the fallback, because a terminal confirm that
			// says nothing about the missing window reads as the intended path.
			const windowMissing =
				reply === ""
					? `the AGS approval window is unavailable — ${AGS_ROUTE} answered nothing, so no promptd instance is reachable`
					: `the AGS approval window failed — ${reply.slice(0, 200)}`;
			audit({
				decision: "fallback-reason",
				reply: reply.slice(0, 500),
				commands,
			});

			const title = `Approve ${commands.length} command(s) as root?`;
			const body = `${windowMissing}\n\n${buildRequestText(commands, collective)}`;
			const approved = await ctx.ui.confirm(title, body);

			if (!approved) {
				const reason =
					(await ctx.ui.input("Approval denied - reason (optional)", "Press Enter to skip")) ?? "";
				audit({ decision: "deny", channel: "fallback", reason, commands });
				const text =
					reason.trim().length > 0
						? `${windowMissing}. User denied approval: ${reason}`
						: `${windowMissing}. User denied approval (no reason given).`;
				return {
					content: [{ type: "text", text }],
					details: { decision: "deny", channel: "fallback", reason, commands },
				};
			}

			audit({ decision: "approve", channel: "fallback", commands });
			const { text, results } = await runBatch(commands, ASKPASS_BRIDGE, null, signal, onUpdate);
			return {
				content: [{ type: "text", text }],
				details: { decision: "approve", channel: "fallback", results },
			};
		},
	});
}
