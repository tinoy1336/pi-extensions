// semantic-release configuration for @tinoy/pi-focus-state.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released before the units that import it: a dependent cannot be installed from
// the registry until its dependency is published.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "focus-state-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/focus-state/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/focus-state" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/focus-state/package.json",
					"packages/focus-state/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): focus-state ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
