// semantic-release configuration for @tinoy/pi-cache-prefix-log.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released with the other dependency-free packages: it imports nothing from this
// repository and nothing here imports it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "cache-prefix-log-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/cache-prefix-log/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/cache-prefix-log" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/cache-prefix-log/package.json",
					"packages/cache-prefix-log/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): cache-prefix-log ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
