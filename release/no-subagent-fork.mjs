// semantic-release configuration for @tinoy/pi-no-subagent-fork.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released with the other dependency-free packages: it imports nothing from this
// repository and nothing here imports it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "no-subagent-fork-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/no-subagent-fork/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/no-subagent-fork" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/no-subagent-fork/package.json",
					"packages/no-subagent-fork/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): no-subagent-fork ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
