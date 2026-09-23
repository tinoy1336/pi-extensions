// Stranger-install smoke test for the published packages.
//
// Runs in an app directory that was installed from `npm pack` tarballs
// (scripts/stranger-install.sh) against a pinned pi release. It loads the installed
// extension through pi's own resource loader — the loader a real session uses — and
// asserts the contract a stranger depends on:
//
//   1. the package manifest resolves and every path it names exists in the tarball;
//   2. the extension loads with no loader error;
//   3. the registered tool set is exactly the expected set, compared as a set;
//   4. each tool's parameter schema is intact (names, order, required keys, types);
//   5. the store reads and writes under a scratch agent directory, and only there;
//   6. every refusal path answers with a refusal instead of throwing, and leaves the
//      store untouched.
//
// No model call: this is about loading and registration, not behaviour.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const appDir = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(appDir, "agent");
const storePath = path.join(agentDir, "canon", "canon.json");
const homeStorePath = path.join(process.env.HOME ?? "/root", ".pi", "agent", "canon", "canon.json");

/** The tools the extension must register — exactly these, no more, no fewer. */
const EXPECTED_TOOLS = ["canon_add", "canon_category", "canon_edit", "canon_remove"];

/** Parameter contract per tool: property names in declaration order, and required set. */
const EXPECTED_PARAMS = {
	canon_add: {
		properties: ["text", "model", "audience", "category", "reason"],
		required: ["text", "model", "audience"],
	},
	canon_remove: { properties: ["id", "reason"], required: ["id"] },
	canon_edit: {
		properties: ["id", "text", "model", "audience", "category", "reason"],
		required: ["id", "text"],
	},
	canon_category: { properties: ["op", "title", "description", "id"], required: ["op"] },
};

const packages = ["@tinoy/pi-canon", "@tinoy/pi-ext-lib"];
const installed = (name) => path.join(appDir, "node_modules", ...name.split("/"));

let checks = 0;
const failures = [];

function record(name, fn) {
	try {
		const value = fn();
		console.log(`  ok    ${name}${value ? ` — ${value}` : ""}`);
		checks++;
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
		console.log(`  FAIL  ${name}: ${error.message}`);
	}
}

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ---- 1. installed payload -------------------------------------------------------

const manifests = {};
for (const name of packages) {
	const manifestPath = path.join(installed(name), "package.json");
	assert.ok(existsSync(manifestPath), `${name} is not installed at ${manifestPath}`);
	manifests[name] = JSON.parse(readFileSync(manifestPath, "utf8"));
	console.log(`installed ${manifests[name].name}@${manifests[name].version}`);
}
const piVersion = JSON.parse(
	readFileSync(path.join(installed("@earendil-works/pi-coding-agent"), "package.json"), "utf8"),
).version;
console.log(`installed pi ${piVersion}`);

const entries = manifests["@tinoy/pi-canon"].pi?.extensions ?? [];
assert.ok(entries.length > 0, "@tinoy/pi-canon declares no pi.extensions entry");
const entryPaths = entries.map((entry) => path.resolve(installed("@tinoy/pi-canon"), entry));
for (const entryPath of entryPaths) {
	assert.ok(
		existsSync(entryPath),
		`pi.extensions names ${entryPath}, which the tarball does not contain`,
	);
}

// ---- 2. load through pi's own loader --------------------------------------------

