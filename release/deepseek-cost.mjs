// semantic-release configuration for @tinoy/pi-deepseek-cost.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib and tariff, because this package depends on them.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "deepseek-cost-v${version}",
	plugins: [
		// Both stock steps read every commit since the package's own tag and take no
		// path filter; the scoped plugin hands them this package's own commits instead
		// (release/scoped-commits.mjs).
		{
			path: "./release/scoped-commits.mjs",
			dir: "packages/deepseek-cost",
			preset: "conventionalcommits",
		},
		["@semantic-release/changelog", { changelogFile: "packages/deepseek-cost/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/deepseek-cost" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/deepseek-cost/package.json",
					"packages/deepseek-cost/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): deepseek-cost ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
