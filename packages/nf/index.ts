/**
 * nf — Nerd Font glyph reference tool (tool-burn + vision aware).
 *
 * The dataset ships INSIDE this package (`data/nf.json`, resolved relative to
 * this module), so the tool works for a fresh install with no setup: a
 * consumer that keeps a glyph table elsewhere is not a stranger with a broken
 * tool. A missing or malformed dataset is a refusal naming the path it looked
 * at and the fix, never a load failure.
 *
 * The 296 KB / 10,995-glyph table is for this tool alone: an app bundle keeps
 * glyphs as literal escapes plus name comments ("\ue73c" // dev-python) rather
 * than importing the dataset.
 *
 * Actions:
 *   search <kw>        name rows from the dataset (names are the only key; no tags/categories upstream).
 *   sheet <code|name>..PIL contact sheet w/ in-pixel labels. VISION-GATED — text-only fallback for
 *                      non-vision models (names+codes listed, "switch to a vision model" hint).
 *   audit [dir]        scan .ts/.tsx for \uXXXX escapes, validate against the dataset, flag PUA
 *                      codepoints (0xE000–0xF8FF) that are NOT assigned (catches f3e2-class dead glyphs).
 *
 * Capabilities are probed at CALL time: python3 + PIL and the JetBrainsMono Nerd
 * Font file are needed by the `sheet` action only, and `search`/`audit` work
 * without either.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argText, clip, type HeaderPart, hookLog, safeToolHeader } from "@tinoy/pi-ext-lib";
import { Type } from "typebox";

const FONT = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf";
const TOOL_NAME = "nf";
/** Vision models this release ships with: the ids verified to read images. */
const DEFAULT_VISION_MODEL_IDS = ["deepseek-flash", "glm-5.3-flash"];
/** Operator setting: comma- or space-separated model ids appended to the defaults. */
const VISION_MODELS_SETTING = "PI_VISION_MODELS";
const SEARCH_LIMIT = 40;
const SHEET_MAX_CELLS = 48;
const AUDIT_SKIP_DIRS = new Set(["node_modules", "@girs", "dist", ".git", "build", "target"]);

/** The dataset beside this module — shipped in the package, never a machine path. */
function datasetPath(): string {
	return fileURLToPath(new URL("./data/nf.json", import.meta.url));
}

let isVision = false;
let cache: Record<string, string> | null = null;

/** A capability that is absent at call time: prose for the model, `ok:false` for the details. */
function refusal(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: false } };
}

function name2code(n: string): string | undefined {
	return cache?.[n?.trim()] ? cache[n.trim()] : undefined;
}
function assignedSet(): Set<string> {
	const set = new Set<string>();
	for (const c of Object.values(cache ?? {})) set.add(c.toLowerCase());
	return set;
}

/** The configured vision list: the shipped defaults plus the setting. */
function visionModelIds(): string[] {
	const configured = process.env[VISION_MODELS_SETTING] ?? "";
	const extra = configured.split(/[,\s]+/).filter(Boolean);
	return [...new Set([...DEFAULT_VISION_MODEL_IDS, ...extra])];
}

function isVisionModel(model: { provider: string; id: string } | undefined): boolean {
	if (!model) return false;
	return visionModelIds().some(
		(id) =>
			model.id === id || model.id.startsWith(`${id}-`) || `${model.provider}/${model.id}` === id,
	);
}

function escapeCode(raw: string): string {
	return raw
		.replace(/^\\u\{?/, "")
		.replace(/\}$/, "")
		.replace(/^\\u/, "")
		.toLowerCase();
}

/** Is this codepoint inside a Nerd Font PUA plane (BMP, plane 15 or plane 16)? */
function nfPuaRange(hex: string): boolean {
	if (!/^[0-9a-f]{4,6}$/.test(hex)) return false;
	const cp = parseInt(hex, 16);
	return (
		(cp >= 0xe000 && cp <= 0xf8ff) || // BMP PUA — the older NF icons
		(cp >= 0xf0000 && cp <= 0xffffd) || // plane 15 PUA — MDI (Material Design Icons)
		(cp >= 0x100000 && cp <= 0x10fffd) // plane 16 PUA
	);
}

// ---- subprocess (python for PIL sheet) ----
function runPy(script: string, args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const child = spawn("python3", [script, ...args], { env: process.env });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code: code ?? 1, out }));
		child.on("error", (e) => resolve({ code: 127, out: String(e) }));
	});
}

