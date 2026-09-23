// semantic-release configuration for @tinoy/pi-nf.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib, because this package depends on it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "nf-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/nf/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/nf" }],
		[
			"@semantic-release/git",
			{
				assets: ["packages/nf/package.json", "packages/nf/CHANGELOG.md", "package-lock.json"],
				message: "chore(release): nf ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
