/**
 * index.probe — the executable probe for the glyph lookup, the audit and the sheet fallback.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/nf`.
 *
 * Three decisions the dataset and the codepoint rules carry: `search` matches names and
 * pages its rows, `audit` resolves a `\uXXXX` escape against the SHIPPED dataset and
 * separates three shapes — assigned, unassigned PUA, and the malformed five-or-six digit
 * unbraced form that renders one wrong glyph plus literal text — and `sheet` falls back
 * to a text list rather than an image when the session's model cannot see one. A drift in
 * any of them shows up as a missing flag or a wrong codepoint, and no workspace gate
 * reads the dataset at all.
 *
 * Nothing here needs a display, a font or Pillow: the probe never reaches the image
 * branch (no `session_start` is fired, so the session reads as non-vision), and the
 * audit runs against a scratch directory of synthesized files. That branch — a contact
 * sheet rendered by python3 with Pillow — is named in the runner header as the part that
 * cannot be checked here.
 *
 * Cases: a name search and its row shape, the prefix ordering, the page cap and its
 * suffix, an empty keyword, the sheet's token resolution and its text fallback, the audit
 * against assigned, unassigned and malformed escapes, a clean tree, and a missing
 * directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-nf-probe-"));

type Tool = {
	name: string;
	execute: (
		id: string,
		params: { action: string; keyword?: string; codes?: string[] | string; dir?: string },
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { ok?: boolean } }>;
};

let tool: Tool | undefined;
const api = {
	registerTool: (registered: unknown) => {
		tool = registered as Tool;
	},
	on: () => {},
};
const { default: nf } = await import("./index.ts");
nf(api as never);
if (!tool) throw new Error("the extension registered no nf tool");
const nfTool: Tool = tool;

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

async function run(params: Parameters<Tool["execute"]>[1]): Promise<string> {
	const result = await nfTool.execute("probe", params);
	return result.content.map((part) => part.text ?? "").join("\n");
}

console.log("a name search");
const search = await run({ action: "search", keyword: "python" });
const searchLines = search
	.split("\n")
	.slice(1)
	.filter((line) => line.includes("\t"));
check(
	"the header names the match count",
	/^\d+ match\(es\) for "python" \(of \d+ glyphs\):/.test(search),
	search.split("\n")[0] ?? "",
);
check(
	"every row is name, escape and codepoint",
	searchLines.length > 0 &&
		searchLines.every((line) => /^.+\t\\u[0-9a-f]{4,6}\tU\+[0-9A-F]{4,6}$/.test(line)),
	searchLines[0] ?? "(no rows)",
);
check(
	"and every row matches the keyword",
	searchLines.every((line) => line.toLowerCase().includes("python")),
);

console.log("the ordering and the page");
const paged = await run({ action: "search", keyword: "e" });
const pagedRows = paged
	.split("\n")
	.slice(1)
	.filter((line) => line.includes("\t"));
check("a broad keyword fills the page", pagedRows.length === 40, `${pagedRows.length} row(s)`);
check(
	"and says how many are left out",
	/… \+\d+ more$/.test(paged.trim()),
	paged.trim().split("\n").at(-1) ?? "",
);
const named = await run({ action: "search", keyword: "dev-python" });
const namedRows = named
	.split("\n")
	.slice(1)
	.filter((line) => line.includes("\t"));
check(
	"a name that starts with the keyword comes first",
	namedRows[0]?.toLowerCase().startsWith("dev-python"),
	namedRows[0] ?? "(no rows)",
);

console.log("the sheet, without a vision model");
check(
	"an absent keyword asks for one",
	(await run({ action: "search", keyword: "  " })).includes("pass a keyword"),
);
const resolved = await run({ action: "sheet", codes: ["dev-python", "e73c"] });
check(
	"a name and a bare code both resolve",
	resolved.includes("VISION model required"),
	resolved.split("\n")[0] ?? "",
);
const resolvedRows = resolved.split("\n").filter((line) => line.includes("\t"));
check(
	"and the text list is one row per token, with the escape",
	resolvedRows.length === 2 && resolvedRows.every((line) => /\t\\ue73c\tU\+E73C$/.test(line)),
	resolvedRows.join(" / ") || "(no rows)",
);
const unknownOnly = await run({ action: "sheet", codes: ["not-a-glyph-name"] });
check(
	"an unresolvable token is named",
	unknownOnly.includes("none of the given tokens resolved") &&
		unknownOnly.includes("not-a-glyph-name"),
	unknownOnly.split("\n")[0] ?? "",
);

// A PUA codepoint the shipped dataset does not define, chosen by asking the package
// itself: the audit's assigned set and the sheet's are the same set, so a code the sheet
// refuses is the one the audit must flag.
const candidate = "f8ff";
const candidateRefused = (await run({ action: "sheet", codes: [candidate] })).includes(
	"none of the given tokens resolved",
);

console.log("the audit");
const tree = join(scratch, "tree");
mkdirSync(join(tree, "nested"), { recursive: true });
const assigned = searchLines[0]?.split("\t")[1] ?? "";
writeFileSync(join(tree, "assigned.ts"), `const icon = "${assigned}";\n`);
writeFileSync(join(tree, "nested", "unassigned.ts"), `const gone = "\\u${candidate}";\n`);
writeFileSync(join(tree, "malformed.ts"), 'const broken = "\\uf024b";\n');
writeFileSync(join(tree, "notes.md"), "not a typescript file\n");
writeFileSync(join(tree, "nested", "plain.ts"), "const ok = 1;\n");

const audit = await run({ action: "audit", dir: tree });
check(
	"the summary counts the files it scanned",
	audit.startsWith(`audit ${tree}: 4 .ts/.tsx file(s),`),
	audit.split("\n")[0] ?? "",
);
check(
	"an assigned escape is not flagged",
	!audit.includes(`U+${assigned.slice(2, 6).toUpperCase()}  UNASSIGNED`),
	assigned,
);
check(
	`the unassigned PUA codepoint ${candidate} is ${candidateRefused ? "flagged" : "accepted"}`,
	candidateRefused ? audit.includes("UNASSIGNED PUA") : !audit.includes("UNASSIGNED PUA"),
	audit.includes("UNASSIGNED PUA") ? "flagged" : "not flagged",
);
check(
	"the malformed five-hex escape is flagged",
	audit.includes("MALFORMED unbraced 5-hex escape"),
	audit.split("\n").slice(1).join(" / ") || "(no flags)",
);
check(
	"and the flag says how it renders",
	audit.includes("parses as U+") && audit.includes('literal "b"'),
);
check(
	"with the line number of the flag",
	/malformed\.ts:1/.test(audit),
	(audit.match(/\S*malformed\.ts:\d+/) ?? ["(none)"])[0],
);
check("a non-typescript file is skipped", !audit.includes("notes.md"));
check("and a clean file contributes no flag", !/plain\.ts:/.test(audit));

const clean = join(scratch, "clean");
mkdirSync(clean, { recursive: true });
writeFileSync(join(clean, "ok.ts"), "const x = 1;\n");
check(
	"a clean tree reports no flags",
	(await run({ action: "audit", dir: clean })).includes("0 flag(s)"),
);
check(
	"a directory that is not there is refused",
	(await run({ action: "audit", dir: join(scratch, "absent") })).includes(
		"is not a directory to audit",
	),
);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`nf probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`nf probe passed: ${checks} checks`);
