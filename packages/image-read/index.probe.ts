/**
 * index.probe — the executable probe for the image read.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/image-read`.
 *
 * The tool's whole promise is the pair of numbers in its result: the final dimensions
 * and the token estimate derived from them. A silent change to the downscale rule, the
 * crop handling or the estimate either hides detail a caller asked for or reports a
 * cost that is wrong, and nothing else reads it.
 *
 * The fixture is synthesised here with ImageMagick — a flat 1600x1200 PNG written under
 * a scratch directory, never a picture that belongs to anyone — and `TMPDIR` is pointed
 * at that same directory so the tool's own cache lands there instead of the machine's.
 * The fixture and the cache are deleted in the same run.
 *
 * Cases: a pass-through read, a downscale to a long edge, a crop, the estimate the
 * module's own rule produces for each, the inline image part, and a file that is not
 * there.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-image-read-probe-"));
process.env.HOME = scratch;
process.env.TMPDIR = scratch;

const width = 1600;
const height = 1200;
const fixture = join(scratch, "fixture.png");
execFileSync("magick", ["-size", `${width}x${height}`, "xc:red", fixture], { timeout: 60_000 });

const { default: imageRead } = await import("./index.ts");

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

type Result = {
	content: Array<{ type: string; text?: string }>;
	details?: {
		ok?: boolean;
		original?: string;
		final?: string;
		tokens?: number;
		bytes?: number;
	};
};

type Tool = {
	execute: (
		id: string,
		params: { path: string; max?: number; crop?: string; format?: string },
	) => Promise<Result>;
};

let tool: Tool | undefined;
const api = {
	on: () => {},
	// The tool spawns ImageMagick through this seam; the recorder runs the real
	// binary, which is what makes the dimensions and the estimate assertable.
	exec: async (file: string, args: string[]) => {
		const result = spawnSync(file, args, { encoding: "utf8", timeout: 60_000 });
		return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	},
	registerTool: (registered: unknown) => {
		tool = registered as Tool;
	},
	registerCommand: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {},
	appendEntry: () => {},
	events: { on: () => {}, emit: () => {} },
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

	console.log("a file that is not there");
	let missingOk = false;
	let outcome = "resolved";
	try {
		const missing = await read({ path: join(scratch, "absent.png"), max: 0 });
		missingOk = missing.result.details?.ok === true;
		outcome = `resolved ok=${String(missing.result.details?.ok)}`;
	} catch (error) {
		// Recorded as it is: this path rejects rather than returning the refusal shape
		// the rest of the tool uses. Either way it must never come back as a success.
		outcome = `rejected (${error instanceof Error ? error.constructor.name : "unknown"})`;
	}
	check("a missing file never comes back as a successful read", !missingOk, outcome);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.error(`image-read probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`image-read probe passed: ${checks} checks`);
