// semantic-release configuration for @tinoy/pi-pause.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib, because this package depends on it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "pause-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/pause/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/pause" }],
		[
			"@semantic-release/git",
			{
				assets: ["packages/pause/package.json", "packages/pause/CHANGELOG.md", "package-lock.json"],
				message: "chore(release): pause ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
