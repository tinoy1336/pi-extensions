/**
 * deepseek-cost footer-remainder harness.
 *
 * Pins the ONE string this package adds to the footer status line: the window
 * glyph plus the remaining time in the tariff window in force. The package's own
 * exported `remainingLabel` / `windowLabel` are driven with an INJECTED instant,
 * so the harness needs no live pi, no provider and no terminal.
 *
 * Every case is a Beijing wall-clock instant on the week of 2026-06-01 (Sat 06th,
 * Sun 07th, Mon 08th): the window rule is Beijing time, so the instant is chosen
 * relative to a weekday boundary — 09:00, 14:00 or 18:00 — which is what an
 * interval ends at. `at` is built from that wall clock by subtracting the fixed
 * UTC+8 offset (Asia/Shanghai has no daylight saving).
 *
 * Exit codes, so a caller can keep the two failure classes apart:
 *   0  every check passed
 *   1  a check failed (named FAIL line)
 *   2  a precondition is unmet — no module under test — so nothing was judged
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODULE = resolve(HERE, "../index.ts");

function abort(reason: string): never {
	process.stderr.write(`COST RIG ABORT: ${reason}\n`);
	process.exit(2);
}

type Window = "peak" | "valley";

type CostModule = {
	remainingLabel: (at?: Date) => string;
	windowAt: (at?: Date) => Window;
	windowEndAt: (at?: Date) => Date;
	windowLabel: (w: Window, at?: Date) => string;
};

const modulePath = process.env.COST_RIG_MODULE ?? DEFAULT_MODULE;
if (!existsSync(modulePath))
	abort(`no module under test at ${modulePath} (COST_RIG_MODULE overrides the path).`);

const mod = (await import(pathToFileURL(modulePath).href)) as Partial<CostModule>;
for (const name of ["remainingLabel", "windowAt", "windowEndAt", "windowLabel"] as const) {
	if (typeof mod[name] !== "function") abort(`${modulePath} does not export ${name}.`);
}
const { remainingLabel, windowAt, windowEndAt, windowLabel } = mod as CostModule;

process.stdout.write(`module under test: ${modulePath}\n`);

/** Beijing wall clock → instant. Fixed UTC+8: Asia/Shanghai has no daylight saving. */
const bjt = (y: number, mo: number, d: number, h: number, mi: number, s = 0): Date =>
	new Date(Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 3_600_000);

const VALLEY_GLYPH = "\ue390";
const PEAK_GLYPH = "\ue30d";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
	if (actual === expected) {
		passed++;
		process.stdout.write(`PASS  ${name} = ${JSON.stringify(actual)}\n`);
		return;
	}
	failed++;
	process.stdout.write(
		`FAIL  ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}\n`,
	);
}

function checkTrue(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed++;
		process.stdout.write(`PASS  ${name}${detail ? ` (${detail})` : ""}\n`);
		return;
	}
	failed++;
	process.stdout.write(`FAIL  ${name}${detail ? `: ${detail}` : ""}\n`);
}

// ── The remainders, one per shape the footer may show ────────────────────────
// Each `at` sits in a valley interval that ends at the named weekday peak start,
// so the remainder is exact and the expected label is fixed by the shape rule:
// the two largest non-zero units, the second dropped when it is zero.
const remainders: { name: string; at: Date; want: string }[] = [
	{ name: "day + hours", at: bjt(2026, 6, 7, 6, 0), want: "1d 3h" }, // Sun 06:00 → Mon 09:00
	{ name: "hours + minutes under a day", at: bjt(2026, 6, 7, 21, 55), want: "11h 5m" },
	{ name: "minutes + seconds", at: bjt(2026, 6, 8, 8, 6, 56), want: "53m 4s" }, // → Mon 09:00
	{ name: "seconds alone under a minute", at: bjt(2026, 6, 8, 8, 59, 22), want: "38s" },
	{ name: "second unit zero (days)", at: bjt(2026, 6, 6, 9, 0), want: "2d" }, // Sat → Mon 09:00
	{ name: "second unit zero (hours)", at: bjt(2026, 6, 8, 4, 0), want: "5h" },
	{ name: "second unit zero (minutes)", at: bjt(2026, 6, 8, 8, 59, 0), want: "1m" },
	{ name: "widest label", at: bjt(2026, 6, 8, 11, 0, 1), want: "59m 59s" }, // peak → Mon 12:00
	{ name: "inside the second peak window", at: bjt(2026, 6, 8, 17, 30, 30), want: "29m 30s" },
];
for (const c of remainders) check(`remainingLabel — ${c.name}`, remainingLabel(c.at), c.want);

