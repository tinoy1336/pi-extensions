/**
 * index.probe — the executable probe for the image read.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/image-read`.
 *
 * The tool's whole promise is the pair of numbers in its result: the final dimensions
 * and the token estimate derived from them. A silent change to the downscale rule, the
 * crop handling or the estimate either hides detail a caller asked for or reports a cost
 * that is wrong, and nothing else reads it.
 *
 * No image tool and no subprocess. The tool shells out through `pi.exec` for everything
 * it cannot do itself, and a CI runner carries no ImageMagick, so the probe stands in
 * for that BINARY rather than for the tool's logic: it writes its own PNG (real bytes,
 * built here with `zlib`), answers `identify` by reading that file's own header, and
 * performs the resize or crop it was asked for by writing another PNG of the target size.
 * Every assertion is still made against what the MODULE produced — the dimensions it
 * read, the estimate it computed, the note it wrote — and the fixture is checked by
 * decoding its declared dimensions rather than trusted.
 *
 * `TMPDIR` points at a scratch directory so the tool's own cache lands there instead of
 * the machine's, and the fixture and cache are deleted in the same run.
 *
 * Cases: the fixture declaring its own dimensions, a pass-through read, a downscale to a
 * long edge, a crop, the estimate the module's own rule produces for each, the transform
 * command the module built, the inline image part, and a file that is not there.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";

const scratch = mkdtempSync(join(tmpdir(), "pi-image-read-probe-"));
process.env.HOME = scratch;
process.env.TMPDIR = scratch;

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ""): void {
	checks += 1;
	if (condition) {
		console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── A real PNG, written here ────────────────────────────────────────────────

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

/** A flat opaque RGB PNG at `w`x`h`: signature, IHDR, one IDAT, IEND. */
function flatPng(w: number, h: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	// compression, filter and interlace stay 0
	const raw = Buffer.alloc((w * 3 + 1) * h, 0); // filter byte 0, then black pixels
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** The dimensions a PNG header declares, read from the file itself. */
function declaredSize(file: string): { w: number; h: number } {
	const header = readFileSync(file);
	return { w: header.readUInt32BE(16), h: header.readUInt32BE(20) };
}

const width = 1600;
const height = 1200;
const fixture = join(scratch, "fixture.png");
writeFileSync(fixture, flatPng(width, height));

const { default: imageRead } = await import("./index.ts");

// ── The binary the runner does not have ─────────────────────────────────────

type Result = {
	content: Array<{ type: string; text?: string }>;
	details?: { ok?: boolean; original?: string; final?: string; tokens?: number; bytes?: number };
};

const invoked: string[] = [];

/** Answers the tool's `magick` calls from the PNG bytes on disk, in process. */
async function magickDouble(
	file: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	invoked.push([file, ...args].join(" "));
	if (file !== "magick") return { code: 127, stdout: "", stderr: `${file}: not found` };

	if (args[0] === "identify") {
		const { w, h } = declaredSize(args[args.length - 1] ?? "");
		const wantsOpaque = args.some((arg) => arg.includes("opaque"));
		return { code: 0, stdout: `${w} ${h}${wantsOpaque ? " true" : ""}\n`, stderr: "" };
	}

	// The convert form: source first, output last, with -crop and -resize between.
	const { w, h } = declaredSize(args[0] ?? "");
	const out = args[args.length - 1] ?? "";
	let targetW = w;
	let targetH = h;
	const cropAt = args.indexOf("-crop");
	if (cropAt >= 0) {
		const geometry = /^(\d+)x(\d+)/.exec(args[cropAt + 1] ?? "");
		if (geometry) {
			targetW = Number(geometry[1]);
			targetH = Number(geometry[2]);
		}
	}
	const resizeAt = args.indexOf("-resize");
	if (resizeAt >= 0) {
		const cap = /^(\d+)x\d+>?$/.exec(args[resizeAt + 1] ?? "");
		if (cap) {
			const limit = Number(cap[1]);
			const longest = Math.max(targetW, targetH);
			if (longest > limit) {
				targetW = Math.round((targetW * limit) / longest);
				targetH = Math.round((targetH * limit) / longest);
			}
		}
	}
	writeFileSync(out, flatPng(targetW, targetH));
	return { code: 0, stdout: "", stderr: "" };
}

type Tool = {
	execute: (
		id: string,
		params: { path: string; max?: number; crop?: string; format?: string },
	) => Promise<Result>;
};

let tool: Tool | undefined;
const api = {
	on: () => {},
	registerTool: (registered: unknown) => {
		tool = registered as Tool;
	},
	registerCommand: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {},
	appendEntry: () => {},
	events: { on: () => {}, emit: () => {} },
	exec: magickDouble,
};
imageRead(api as never);
if (!tool) throw new Error("the extension registered no tool");
const readTool: Tool = tool;

/** The module's own estimate rule: pixels over 784, rounded. */
const estimate = (w: number, h: number): number => Math.round((w * h) / 784);

/** Run one read and return the result plus the text it carried. */
async function read(params: {
	path: string;
	max?: number;
	crop?: string;
}): Promise<{ result: Result; text: string }> {
	const result = await readTool.execute("probe", params);
	const text = result.content.find((part) => part.text !== undefined)?.text ?? "";
	return { result, text };
}

try {
	console.log("the fixture is a real image");
	const written = declaredSize(fixture);
	check(
		"the file the probe wrote declares its own dimensions",
		written.w === width && written.h === height,
		`${written.w}x${written.h}`,
	);
	check("nothing has been invoked yet", invoked.length === 0, invoked.join(" | "));

	console.log("a pass-through read");
	const full = await read({ path: fixture, max: 0 });
	check(
		"the original dimensions are reported",
		full.result.details?.original === `${width}x${height}`,
		String(full.result.details?.original),
	);
	check(
		"nothing was resized",
		full.result.details?.final === `${width}x${height}`,
		String(full.result.details?.final),
	);
	check(
		"the estimate is the module's own rule for those pixels",
		full.result.details?.tokens === estimate(width, height),
		`${full.result.details?.tokens} vs ${estimate(width, height)}`,
	);
	check(
		"the image is returned inline",
		full.result.content[0]?.type === "image",
		String(full.result.content[0]?.type),
	);
	check(
		"the text names the file it read",
		full.text.includes(basename(fixture)),
		full.text.slice(0, 60),
	);
	check(
		"a pass-through identifies the fixture and nothing else",
		invoked.length === 1,
		invoked.join(" | "),
	);

	console.log("a downscale to the long edge");
	const smaller = await read({ path: fixture, max: 800 });
	check(
		"the long edge is the cap",
		smaller.result.details?.final === "800x600",
		String(smaller.result.details?.final),
	);
	check(
		"the estimate follows the final pixels",
		smaller.result.details?.tokens === estimate(800, 600),
		`${smaller.result.details?.tokens} vs ${estimate(800, 600)}`,
	);
	check(
		"the estimate is smaller than the original's",
		(smaller.result.details?.tokens ?? 0) < estimate(width, height),
	);
	check(
		"the text says what it was",
		smaller.text.includes(`was ${width}x${height}`),
		smaller.text.slice(-60),
	);
	check(
		"the transform the module asked for carries the long-edge cap",
		invoked.some((call) => call.includes("-resize 800x800>")),
		invoked.join(" | "),
	);
	check(
		"the tool's cache stayed in the scratch directory",
		existsSync(join(scratch, "pi-img-cache")),
		join(scratch, "pi-img-cache"),
	);

	console.log("a crop");
	const cropped = await read({ path: fixture, max: 0, crop: "400x300+100+50" });
	check(
		"the crop decides the final size",
		cropped.result.details?.final === "400x300",
		String(cropped.result.details?.final),
	);
	check(
		"and the estimate follows it",
		cropped.result.details?.tokens === estimate(400, 300),
		`${cropped.result.details?.tokens} vs ${estimate(400, 300)}`,
	);
	check(
		"the text names the crop it applied",
		cropped.text.includes("cropped 400x300+100+50"),
		cropped.text.slice(-70),
	);
	check(
		"and the command carries the geometry it was given",
		invoked.some((call) => call.includes("-crop 400x300+100+50")),
		invoked.filter((call) => call.includes("-crop")).join(" | "),
	);

	console.log("a file that is not there");
	let missingOk = false;
	let outcome = "resolved";
	try {
		const missing = await read({ path: join(scratch, "absent.png"), max: 0 });
		missingOk = missing.result.details?.ok === true;
		outcome = `resolved ok=${String(missing.result.details?.ok)}`;
	} catch (error) {
		// Recorded as it is: this path throws rather than returning the refusal shape the
		// capability failures use. Either way it must never come back as a success.
		outcome = `threw (${error instanceof Error ? error.constructor.name : "unknown"})`;
	}
	check("a missing file never comes back as a successful read", !missingOk, outcome);

	check(
		"the fixture is still on disk to be deleted with the cache",
		statSync(fixture).size > 0,
		`${statSync(fixture).size} bytes`,
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.error(`image-read probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`image-read probe passed: ${checks} checks`);
