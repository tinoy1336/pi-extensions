/**
 * scoped-commits.probe — the executable probe for the per-package release scope
 * (`release/scoped-commits.mjs`) and the path gate it has to agree with
 * (`scripts/release-relevant.sh`).
 *
 * Run: `node release/scoped-commits.probe.mjs [package]` from the repository root, where
 * `package` is a key from RELEASE_ORDER (default `ext-lib`) — the cases run against that
 * package's directory and tag prefix.
 *
 * Every case builds its own scratch git repository with a real `<package>-v*` tag and real
 * commits, so the scope is exercised against git's own output rather than a fixture list, and
 * the gate script is the one the release job calls. Each case reports what the gate decides,
 * which commits reach the analysis, and what the stock (unscoped) plugin would have answered
 * for the same history — the contrast is the property under test.
 *
 * Cases: another package's commit alone (gate skips), the package's own fix (gate opens, patch),
 * a docs-only package change beside another package's fix (gate opens, no release — the
 * documented rule for docs commits — while the unscoped plugin answered "patch"), and a package
 * fix beside another package's fix (the changelog carries the package's entry only).
 *
 * The last section reads every release config in `release/` and asserts it declares the scoped
 * plugin for its own directory, so a config that kept the stock steps (which read every commit
 * since the package's tag) fails here rather than in a release run. It reads the configs, not
 * the package directory, so it runs whatever package the argument names.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const gate = join(root, "scripts", "release-relevant.sh");

const { default: scopedPlugin, scopedCommits } = await import("./scoped-commits.mjs");
const { analyzeCommits: stockAnalyzeCommits } = await import("@semantic-release/commit-analyzer");

const PKG = process.argv[2] ?? "ext-lib";
const PKG_DIR = `packages/${PKG}`;

const quiet = () => {};
const logger = {
	log: quiet,
	debug: quiet,
	warn: quiet,
	error: quiet,
	success: quiet,
	scope: () => logger,
};

let failures = 0;
let checks = 0;

function check(name, condition, detail = "") {
	checks += 1;
	if (condition) {
		console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function git(cwd, ...args) {
	return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

/** A scratch repository holding one commit tagged as the package's own last release. */
function scratchRepo(prefix) {
	const dir = mkdtempSync(join(tmpdir(), `scoped-commits-probe-${prefix}-`));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "probe@example.invalid");
	git(dir, "config", "user.name", "probe");
	commit(dir, "chore: seed the scratch repository", {
		[`${PKG_DIR}/package.json`]: `{ "name": "@tinoy/pi-${PKG}", "version": "0.1.0" }\n`,
		"packages/fleet/index.ts": "// seed\n",
	});
	git(dir, "tag", `${PKG}-v0.1.0`);
	return { dir, last: git(dir, "rev-parse", "HEAD").trim() };
}

