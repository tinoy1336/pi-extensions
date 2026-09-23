// semantic-release configuration for @tinoy/pi-canon.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the
// repository root so the workspace lockfile is inside the release commit, and point
// `pkgRoot` at the package. Released after ext-lib in the release job, because this
// package depends on it.
export default {
	branches: ["main"],
	// biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release fills this placeholder itself
	tagFormat: "canon-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/canon/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/canon" }],
		[
			"@semantic-release/git",
			{
				assets: ["packages/canon/package.json", "packages/canon/CHANGELOG.md", "package-lock.json"],
				// biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release fills these placeholders itself
				message: "chore(release): canon ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
