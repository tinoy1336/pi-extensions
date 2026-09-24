/**
 * image_read — vision-token-aware image ingestion.
 *
 * Returns a prepped image INLINE as tool-result content (no second read call):
 *   - downscales the long edge to `max` px (default 1024) unless 0 = pass-through
 *   - optional crop "WxH+X+Y" (tokens track area — crop beats resize)
 *   - auto format: huge opaque PNGs re-encoded to JPEG q85 (upload speed; tokens unchanged)
 *   - cached by content+args in $TMPDIR/pi-img-cache (repeat calls are instant)
 *   - returns a token estimate: pixels/784 (GLM-V 14px patches, 2x2 merge)
 *
 * Registered for every session and ACTIVE by default, so the gate only has to
 * NARROW: it removes the tool in sessions whose model cannot read images.
 * The vision list is the DEFAULT_VISION_MODEL_IDS set plus whatever the
 * `PI_VISION_MODELS` setting adds, so a session whose model is not in the
 * built-in list is one setting away from working instead of one release away.
 *
 * Capability: the `magick` binary is probed at CALL time, never at load — an
 * absent copy costs this one call and answers a refusal naming the binary.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	argNumber,
	argText,
	clip,
	type HeaderPart,
	hookLog,
	safeToolHeader,
} from "@tinoy/pi-ext-lib";
import { Type } from "typebox";

/** Vision models this release ships with: the ids verified to read images. */
const DEFAULT_VISION_MODEL_IDS = ["glm-5.3-flash", "deepseek-flash"];
/** Operator setting: comma- or space-separated model ids appended to the defaults,
 *  each either a bare model id (`my-model`) or `provider/model-id`. */
const VISION_MODELS_SETTING = "PI_VISION_MODELS";
const TOOL_NAME = "image_read";
const DEFAULT_MAX_PX = 1024;
const AUTO_JPEG_MIN_BYTES = 512 * 1024;
const JPEG_QUALITY = 85;

function expandHome(p: string): string {
	if (p.startsWith("~/")) return join(process.env.HOME ?? "", p.slice(2));
	return p;
}

function normalizePath(p: string): string {
	// built-in tools strip a leading "@"; some models include it
	return expandHome(p.startsWith("@") ? p.slice(1) : p);
}

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

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

/** One `magick` invocation, with an absent or failing binary reported as data. */
async function magick(
	pi: ExtensionAPI,
	args: string[],
	signal: AbortSignal | undefined,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const result = await pi.exec("magick", args, { signal });
		return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

/** A capability that is absent at call time: prose for the model, `ok:false` for the details. */
function refusal(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: false } };
}

const MAGICK_HINT =
	"ImageMagick is required for this tool — install the `magick` binary (Debian/Ubuntu: `apt install imagemagick`; Arch: `pacman -S imagemagick`) and retry.";

