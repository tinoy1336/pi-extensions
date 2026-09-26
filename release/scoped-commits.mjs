// Scope one package's release to that package's own commits.
//
// The two steps that read the commit list — @semantic-release/commit-analyzer (which picks the
// version) and @semantic-release/release-notes-generator (which writes the changelog) — read
// every commit since the package's own tag, and neither takes a path filter. A release for one
// package is therefore versioned and changelogged from another package's commits:
// packages/ext-lib/CHANGELOG.md carries a "fleet: keep loader tools selected" bug-fix entry for
// a range whose only commit touching packages/ext-lib was a docs change.
//
// This plugin hands both steps the commits that touched `dir` — the same git path filter
// scripts/release-relevant.sh gates the release on — so a package's version and its changelog
// describe that package. A release config declares it in place of the two stock plugins:
//
//   { path: "./release/scoped-commits.mjs", dir: "packages/<pkg>" }
//
// The path is resolved against the release process's working directory, which is the repository
// root, and `dir` is repository-root relative, matching release-relevant.sh.
import { execFileSync } from "node:child_process";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

/**
 * The commits from `context.commits` that touched `dir` since the package's last release.
 *
 * `git rev-list <from>..<to> -- <dir>` answers the same question release-relevant.sh asks with
 * `git rev-list --count`, so the gate and the analysis always see one commit set. A missing last
 * release means no tag to measure from, and the whole reachable history is the range.
 *
 * Exported for the probe beside this file, which asserts on the set each step is handed.
 */
export function scopedCommits(dir, context) {
	const from = context.lastRelease?.gitHead;
	const to = context.nextRelease?.gitHead ?? "HEAD";
	const shas = execFileSync("git", ["rev-list", from ? `${from}..${to}` : to, "--", dir], {
		cwd: context.cwd,
		encoding: "utf8",
	});
	const touching = new Set(shas.split("\n").filter(Boolean));
	return context.commits.filter((commit) => touching.has(commit.hash));
}

export default {
	async analyzeCommits(pluginConfig, context) {
		return analyzeCommits(pluginConfig, {
			...context,
			commits: scopedCommits(pluginConfig.dir, context),
		});
	},

	async generateNotes(pluginConfig, context) {
		return generateNotes(pluginConfig, {
			...context,
			commits: scopedCommits(pluginConfig.dir, context),
		});
	},
};