const loader = new DefaultResourceLoader({
	cwd: appDir,
	agentDir,
	settingsManager: SettingsManager.inMemory(),
	additionalExtensionPaths: entryPaths,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();

const { extensions, errors } = loader.getExtensions();
assert.equal(
	errors.length,
	0,
	`extension load errors: ${errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
);
const extension = extensions.find((candidate) => entryPaths.includes(candidate.resolvedPath));
assert.ok(
	extension,
	`the loader did not load ${entryPaths.join(", ")} (loaded: ${extensions.map((e) => e.path).join(", ") || "none"})`,
);
console.log(`loaded ${extension.path}`);

// ---- 3. registered tools --------------------------------------------------------

const tools = extension.tools;
record("registers exactly the expected tools", () => {
	assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS, "registered tool set differs");
	return EXPECTED_TOOLS.join(", ");
});

// ---- 4. parameter schema --------------------------------------------------------

for (const [name, expected] of Object.entries(EXPECTED_PARAMS)) {
	record(`parameter shape: ${name}`, () => {
		const tool = tools.get(name);
		assert.ok(tool, `${name} is not registered`);
		const definition = tool.definition;
		for (const field of ["label", "description", "promptSnippet"]) {
			assert.ok(
				typeof definition[field] === "string" && definition[field].length > 0,
				`${name}.${field} is missing`,
			);
		}
		const schema = definition.parameters;
		assert.ok(schema && schema.type === "object", `${name}.parameters is not an object schema`);
		assert.deepEqual(
			Object.keys(schema.properties),
			expected.properties,
			`${name} parameter names differ`,
		);
		assert.deepEqual(schema.required ?? [], expected.required, `${name} required list differs`);
		for (const [key, property] of Object.entries(schema.properties)) {
			assert.equal(property.type, "string", `${name}.${key} is not a string parameter`);
			assert.ok(property.description?.length > 0, `${name}.${key} has no description`);
		}
		return expected.properties.join(", ");
	});
}

// ---- 5. store read/write against the scratch agent directory --------------------

async function call(name, params) {
	const tool = tools.get(name);
	assert.ok(tool, `${name} is not registered`);
	const result = await tool.definition.execute("smoke-call", params, undefined, undefined, {});
	assert.ok(Array.isArray(result?.content), `${name} returned no content array`);
	assert.equal(result.content[0]?.type, "text", `${name} returned a non-text result`);
	return {
		text: result.content[0].text,
		ok: result.details?.ok === true,
		details: result.details ?? {},
	};
}

assert.ok(!existsSync(storePath), `the scratch store already exists at ${storePath}`);

const created = await call("canon_category", { op: "add", title: "Smoke" });
assert.equal(created.ok, true, `canon_category add failed: ${created.text}`);
assert.match(created.details.id, /^[0-9a-z]{6}$/, "category id is not a 6-char handle");

record("canon_category writes the store into the scratch agent directory", () => {
	assert.ok(existsSync(storePath), `no store at ${storePath}`);
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.categories.length, 1, "the store does not hold the new category");
	assert.equal(store.categories[0].title, "Smoke");
	return storePath;
});

record("the store does not land in the user's real agent directory", () => {
	assert.ok(!existsSync(homeStorePath), `a store was written at ${homeStorePath}`);
	return homeStorePath;
});

const added = await call("canon_add", {
	text: "smoke line",
	model: "global",
	audience: "all",
	category: created.details.id,
});
assert.equal(added.ok, true, `canon_add failed: ${added.text}`);
assert.match(added.details.id, /^[0-9a-z]{6}$/, "entry id is not a 6-char handle");

record("canon_add writes an entry the store reads back", () => {
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.entries.length, 1, "the store does not hold the new entry");
	const entry = store.entries[0];
	assert.equal(entry.text, "smoke line");
	assert.equal(entry.model, "global");
	assert.equal(entry.audience, "all");
	assert.equal(entry.category, created.details.id);
	return `[${entry.id}]`;
});

// A store written outside the extension must be read by it: canon_remove reports the
// entry it read from the file, which only the file can have supplied.
writeFileSync(
	storePath,
	`${JSON.stringify(
		{
			entries: [{ id: "zz0001", text: "hand written line", model: "global", audience: "all" }],
			categories: [],
		},
		null,
		2,
	)}\n`,
);
const removed = await call("canon_remove", { id: "zz0001" });
record("canon_remove reads a store written outside the extension", () => {
	assert.equal(removed.ok, true, `canon_remove failed: ${removed.text}`);
	assert.match(
		removed.text,
		/hand written line/,
		"the entry text did not come from the store file",
	);
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.entries.length, 0, "the entry was not removed from the store");
	return removed.text;
});

// ---- 6. refusal paths ------------------------------------------------------------

const storeBefore = sha256(storePath);

const refusals = [
	[
		"canon_add without category",
		"canon_add",
		{ text: "x", model: "global", audience: "all" },
		/category is required/,
	],
	[
		"canon_add with an unknown category",
		"canon_add",
		{ text: "x", model: "global", audience: "all", category: "nope" },
		/no category "nope"/,
	],
	[
		"canon_add with an invalid audience",
		"canon_add",
		{ text: "x", model: "global", audience: "bogus", category: "smoke" },
		/Invalid audience "bogus"/,
	],
	[
		"canon_remove with an unknown id",
		"canon_remove",
		{ id: "nope00" },
		/No canon line with id "nope00"/,
	],
	[
		"canon_edit with an unknown id",
		"canon_edit",
		{ id: "nope00", text: "x" },
		/No canon line with id "nope00"/,
	],
	[
		"canon_category with an invalid op",
		"canon_category",
		{ op: "nope" },
		/Invalid op: use add, edit, remove, or list\./,
	],
	[
		"canon_category add without a title",
		"canon_category",
		{ op: "add" },
		/Title required for category add\./,
	],
];

for (const [name, tool, params, expected] of refusals) {
	const result = await call(tool, params);
	record(`refuses: ${name}`, () => {
		assert.equal(result.ok, false, `the call was accepted: ${result.text}`);
		assert.match(result.text, expected, "the refusal does not explain what was wrong");
		return result.text.slice(0, 60);
	});
}

record("refusals leave the store untouched", () => {
	assert.equal(sha256(storePath), storeBefore, "a refused call rewrote the store");
	return storeBefore.slice(0, 12);
});

// ---- summary --------------------------------------------------------------------

console.log("");
if (failures.length > 0) {
	console.error(`smoke test failed: ${failures.length} of ${checks + failures.length} checks`);
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(`smoke test passed: ${checks} checks`);