function register(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Image Read",
		description: `Read an image file with token-cost control. Downscales the long edge to max px (default ${DEFAULT_MAX_PX}) and returns the image directly — do NOT follow up with the read tool. Use crop ("WxH+X+Y") when only part of the image matters (tokens scale with pixel area). Set max=0 only for pixel-precise inspection (small text, exact colors) — full-res images cost ~5.4k tokens per 2048px. Returns original vs final dimensions, file sizes, and an estimated token count.`,
		promptSnippet:
			"Read images with automatic downscale/crop + token estimate (vision models only)",
		promptGuidelines: [
			"Use image_read instead of read for ALL image files — it downscales and reports the token cost. Default max=1024 is right for screenshots/UI checks; use crop for region-specific questions; max=0 only when pixel precision is required.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Image file path (png/jpg/webp/gif/bmp)" }),
			max: Type.Optional(
				Type.Number({
					description: `Long-edge cap in px. Default ${DEFAULT_MAX_PX}. 0 = full resolution (expensive).`,
				}),
			),
			crop: Type.Optional(
				Type.String({
					description: 'Crop before resizing, ImageMagick geometry e.g. "400x300+100+50"',
				}),
			),
			format: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("png"), Type.Literal("jpeg")], {
					description: "Output format; auto = jpeg q85 for big opaque pngs",
				}),
			),
		}),

		// Header only (display): the path plus the token-relevant knobs.
		renderCall(args, theme) {
			return safeToolHeader(theme, "image_read", () => {
				const extras: string[] = [];
				const crop = argText(args, "crop");
				if (crop) extras.push(`crop ${crop}`);
				const max = argNumber(args, "max");
				if (max !== undefined) extras.push(`max ${max}`);
				const format = argText(args, "format");
				if (format && format !== "auto") extras.push(format);
				const parts: HeaderPart[] = [
					["accent", ` ${clip(argText(args, "path") ?? "(no path)", 90)}`],
				];
				if (extras.length) parts.push(["dim", ` (${extras.join(", ")})`]);
				return parts;
			});
		},

		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
			const src = normalizePath(String(params.path ?? ""));
			if (!src) throw new Error("path is required");

			const st = await stat(src);
			if (!st.isFile()) throw new Error(`Not a file: ${src}`);

			const ext = src.slice(src.lastIndexOf(".")).toLowerCase();
			const mime = MIME[ext];
			if (!mime) throw new Error(`Unsupported image type: ${ext}`);

			const maxPx =
				params.max === undefined || params.max === null ? DEFAULT_MAX_PX : Number(params.max);
			const crop =
				typeof params.crop === "string" && params.crop.trim() ? params.crop.trim() : undefined;
			const format = params.format ?? "auto";

			if (crop && !/^\d+x\d+[+-]\d+[+-]\d+$/.test(crop)) {
				throw new Error(`Invalid crop geometry "${crop}" — expected WxH+X+Y`);
			}

			// dims + opacity in one identify call
			const probe = await magick(pi, ["identify", "-format", "%w %h %[opaque]", src], signal);
			if (!probe.ok) {
				const reason = probe.stderr.trim().split("\n")[0] || "the binary did not run";
				return refusal(
					`${TOOL_NAME}: unavailable — \`magick identify\` failed: ${reason}. ${MAGICK_HINT}`,
				);
			}
			const [wStr, hStr, opaque] = probe.stdout.trim().split(/\s+/);
			const w = Number(wStr);
			const h = Number(hStr);

			const longEdge = Math.max(w, h);
			const needResize = maxPx > 0 && longEdge > maxPx;
			const needCrop = !!crop;

			// auto format: big opaque png -> jpeg (upload speed only, tokens unchanged)
			let outMime = mime;
			let outExt = ext;
			if (
				format === "jpeg" ||
				(format === "auto" &&
					ext === ".png" &&
					st.size > AUTO_JPEG_MIN_BYTES &&
					/^true$/i.test(opaque))
			) {
				outMime = "image/jpeg";
				outExt = ".jpg";
			}

			const untouched = !needResize && !needCrop && outMime === mime;

			// resolve final artifact (passthrough = source itself)
			let file = src;
			if (!untouched) {
				const key = createHash("sha1")
					.update([src, st.size, st.mtimeMs, crop ?? "", maxPx, outMime].join("|"))
					.digest("hex");
				const cacheDir = join(tmpdir(), "pi-img-cache");
				file = join(cacheDir, `${key}${outExt}`);
				try {
					await stat(file);
				} catch {
					await mkdir(cacheDir, { recursive: true });
					const args = [src];
					if (crop) args.push("-crop", crop);
					if (needResize) args.push("-resize", `${maxPx}x${maxPx}>`);
					if (outMime === "image/jpeg") args.push("-quality", String(JPEG_QUALITY));
					args.push(file);
					const conv = await magick(pi, args, signal);
					if (!conv.ok) {
						const reason = conv.stderr.trim().split("\n")[0] || "the binary did not run";
						return refusal(
							`${TOOL_NAME}: unavailable — \`magick\` failed: ${reason}. ${MAGICK_HINT}`,
						);
					}
				}
			}

			const data = await readFile(file);
			const outSt = await stat(file);
			const [owStr, ohStr] = untouched
				? [String(w), String(h)]
				: (await magick(pi, ["identify", "-format", "%w %h", file], signal)).stdout
						.trim()
						.split(/\s+/);
			const ow = Number(owStr);
			const oh = Number(ohStr);

			const tokens = Math.round((ow * oh) / 784);
			const origTokens = Math.round((w * h) / 784);
			const kb = (n: number) => Math.max(1, Math.round(n / 1024));

			const notes: string[] = [];
			if (untouched) notes.push(`≤${maxPx}px, passed through untouched`);
			else notes.push(`was ${w}x${h}`);
			if (crop) notes.push(`cropped ${crop}`);
			if (outMime === "image/jpeg" && mime === "image/png") notes.push("png→jpeg q85");

			return {
				content: [
					{ type: "image" as const, data: data.toString("base64"), mimeType: outMime },
					{
						type: "text" as const,
						text: `image_read ${basename(src)}: ${ow}x${oh} ${outMime.replace("image/", "")}, ${kb(outSt.size)}KB (orig ${kb(st.size)}KB) → ~${tokens.toLocaleString()} tokens (full-res would be ~${origTokens.toLocaleString()}) — ${notes.join(", ")}`,
					},
				],
				details: {
					ok: true,
					original: `${w}x${h}`,
					final: `${ow}x${oh}`,
					bytes: outSt.size,
					originalBytes: st.size,
					tokens,
				},
			};
		},
	});

	// Vision gate. The tool is registered ACTIVE, so it needs no session-start
	// ADD: an absent image_read here means another extension has already settled
	// this session's tool set (foreman mode is the one that does), and
	// putting it back would rebuild the base system prompt — this tool carries a
	// promptSnippet and a promptGuideline — after that set went out with request
	// 1, while the owner's own enforcement removes it again at the first tool
	// call. Two rebuilds of a frozen prefix, the later one re-billing everything
	// from the top. Narrowing cannot fight an owner that way.
	pi.on("session_start", async (_event, ctx) => {
		const active = pi.getActiveTools();
		if (!isVisionModel(ctx.model) && active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
		}
	});

	// Only a CHANGE of model may WIDEN the set. The selection a session starts
	// with is not a change — `previousModel` is undefined for a first selection,
	// a restored one included — and at that moment the set belongs to whoever
	// settled it.
	pi.on("model_select", async (event, ctx) => {
		const active = pi.getActiveTools();
		const isVision = isVisionModel(ctx.model as { provider: string; id: string } | undefined);
		const has = active.includes(TOOL_NAME);
		if (isVision && !has && event?.previousModel) pi.setActiveTools([...active, TOOL_NAME]);
		if (!isVision && has) pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
	});
}

export default function (pi: ExtensionAPI): void {
	try {
		register(pi);
	} catch (error) {
		hookLog("image-read", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
