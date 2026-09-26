// semantic-release configuration for @tinoy/pi-drift-anchor.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib, because this package depends on it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "drift-anchor-v${version}",
	plugins: [
		// Both stock steps read every commit since the package's own tag and take no
		// path filter; the scoped plugin hands them this package's own commits instead
		// (release/scoped-commits.mjs).
		{
			path: "./release/scoped-commits.mjs",
			dir: "packages/drift-anchor",
			preset: "conventionalcommits",
		},
		["@semantic-release/changelog", { changelogFile: "packages/drift-anchor/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/drift-anchor" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/drift-anchor/package.json",
					"packages/drift-anchor/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): drift-anchor ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
