/**
 * tool-header.probe — the executable probe for the shared header builder.
 *
 * Run: `node --experimental-strip-types src/tool-header.probe.ts` from `packages/ext-lib`.
 *
 * The builder wraps a header line by VISIBLE width, so an SGR sequence must count
 * as zero characters and must never be cut in half. The assertion is therefore
 * made against the probe's own measurement rather than the builder's: each
 * rendered line is split on the escape character and each sequence's introducer
 * removed, which is independent of how the builder matches a sequence.
 *
 * Cases: clip (flatten, ellipsis, no-op), argText/argNumber (accepted and refused
 * shapes), the unthemed header (name then parts, an empty part skipped), the
 * unthemed wrap (a segment longer than the width splits), the themed wrap
 * (escapes are zero-width, every line opens with the colour in force, no
 * character is lost), and the guarded entry point (a throwing builder degrades
 * to the name alone).
 */
import { argNumber, argText, clip, renderToolHeader, safeToolHeader } from "./tool-header.ts";

const ESC = "\u001b";
const COLOUR = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

/** The visible text of a rendered line: an SGR sequence carries no glyphs. */
function visible(line: string): string {
	return line
		.split(ESC)
		.map((part) => part.replace(/^\[[0-9;]*m/, ""))
		.join("");
}

/** A theme whose `fg` emits a real sequence, so width accounting has to skip it. */
const theme = {
	fg: (colour: string, text: string): string =>
		`${ESC}[3${colour === "red" ? 1 : 2}m${text}${RESET}`,
	bold: (text: string): string => text,
};

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

console.log("clip");
check(
	"flattens runs of whitespace",
	clip("  a   b  ") === "a b",
	JSON.stringify(clip("  a   b  ")),
);
check("ellipsis clips to max", clip("abcdef", 4) === "abc…", JSON.stringify(clip("abcdef", 4)));
check("short text is untouched", clip("abc", 10) === "abc");
check(
	"max of 1 keeps one character",
	clip("abcdef", 1) === "a…",
	JSON.stringify(clip("abcdef", 1)),
);

console.log("argText / argNumber");
check("a padded string is trimmed", argText({ key: "  x  " }, "key") === "x");
check("a blank string is refused", argText({ key: "   " }, "key") === undefined);
check("a missing key is refused", argText({}, "key") === undefined);
check("a finite number passes", argNumber({ key: 3 }, "key") === 3);
check("NaN is refused", argNumber({ key: Number.NaN }, "key") === undefined);
check("a numeric string is refused", argNumber({ key: "3" }, "key") === undefined);

console.log("unthemed header");
check(
	"the name and the parts are one line",
	renderToolHeader(undefined, "tool", [["red", " one"]])
		.render(80)
		.join("\n") === "tool one",
	JSON.stringify(renderToolHeader(undefined, "tool", [["red", " one"]]).render(80)),
);
check(
	"an empty part is skipped",
	renderToolHeader(undefined, "tool", [["red", ""]])
		.render(80)
		.join("\n") === "tool",
);

console.log("unthemed wrap");
const plain = renderToolHeader(undefined, "t", [["", "abcdefghij"]]).render(5);
check("a long segment splits at the width", plain.length === 3, JSON.stringify(plain));
check(
	"every line fits",
	plain.every((line) => visible(line).length <= 5),
	JSON.stringify(plain),
);
check("no character is lost", plain.map(visible).join("") === "tabcdefghij");

console.log("themed wrap: escapes are zero-width");
const themed = renderToolHeader(theme, "tool", [["red", "abcdefghij"]]).render(5);
check("the escape does not count toward the width", themed.length === 3, JSON.stringify(themed));
check(
	"every line fits its visible width",
	themed.every((line) => visible(line).length <= 5),
	JSON.stringify(themed.map(visible)),
);
check(
	"no character is lost",
	themed.map(visible).join("") === "toolabcdefghij",
	JSON.stringify(themed.map(visible)),
);
check(
	"a continuation line re-opens with the colour in force",
	themed.slice(1).every((line) => line.startsWith(COLOUR)),
	JSON.stringify(themed.slice(1)),
);
check(
	"every sequence is a whole sequence",
	themed.every((line) =>
		line
			.split(ESC)
			.slice(1)
			.every((part) => /^\[[0-9;]*m/.test(part)),
	),
	JSON.stringify(themed),
);

console.log("guarded entry point");
const degraded = safeToolHeader(theme, "tool", () => {
	throw new Error("odd argument set");
}).render(80);
check(
	"a throwing builder degrades to the name alone",
	degraded.map(visible).join("") === "tool",
	JSON.stringify(degraded),
);
check(
	"a good builder is passed through",
	visible(
		safeToolHeader(theme, "tool", () => [["red", " one"]])
			.render(80)
			.join(""),
	) === "tool one",
);

console.log("");
if (failures > 0) {
	console.error(`tool-header probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`tool-header probe passed: ${checks} checks`);
