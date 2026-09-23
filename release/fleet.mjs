// semantic-release configuration for @tinoy/pi-fleet.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib and tariff, because this package depends on them.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "fleet-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/fleet/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/fleet" }],
		[
			"@semantic-release/git",
			{
				assets: ["packages/fleet/package.json", "packages/fleet/CHANGELOG.md", "package-lock.json"],
				message: "chore(release): fleet ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