const SHEET_PY = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
inp, out, font_path = sys.argv[1], sys.argv[2], sys.argv[3]
items = json.load(open(inp))
CELL_W, CELL_H = 200, 172
n = len(items)
cols = max(1, int(n ** 0.5))
while cols * cols < n: cols += 1
rows = (n + cols - 1) // cols
glyph_font = ImageFont.truetype(font_path, 56)
code_font = ImageFont.truetype(font_path, 14)
name_font = ImageFont.truetype(font_path, 13)
img = Image.new("RGB", (cols * CELL_W, rows * CELL_H), (24, 24, 28))
d = ImageDraw.Draw(img)
for i, it in enumerate(items):
    r, c = divmod(i, cols)
    x, y = c * CELL_W, r * CELL_H
    g = chr(int(it["code"], 16))
    d.text((x + CELL_W // 2, y + 6), g, font=glyph_font, fill=(205, 205, 215), anchor="ma")
    d.text((x + CELL_W // 2, y + CELL_H - 54), it["code"], font=code_font, fill=(150, 150, 170), anchor="ma")
    d.text((x + CELL_W // 2, y + CELL_H - 28), it.get("name", ""), font=name_font, fill=(90, 150, 240), anchor="ma")
img.save(out)
`;

type Refusal = ReturnType<typeof refusal>;

/** The dataset, or a refusal naming the path it was looked for at. */
function loadDataset(): Record<string, string> | Refusal {
	if (cache) return cache;
	const path = datasetPath();
	if (!existsSync(path)) {
		return refusal(
			`${TOOL_NAME}: unavailable — the glyph dataset is not at ${path}. Reinstall this package (\`pi install npm:@tinoy/pi-nf\`); the dataset ships inside it.`,
		);
	}
	let parsed: { glyphs?: Record<string, string> };
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return refusal(
			`${TOOL_NAME}: unavailable — the glyph dataset at ${path} could not be read as JSON (${error instanceof Error ? error.message : String(error)}). Reinstall this package.`,
		);
	}
	if (!parsed.glyphs) {
		return refusal(
			`${TOOL_NAME}: unavailable — the glyph dataset at ${path} has no glyph table. Reinstall this package.`,
		);
	}
	cache = parsed.glyphs;
	return cache;
}

function isRefusal(value: Record<string, string> | Refusal): value is Refusal {
	return "details" in value;
}

// ---- search ----
async function doSearch(
	kw: string,
): Promise<Refusal | { content: { type: "text"; text: string }[] }> {
	const loaded = loadDataset();
	if (isRefusal(loaded)) return loaded;
	const g = loaded;
	const names = Object.keys(g);
	const q = kw.trim().toLowerCase();
	if (!q)
		return { content: [{ type: "text", text: "search: pass a keyword, e.g. `nf search python`" }] };
	// substring on names; prefer exact-prefix matches first
	const sub = names.filter((n) => n.toLowerCase().includes(q));
	const pref = names.filter((n) => n.toLowerCase().startsWith(q));
	const uniq = [...new Set([...pref, ...sub])].slice(0, SEARCH_LIMIT);
	const lines = uniq.map((n) => `${n}\t\\u${g[n]}\tU+${g[n].toUpperCase()}`);
	const text = `${uniq.length} match(es) for "${q}" (of ${names.length} glyphs):\n${lines.join("\n")}`;
	const suffix = sub.length > SEARCH_LIMIT ? `\n… +${sub.length - SEARCH_LIMIT} more` : "";
	return { content: [{ type: "text", text: text + suffix }] };
}

// ---- sheet ----
async function doSheet(tokens: string[]): Promise<Refusal | { content: unknown[] }> {
	const loaded = loadDataset();
	if (isRefusal(loaded)) return loaded;
	const set = assignedSet();
	const items: { code: string; name: string }[] = [];
	const unknown: string[] = [];
	for (const t of tokens) {
		const raw = t.trim();
		if (!raw) continue;
		// name -> code
		const byName = name2code(raw);
		if (byName) {
			items.push({ code: byName, name: raw });
			continue;
		}
		// code (with or without \u / U+ / braces)
		const hex = escapeCode(raw);
		if (/^[0-9a-f]{1,6}$/.test(hex) && set.has(hex.toLowerCase())) {
			items.push({ code: hex, name: "" });
			continue;
		}
		unknown.push(raw);
	}
	if (!items.length) {
		return {
			content: [
				{
					type: "text" as const,
					text: `sheet: none of the given tokens resolved to glyphs. unknown: ${unknown.join(", ")}`,
				},
			],
		};
	}
	if (!isVision) {
		const lines = items.map(
			(it) => `${it.name ? it.name : "?"}\t\\u${it.code}\tU+${it.code.toUpperCase()}`,
		);
		const text = `VISION model required to view the contact sheet. Switch to a vision model for the image; here is the text:\n${lines.join("\n")}`;
		const suffix = unknown.length ? `\nunknown: ${unknown.join(", ")}` : "";
		return { content: [{ type: "text" as const, text: text + suffix }] };
	}
	const used = items.slice(0, SHEET_MAX_CELLS);
	const inp = join(tmpdir(), "nf-sheet-in.json");
	const py = join(tmpdir(), "nf-sheet-gen.py");
	const outPng = join(tmpdir(), `nf-sheet-${Date.now()}.png`);
	writeFileSync(inp, JSON.stringify(used));
	writeFileSync(py, SHEET_PY);
	const run = await runPy(py, [inp, outPng, FONT]);
	if (run.code !== 0 || !existsSync(outPng)) {
		const detail = run.out.trim().split("\n").slice(-1)[0] || "no output";
		const missingPil = /No module named|ModuleNotFoundError/i.test(run.out);
		return refusal(
			`${TOOL_NAME}: unavailable — the contact sheet needs python3 with Pillow (PIL) and the Nerd Font file at ${FONT}. ${
				missingPil
					? "Pillow is missing: install it (`python3 -m pip install --user pillow`)."
					: run.code === 127
						? "python3 is missing: install it (`apt install python3` / `pacman -S python`)."
						: `Renderer failed: ${detail}`
			}`,
		);
	}
	const data = readFileSync(outPng);
	let text = `nf sheet: ${used.length} glyph(s) → ${outPng}`;
	if (unknown.length) text += `\nunknown/ignored: ${unknown.join(", ")}`;
	if (items.length > SHEET_MAX_CELLS)
		text += `\n(+${items.length - SHEET_MAX_CELLS} more not rendered)`;
	return {
		content: [
			{ type: "image" as const, data: data.toString("base64"), mimeType: "image/png" },
			{ type: "text" as const, text },
		],
	};
}

// ---- audit ----
function walk(dir: string, out: string[] = []): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (AUDIT_SKIP_DIRS.has(e)) continue;
		if (e.startsWith(".")) continue;
		const p = join(dir, e);
		let st: { isDirectory: () => boolean; isFile: () => boolean };
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(p, out);
		else if (st.isFile() && (e.endsWith(".ts") || e.endsWith(".tsx"))) out.push(p);
	}
	return out;
}

async function doAudit(
	dir: string,
): Promise<Refusal | { content: { type: "text"; text: string }[] }> {
	const loaded = loadDataset();
	if (isRefusal(loaded)) return loaded;
	const set = assignedSet();
	if (!existsSync(dir)) {
		return refusal(`${TOOL_NAME}: unavailable — ${dir} is not a directory to audit.`);
	}
	const files = walk(dir);
	// Three shapes: braced (\u{f024b}, any length), plain 4-hex (\ue73c), and the
	// MALFORMED unbraced 5-6 hex digit form (\uf024b) — JS consumes 4 hex and
	// renders the remainder as literal text, so the row shows one wrong glyph
	// plus a stray character. That shape is the one this audit exists to catch.
	const bracedRe = /\\u\{([0-9a-fA-F]{2,6})\}/g;
	const plainRe = /\\u([0-9a-fA-F]{4})(?![0-9a-fA-F])/g;
	const malformedRe = /\\u([0-9a-fA-F]{5,6})(?![0-9a-fA-F])/g;
	const flags: string[] = [];
	let totalEscapes = 0;
	let totalFiles = 0;
	const scan = (content: string, re: RegExp, onMatch: (m: RegExpExecArray) => void) => {
		re.lastIndex = 0;
		let m = re.exec(content);
		while (m !== null) {
			onMatch(m);
			m = re.exec(content);
		}
	};
	const checkCode = (f: string, content: string, index: number, hex: string, bare: string) => {
		if (!nfPuaRange(hex)) return;
		totalEscapes++;
		if (!set.has(hex)) {
			const lineNo = content.slice(0, index).split("\n").length;
			flags.push(
				`${f}:${lineNo}  ${bare}  U+${hex.toUpperCase()}  UNASSIGNED PUA (dead/removed NF glyph)`,
			);
		}
	};
	for (const f of files) {
		totalFiles++;
		let content: string;
		try {
			content = readFileSync(f, "utf8");
		} catch {
			continue;
		}
		// braced + plain, matched by index so a malformed run is not double-counted
		const malformedAt = new Set<number>();
		scan(content, malformedRe, (m) => {
			malformedAt.add(m.index);
			const hex = m[1].toLowerCase();
			const lit = m[1].slice(4);
			const lineNo = content.slice(0, m.index).split("\n").length;
			flags.push(
				`${f}:${lineNo}  ${m[0]}  MALFORMED unbraced ${m[1].length}-hex escape — parses as U+${m[1].slice(0, 4).toUpperCase()} + literal "${lit}"` +
					(nfPuaRange(hex) && !set.has(hex)
						? " (and the intended codepoint is UNASSIGNED)"
						: ` (intended: U+${hex.toUpperCase()}, write "\\u{${hex}}")`),
			);
		});
		scan(content, bracedRe, (m) => checkCode(f, content, m.index, m[1].toLowerCase(), m[0]));
		scan(content, plainRe, (m) => {
			if (malformedAt.has(m.index)) return; // counted by malformedRe
			checkCode(f, content, m.index, m[1].toLowerCase(), m[0]);
		});
	}
	const summary =
		`audit ${dir}: ${totalFiles} .ts/.tsx file(s), ${totalEscapes} escape(s) resolved in NF PUA space, ${flags.length} flag(s) (unassigned PUA / malformed escape).` +
		(flags.length ? `\n\n${flags.slice(0, 60).join("\n")}` : "");
	return { content: [{ type: "text", text: summary }] };
}

const nfTool = {
	name: TOOL_NAME,
	label: "Nerd Font",
	description:
		"Nerd Font glyph reference. Dataset (10,995 glyphs, name→codepoint) ships with this package. Actions: `search <kw>` (name rows), `sheet <code|name>...` (PIL contact sheet image, vision-gated), `audit [dir]` (scan .ts/.tsx \\uXXXX escapes, flag unassigned PUA codepoints).",
	promptSnippet: "Look up / verify / audit Nerd Font glyph codepoints",
	promptGuidelines: [
		"Use `nf search <kw>` to find a glyph name, `nf sheet <code|name>` for a visual contact sheet (needs this session to be vision-capable), `nf audit` to catch unassigned / dead-range glyph escapes before a reboot.",
	],
	parameters: Type.Object({
		action: Type.Union([Type.Literal("search"), Type.Literal("sheet"), Type.Literal("audit")]),
		keyword: Type.Optional(
			Type.String({ description: "search: substring to match against glyph names" }),
		),
		codes: Type.Optional(
			Type.Union([Type.Array(Type.String()), Type.String()], {
				description: 'sheet: glyph codepoint(s) or name(s), e.g. ["e73c","dev-python"]',
			}),
		),
		dir: Type.Optional(
			Type.String({ description: "audit: directory to scan (default: current working dir)" }),
		),
	}),

	// Header only (display): the action plus the argument that identifies it.
	renderCall(args: Record<string, unknown>, theme: Parameters<typeof safeToolHeader>[0]) {
		return safeToolHeader(theme, "nf", () => {
			const action = argText(args, "action") ?? "action";
			const parts: HeaderPart[] = [["accent", ` ${action}`]];
			if (action === "search") {
				const keyword = argText(args, "keyword");
				if (keyword) parts.push(["accent", ` ${clip(keyword, 60)}`]);
			} else if (action === "sheet") {
				const raw = (args as { codes?: unknown } | undefined)?.codes;
				const list = Array.isArray(raw)
					? raw.filter((code): code is string => typeof code === "string")
					: typeof raw === "string"
						? raw.split(/[,\s]+/).filter(Boolean)
						: [];
				if (list.length) {
					const shown = list.slice(0, 4).join(" ");
					parts.push([
						"accent",
						` ${clip(shown, 60)}${list.length > 4 ? ` +${list.length - 4}` : ""}`,
					]);
				}
			} else if (action === "audit") {
				const dir = argText(args, "dir");
				if (dir) parts.push(["dim", ` ${clip(dir, 60)}`]);
			}
			return parts;
		});
	},

	async execute(
		_toolCallId: string,
		params: { action: string; keyword?: string; codes?: string[] | string; dir?: string },
	) {
		const act = params.action;
		if (act === "search") return doSearch(params.keyword ?? "");
		if (act === "sheet") {
			const raw = params.codes ?? [];
			const tokens = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
			return doSheet(tokens);
		}
		if (act === "audit") return doAudit(params.dir ?? process.cwd());
		return refusal(`${TOOL_NAME}: unavailable — unknown action "${act}" (search | sheet | audit).`);
	},
};

function register(pi: ExtensionAPI): void {
	pi.registerTool(nfTool as never);

	// Vision gate for the sheet action only: tool is active everywhere (search/audit are text-only),
	// but the sheet returns an image, so non-vision models get a text fallback instead.
	const sync = (model: { provider: string; id: string } | undefined) => {
		isVision = isVisionModel(model);
	};
	pi.on("session_start", (_e, ctx) => sync(ctx.model));
	pi.on("model_select", (_e, ctx) => sync(ctx.model));
}

export default function (pi: ExtensionAPI): void {
	try {
		register(pi);
	} catch (error) {
		hookLog("nf", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