// ── The footer field: glyph + space + the remainder, right-aligned to 3 ──────
check(
	"windowLabel — valley carries the crescent",
	windowLabel("valley", bjt(2026, 6, 7, 6, 0)),
	`${VALLEY_GLYPH} 1d 3h`,
);
check(
	"windowLabel — peak pads a short label",
	windowLabel("peak", bjt(2026, 6, 8, 10, 0)),
	`${PEAK_GLYPH}  2h`,
);
check(
	"windowLabel — peak, seconds only",
	windowLabel("peak", bjt(2026, 6, 8, 11, 59, 22)),
	`${PEAK_GLYPH} 38s`,
);
check(
	"windowLabel — peak, widest label",
	windowLabel("peak", bjt(2026, 6, 8, 11, 0, 1)),
	`${PEAK_GLYPH} 59m 59s`,
);

// ── The window rule at its boundaries ────────────────────────────────────────
// The split decides the RATE, so an off-by-one at 09:00, 12:00, 14:00 or 18:00
// bills one window at the other's price, and the weekend rule decides two whole
// days of it. These are the instants the sweep passes over.
const splits: { name: string; at: Date; want: Window }[] = [
	{
		name: "the last second before the morning peak",
		at: bjt(2026, 6, 8, 8, 59, 59),
		want: "valley",
	},
	{ name: "the first second of the morning peak", at: bjt(2026, 6, 8, 9, 0, 0), want: "peak" },
	{ name: "the last second of the morning peak", at: bjt(2026, 6, 8, 11, 59, 59), want: "peak" },
	{ name: "the first second of the noon gap", at: bjt(2026, 6, 8, 12, 0, 0), want: "valley" },
	{
		name: "the last second before the afternoon peak",
		at: bjt(2026, 6, 8, 13, 59, 59),
		want: "valley",
	},
	{ name: "the first second of the afternoon peak", at: bjt(2026, 6, 8, 14, 0, 0), want: "peak" },
	{ name: "the last second of the afternoon peak", at: bjt(2026, 6, 8, 17, 59, 59), want: "peak" },
	{ name: "the first second after it", at: bjt(2026, 6, 8, 18, 0, 0), want: "valley" },
	{ name: "midnight of a weekday", at: bjt(2026, 6, 8, 0, 0, 0), want: "valley" },
	{
		name: "a Friday evening just before the weekend",
		at: bjt(2026, 6, 5, 19, 0, 0),
		want: "valley",
	},
	{ name: "a Saturday inside the peak hours", at: bjt(2026, 6, 6, 10, 0, 0), want: "valley" },
	{ name: "a Sunday inside the peak hours", at: bjt(2026, 6, 7, 15, 0, 0), want: "valley" },
];
for (const c of splits) check(`windowAt — ${c.name}`, windowAt(c.at), c.want);

// The reset the footer counts down to: the end of the window in force.
const ends: { name: string; at: Date; want: Date }[] = [
	{ name: "inside the morning peak", at: bjt(2026, 6, 8, 10, 30), want: bjt(2026, 6, 8, 12, 0) },
	{ name: "inside the afternoon peak", at: bjt(2026, 6, 8, 15, 0), want: bjt(2026, 6, 8, 18, 0) },
	{ name: "in the noon gap", at: bjt(2026, 6, 8, 12, 30), want: bjt(2026, 6, 8, 14, 0) },
	{ name: "overnight", at: bjt(2026, 6, 8, 3, 0), want: bjt(2026, 6, 8, 9, 0) },
	{
		name: "exactly at the morning peak start",
		at: bjt(2026, 6, 8, 9, 0),
		want: bjt(2026, 6, 8, 12, 0),
	},
	{
		name: "exactly at the morning peak end",
		at: bjt(2026, 6, 8, 12, 0),
		want: bjt(2026, 6, 8, 14, 0),
	},
	{ name: "on the Friday evening", at: bjt(2026, 6, 5, 18, 0), want: bjt(2026, 6, 8, 9, 0) },
	{ name: "over the weekend", at: bjt(2026, 6, 7, 10, 0), want: bjt(2026, 6, 8, 9, 0) },
];
for (const c of ends)
	check(`windowEndAt — ${c.name}`, windowEndAt(c.at).getTime(), c.want.getTime());

