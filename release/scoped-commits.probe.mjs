/**
 * scoped-commits.probe — the executable probe for the per-package release scope
 * (`release/scoped-commits.mjs`) and the path gate it has to agree with
 * (`scripts/release-relevant.sh`).
 *
 * Run: `node release/scoped-commits.probe.mjs` from the repository root.
 *
 * Every case builds its own scratch git repository with a real `ext-lib-v*` tag and real
 * commits, so the scope is exercised against git's own output rather than a fixture list, and
 * the gate script is the one the release job calls. Each case reports what the gate decides,
 * which commits reach the analysis, and what the stock (unscoped) plugin would have answered
 * for the same history — the contrast is the property under test.
 *
 * Cases: another package's commit alone (gate skips), the library's own fix (gate opens, patch),
 * a docs-only library change beside another package's fix (gate opens, no release — the
 * documented rule for docs commits — while the unscoped plugin answered "patch"), and a library
 * fix beside another package's fix (the changelog carries the library's entry only).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const gate = join(root, "scripts", "release-relevant.sh");

const { default: scopedPlugin, scopedCommits } = await import("./scoped-commits.mjs");
const { analyzeCommits: stockAnalyzeCommits } = await import("@semantic-release/commit-analyzer");

const PKG = "ext-lib";
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
		[`${PKG_DIR}/package.json`]: '{ "name": "@tinoy/pi-ext-lib", "version": "0.1.0" }\n',
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
		"the gate skips the library",
		decision.status === 1,
		`exit ${decision.status}: ${decision.output}`,
	);

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	const stock = await stockVersion(context);
	check(
		"no commit reaches the library's analysis",
		scopedHashes(context).length === 0,
		`${context.commits.length} commit(s) in range, ${scopedHashes(context).length} scoped`,
	);
	check("the scoped analysis answers no release", scoped === null, `release type: ${scoped}`);
	check(
		"the stock plugin would have versioned the library from that commit",
		stock === "patch",
		`stock release type: ${stock}`,
	);
}

// ---- case 2: the library's own fix -------------------------------------------------

console.log("case 2 — a fix touching the library");
{
	const { dir, last } = newScratch("library-fix");
	const sha = commit(dir, "fix(ext-lib): refuse a malformed record by name", {
		[`${PKG_DIR}/src/glob.ts`]: "// library change\n",
	});

	const decision = gateDecision(dir);
	check(
		"the gate releases the library",
		decision.status === 0,
		`exit ${decision.status}: ${decision.output}`,
	);

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	const hashes = scopedHashes(context);
	check("the library's own fix is a patch", scoped === "patch", `release type: ${scoped}`);
	check(
		"that commit is the analysed set",
		hashes.length === 1 && hashes[0] === sha,
		`${hashes.length} of ${context.commits.length} commit(s) scoped`,
	);
}

// ---- case 3: a docs-only library change beside another package's fix ---------------

console.log("case 3 — a docs-only library commit beside another package's fix");
{
	const { dir, last } = newScratch("docs-only");
	const docsSha = commit(dir, "docs(ext-lib): describe the refusal in the API table", {
		[`${PKG_DIR}/README.md`]: "# Shared helpers\n",
	});
	const fleetSha = commit(dir, "fix(fleet): keep loader tools selected", {
		"packages/fleet/index.ts": "// fleet change\n",
	});

	const decision = gateDecision(dir);
	check(
		"the gate opens on the docs commit that touched the library",
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
		"the stock plugin would have released the library on the other package's fix",
		stock === "patch",
		`stock release type: ${stock}`,
	);
}

// ---- case 4: both changed ----------------------------------------------------------

console.log("case 4 — the library and another package both changed");
{
	const { dir, last } = newScratch("both-changed");
	// The notes writer renders a scoped type as "* **ext-lib:** <description>", so the checks
	// read the description and the scope rather than the raw commit subject.
	const libSummary = "refuse a malformed record by name";
	const fleetSummary = "keep loader tools selected";
	commit(dir, `fix(ext-lib): ${libSummary}`, { [`${PKG_DIR}/src/glob.ts`]: "// library change\n" });
	commit(dir, `fix(fleet): ${fleetSummary}`, { "packages/fleet/index.ts": "// fleet change\n" });

	const context = semanticReleaseContext(dir, last);
	const scoped = await scopedVersion(context);
	check(
		"the library's own fix still releases a patch",
		scoped === "patch",
		`release type: ${scoped}`,
	);

	const hashes = scopedHashes(context);
	check(
		"only the library's commit reaches the analysis",
		hashes.length === 1 && subjectOf(dir, hashes[0]).includes(libSummary),
		`scoped ${hashes.map((hash) => hash.slice(0, 8)).join(", ") || "none"}`,
	);

	const notes = await scopedNotes(context);
	check(
		"the changelog carries the library's entry",
		notes.includes(libSummary) && notes.includes("ext-lib"),
		JSON.stringify(notes),
	);
	check(
		"the changelog does not carry the other package's entry",
		!notes.includes(fleetSummary) && !notes.includes("fleet"),
		JSON.stringify(notes),
	);
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
