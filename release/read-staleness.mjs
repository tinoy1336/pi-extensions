// semantic-release configuration for @tinoy/pi-read-staleness.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib, because this package depends on it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "read-staleness-v${version}",
	plugins: [
		// Both stock steps read every commit since the package's own tag and take no
		// path filter; the scoped plugin hands them this package's own commits instead
		// (release/scoped-commits.mjs).
		{
			path: "./release/scoped-commits.mjs",
			dir: "packages/read-staleness",
			preset: "conventionalcommits",
		},
		["@semantic-release/changelog", { changelogFile: "packages/read-staleness/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/read-staleness" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/read-staleness/package.json",
					"packages/read-staleness/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): read-staleness ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