// The reset as the footer renders it: the last second of one window and the first
// second of the next, including the jump over a weekend.
const resets: { name: string; at: Date; want: string }[] = [
	{ name: "the last second before the morning peak", at: bjt(2026, 6, 8, 8, 59, 59), want: "1s" },
	{ name: "the last second before the noon gap", at: bjt(2026, 6, 8, 11, 59, 59), want: "1s" },
	{ name: "the first second of the noon gap", at: bjt(2026, 6, 8, 12, 0, 0), want: "2h" },
	{ name: "the first second after the afternoon peak", at: bjt(2026, 6, 8, 18, 0, 0), want: "15h" },
	{ name: "the first second of a weekday", at: bjt(2026, 6, 8, 0, 0, 0), want: "9h" },
	{ name: "the start of the Friday-evening valley", at: bjt(2026, 6, 5, 18, 0, 0), want: "2d 15h" },
	{ name: "a Saturday midnight", at: bjt(2026, 6, 6, 0, 0, 0), want: "2d 9h" },
];
for (const c of resets) check(`remainingLabel — ${c.name}`, remainingLabel(c.at), c.want);

// ── Invariants over a dense sweep: shape, radix and width ───────────────────
const SIZES: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };
const RADIX: Record<string, number> = { d: Number.POSITIVE_INFINITY, h: 24, m: 60, s: 60 };

/** The first way `label` breaks the shape rule, or undefined when it holds. */
function shapeProblem(label: string): string | undefined {
	const parts = label.split(" ");
	if (parts.length < 1 || parts.length > 2) return `${parts.length} units`;
	const sizes: number[] = [];
	for (const part of parts) {
		const m = /^(\d+)([dhms])$/.exec(part);
		if (!m) return `unit "${part}" is not digits + one of dhms`;
		const value = Number(m[1]);
		if (value === 0) return `a zero unit is rendered ("${part}")`;
		if (value >= RADIX[m[2]]) return `"${part}" is not below its radix`;
		sizes.push(SIZES[m[2]]);
	}
	if (sizes.length === 2 && sizes[1] >= sizes[0])
		return `"${label}" is not in descending unit order`;
	return undefined;
}

const sweep: Date[] = [];
for (let t = bjt(2026, 6, 1, 0, 0).getTime(); t < bjt(2026, 6, 15, 0, 0).getTime(); t += 600_000)
	sweep.push(new Date(t));
const labels = sweep.map((at) => remainingLabel(at));
const fields = sweep.map((at) => windowLabel(windowAt(at), at));

const problems = labels.map(shapeProblem).filter((p): p is string => p !== undefined);
checkTrue(
	"sweep — every label is one or two non-zero units in descending order",
	problems.length === 0,
	problems[0] ?? `${sweep.length} samples`,
);
checkTrue(
	"sweep — no label is wider than the widest form (7 chars)",
	labels.every((label) => label.length <= 7),
	`max ${Math.max(...labels.map((l) => l.length))} chars`,
);
checkTrue(
	"sweep — the rendered field stays within 5..9 cells (glyph + space + <= 7)",
	fields.every((field) => field.length >= 5 && field.length <= 9),
	`max ${Math.max(...fields.map((f) => f.length))} cells`,
);
checkTrue(
	"sweep — both shapes occur (a one-unit and a two-unit label)",
	labels.some((l) => l.split(" ").length === 1) && labels.some((l) => l.split(" ").length === 2),
);

if (failed > 0) {
	process.stdout.write(`\n${failed} DEEPSEEK-COST CHECKS FAILED (${passed} passed)\n`);
	process.exit(1);
}
process.stdout.write(`\nALL ${passed} DEEPSEEK-COST CHECKS PASSED\n`);