function commit(dir, message, files) {
	for (const [path, body] of Object.entries(files)) {
		const full = join(dir, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD").trim();
}

/** The gate script's decision: "skip" (exit 1) or "release" (exit 0). */
function gateDecision(dir) {
	const run = spawnSync("bash", [gate, PKG], { cwd: dir, encoding: "utf8" });
	return { status: run.status, output: `${run.stdout}${run.stderr}`.trim() };
}

/** The commit list semantic-release hands a plugin, read back out of the same repository. */
function semanticReleaseContext(dir, last) {
	const shas = git(dir, "rev-list", `${last}..HEAD`).trim().split("\n").filter(Boolean);
	return {
		cwd: dir,
		// The notes generator reads the repository URL and the branch off the release options.
		options: { repositoryUrl: "https://github.com/tinoy1336/pi-extensions.git", branch: "main" },
		lastRelease: { gitHead: last },
		nextRelease: { gitHead: git(dir, "rev-parse", "HEAD").trim(), version: "0.1.1" },
		commits: shas.map((hash) => ({
			hash,
			message: git(dir, "log", "-1", "--format=%B", hash).trim(),
			gitTags: "",
		})),
		logger,
	};
}

function subjectOf(dir, hash) {
	return git(dir, "log", "-1", "--format=%s", hash).trim();
}
async function scopedVersion(context) {
	return await scopedPlugin.analyzeCommits(
		{ dir: PKG_DIR, preset: "conventionalcommits" },
		context,
	);
}

function scopedHashes(context) {
	return scopedCommits(PKG_DIR, context).map((commit) => commit.hash);
}

async function stockVersion(context) {
	return await stockAnalyzeCommits({ preset: "conventionalcommits" }, context);
}

async function scopedNotes(context) {
	return await scopedPlugin.generateNotes({ dir: PKG_DIR, preset: "conventionalcommits" }, context);
}

const scratchDirs = [];
function newScratch(prefix) {
	const repo = scratchRepo(prefix);
	scratchDirs.push(repo.dir);
	return repo;
}

// ---- case 1: another package's commit, and nothing else --------------------------

console.log("case 1 — a commit touching only another package");
{
	const { dir, last } = newScratch("other-package");
	commit(dir, "fix(fleet): keep loader tools selected", {
		"packages/fleet/index.ts": "// fleet change\n",
	});

	const decision = gateDecision(dir);
	check(
		"the gate skips the package",
		decision.status === 1,
		`exit ${decision.status}: ${decision.output}`,
	);

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	const stock = await stockVersion(context);
	check(
		"no commit reaches the package's analysis",
		scopedHashes(context).length === 0,
		`${context.commits.length} commit(s) in range, ${scopedHashes(context).length} scoped`,
	);
	check("the scoped analysis answers no release", scoped === null, `release type: ${scoped}`);
	check(
		"the stock plugin would have versioned the package from that commit",
		stock === "patch",
		`stock release type: ${stock}`,
	);
}

// ---- case 2: the package's own fix -------------------------------------------------

console.log("case 2 — a fix touching the package");
{
	const { dir, last } = newScratch("package-fix");
	const sha = commit(dir, `fix(${PKG}): refuse a malformed record by name`, {
		[`${PKG_DIR}/src/glob.ts`]: "// package change\n",
	});

	const decision = gateDecision(dir);
	check(
		"the gate releases the package",
		decision.status === 0,
		`exit ${decision.status}: ${decision.output}`,
	);

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	const hashes = scopedHashes(context);
	check("the package's own fix is a patch", scoped === "patch", `release type: ${scoped}`);
	check(
		"that commit is the analysed set",
		hashes.length === 1 && hashes[0] === sha,
		`${hashes.length} of ${context.commits.length} commit(s) scoped`,
	);
}

// ---- case 3: a docs-only package change beside another package's fix ---------------

console.log("case 3 — a docs-only package commit beside another package's fix");
{
	const { dir, last } = newScratch("docs-only");
	const docsSha = commit(dir, `docs(${PKG}): describe the refusal in the API table`, {
		[`${PKG_DIR}/README.md`]: "# Shared helpers\n",
	});
	const fleetSha = commit(dir, "fix(fleet): keep loader tools selected", {
		"packages/fleet/index.ts": "// fleet change\n",
	});

	const decision = gateDecision(dir);
	check(
		"the gate opens on the docs commit that touched the package",
		decision.status === 0,
		`exit ${decision.status}: ${decision.output}`,
	);

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	const stock = await stockVersion(context);
	const hashes = scopedHashes(context);
	check(
		"only the docs commit reaches the analysis",
		hashes.length === 1 && hashes[0] === docsSha,
		`scoped ${hashes.map((hash) => hash.slice(0, 8)).join(", ") || "none"}; fleet ${fleetSha.slice(0, 8)} excluded`,
	);
	check(
		"a docs commit releases nothing on its own",
		scoped === null,
		`scoped release type: ${scoped}`,
	);
	check(
		"the stock plugin would have released the package on the other package's fix",
		stock === "patch",
		`stock release type: ${stock}`,
	);
}

// ---- case 4: both changed ----------------------------------------------------------

console.log("case 4 — the package and another package both changed");
{
	const { dir, last } = newScratch("both-changed");
	// The notes writer renders a scoped type as "* **<package>:** <description>", so the checks
	// read the description and the scope rather than the raw commit subject.
	const pkgSummary = "refuse a malformed record by name";
	const fleetSummary = "keep loader tools selected";
	commit(dir, `fix(${PKG}): ${pkgSummary}`, { [`${PKG_DIR}/src/glob.ts`]: "// package change\n" });
	commit(dir, `fix(fleet): ${fleetSummary}`, { "packages/fleet/index.ts": "// fleet change\n" });

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	check(
		"the package's own fix still releases a patch",
		scoped === "patch",
		`release type: ${scoped}`,
	);

	const hashes = scopedHashes(context);
	check(
		"only the package's commit reaches the analysis",
		hashes.length === 1 && subjectOf(dir, hashes[0]).includes(pkgSummary),
		`scoped ${hashes.map((hash) => hash.slice(0, 8)).join(", ") || "none"}`,
	);

	const notes = await scopedNotes(context);
	check(
		"the changelog carries the package's entry",
		notes.includes(pkgSummary) && notes.includes(PKG),
		JSON.stringify(notes),
	);
	check(
		"the changelog does not carry the other package's entry",
		!notes.includes(fleetSummary) && !notes.includes("fleet"),
		JSON.stringify(notes),
	);
}

// ---- every release config is scoped to its own package ----------------------------

console.log("configs — every release config declares the scoped plugin");
{
	const configNames = readdirSync(here)
		.filter(
			(name) =>
				name.endsWith(".mjs") && name !== "scoped-commits.mjs" && !name.endsWith(".probe.mjs"),
		)
		.sort();
	check(
		"the release configs were found",
		configNames.length > 0,
		`${configNames.length} config(s)`,
	);
	for (const name of configNames) {
		const key = name.slice(0, -4);
		const { default: config } = await import(`./${name}`);
		const plugins = config?.plugins ?? [];
		const specs = plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin?.path));
		const first = plugins[0];
		check(
			`${key}: the first plugin scopes the analysis to packages/${key}`,
			first?.path === "./release/scoped-commits.mjs" &&
				first?.dir === `packages/${key}` &&
				first?.preset === "conventionalcommits",
			JSON.stringify(first),
		);
		check(
			`${key}: no stock commit-analyzer or notes generator remains`,
			!specs.includes("@semantic-release/commit-analyzer") &&
				!specs.includes("@semantic-release/release-notes-generator"),
			specs.filter((spec) => typeof spec === "string").join(", "),
		);
	}
}

// ---- hygiene ----------------------------------------------------------------------

for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
check(
	"every scratch repository was removed",
	scratchDirs.every((dir) => !existsSync(dir)),
);

console.log("");
if (failures > 0) {
	console.error(`scoped-commits probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`scoped-commits probe passed: ${checks} checks`);
