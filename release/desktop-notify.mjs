// semantic-release configuration for @tinoy/pi-desktop-notify.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib and focus-state, because this package depends on them.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "desktop-notify-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/desktop-notify/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/desktop-notify" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/desktop-notify/package.json",
					"packages/desktop-notify/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): desktop-notify ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
