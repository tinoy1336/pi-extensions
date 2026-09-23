// semantic-release configuration for @tinoy/pi-intercom-broadcast.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib, because this package depends on it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "intercom-broadcast-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/intercom-broadcast/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/intercom-broadcast" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/intercom-broadcast/package.json",
					"packages/intercom-broadcast/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): intercom-broadcast ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
