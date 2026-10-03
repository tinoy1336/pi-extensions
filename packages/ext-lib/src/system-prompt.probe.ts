/**
 * system-prompt.probe — the executable probe for the prompt-normalisation seam.
 *
 * Run: `node --experimental-strip-types src/system-prompt.probe.ts` from `packages/ext-lib`.
 *
 * Every provider request of every session that appends a block goes through these
 * two functions, and the bytes they produce ARE the cache prefix: a change here
 * that appends twice, fails to strip an inherited block or picks the wrong slot
 * re-bills the whole conversation, silently and per request. Nothing else checks
 * it, and both functions are pure, so the probe is a table of inputs and expected
 * bytes rather than a session.
 *
 * Cases: the three documented shapes of the canonical form (base only, base and
 * block, a duplicated or inherited block), the FIRST-marker strip rule including
 * its sharp edge, idempotence, a single-line block, and every payload shape the
 * slot claims to cover — plus the shapes it refuses.
 */
import { canonicalSystemPrompt, PROMPT_APPEND_SEP, systemPromptSlot } from "./system-prompt.ts";

const BLOCK = "Caveman mode.\nSecond line.";

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

function show(text: string): string {
	return JSON.stringify(text);
}

console.log("the canonical form");
check("the separator is the two newlines the marker is built from", PROMPT_APPEND_SEP === "\n\n");

const baseOnly = canonicalSystemPrompt("BASE", BLOCK);
check(
	"a base with no block gains the block once",
	baseOnly.text === `BASE${PROMPT_APPEND_SEP}${BLOCK}`,
	show(baseOnly.text),
);
check("a base with no block reports no block", baseOnly.hadBlock === false);

const already = canonicalSystemPrompt(`BASE${PROMPT_APPEND_SEP}${BLOCK}`, BLOCK);
check(
	"a base that already carries the block is unchanged",
	already.text === baseOnly.text,
	show(already.text),
);
check("a base that already carries the block reports one", already.hadBlock === true);

const doubled = canonicalSystemPrompt(
	`BASE${PROMPT_APPEND_SEP}${BLOCK}${PROMPT_APPEND_SEP}${BLOCK}`,
	BLOCK,
);
check(
	"a doubled block is stripped back to one",
	doubled.text === baseOnly.text,
	show(doubled.text),
);

const inherited = canonicalSystemPrompt(
	`BASE${PROMPT_APPEND_SEP}Caveman mode.\nAn older body.`,
	BLOCK,
);
check(
	"an inherited block sharing the first line is replaced, not kept",
	inherited.text === baseOnly.text,
	show(inherited.text),
);

const mentionsMarker = canonicalSystemPrompt(
	`BASE${PROMPT_APPEND_SEP}Caveman mode. quoted in prose`,
	BLOCK,
);
check(
	"the strip takes the FIRST marker, so prose that opens a block is truncated",
	mentionsMarker.text === `BASE${PROMPT_APPEND_SEP}${BLOCK}`,
	show(mentionsMarker.text),
);

const single = canonicalSystemPrompt("BASE", "SINGLE");
check(
	"a single-line block appends whole",
	single.text === `BASE${PROMPT_APPEND_SEP}SINGLE`,
	show(single.text),
);

const empty = canonicalSystemPrompt("", BLOCK);
check(
	"an empty base still gets the separator",
	empty.text === `${PROMPT_APPEND_SEP}${BLOCK}`,
	show(empty.text),
);

const twice = canonicalSystemPrompt(baseOnly.text, BLOCK).text;
check("normalising twice changes nothing", twice === baseOnly.text, show(twice));
check(
	"normalising a fork that carried another scope changes nothing the second time",
	canonicalSystemPrompt(inherited.text, BLOCK).text === baseOnly.text,
);
check(
	"a base that only mentions the marker's text keeps its head",
	canonicalSystemPrompt("Caveman mode. plain", BLOCK).hadBlock === false,
);

console.log("the slot the payload carries");
const messagePayload = { messages: [{ role: "system", content: "S" }] };
const messageSlot = systemPromptSlot(messagePayload);
check("a first-message system role is found", messageSlot?.get() === "S");
messageSlot?.set("T");
check("writing the slot rewrites that message", messagePayload.messages[0].content === "T");

check(
	"a first-message developer role is found",
	systemPromptSlot({ messages: [{ role: "developer", content: "D" }] })?.get() === "D",
);
check(
	"a first-message user role is not a slot",
	systemPromptSlot({ messages: [{ role: "user", content: "U" }] }) === null,
);

const topLevel = { system: "S" };
const topSlot = systemPromptSlot(topLevel);
check("a top-level system string is found", topSlot?.get() === "S");
topSlot?.set("T");
check("writing the top-level slot rewrites the field", topLevel.system === "T");

const blockList = { system: [{ type: "text", text: "S" }] };
const listSlot = systemPromptSlot(blockList);
check("a single-block system list is found", listSlot?.get() === "S");
listSlot?.set("T");
check("writing the list slot rewrites the block", blockList.system[0].text === "T");

check(
	"a two-block system list is refused",
	systemPromptSlot({ system: [{ text: "A" }, { text: "B" }] }) === null,
);
check(
	"a system list with no text is refused",
	systemPromptSlot({ system: [{ type: "text" }] }) === null,
);

const instructions = { instructions: "I" };
check("an instructions string is found", systemPromptSlot(instructions)?.get() === "I");
check(
	"the first message wins over a top-level system field",
	systemPromptSlot({ messages: [{ role: "system", content: "M" }], system: "S" })?.get() === "M",
);
check("a null payload has no slot", systemPromptSlot(null) === null);
check("a string payload has no slot", systemPromptSlot("system") === null);
check(
	"an empty message list falls through to the other shapes",
	systemPromptSlot({ system: "S", messages: [] })?.get() === "S",
);

console.log("");
if (failures > 0) {
	console.error(`system-prompt probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`system-prompt probe passed: ${checks} checks`);
