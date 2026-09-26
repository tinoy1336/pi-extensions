// semantic-release configuration for @tinoy/pi-focus-gate.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib and focus-state, because this package depends on them.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "focus-gate-v${version}",
	plugins: [
		// Both stock steps read every commit since the package's own tag and take no
		// path filter; the scoped plugin hands them this package's own commits instead
		// (release/scoped-commits.mjs).
		{
			path: "./release/scoped-commits.mjs",
			dir: "packages/focus-gate",
			preset: "conventionalcommits",
		},
		["@semantic-release/changelog", { changelogFile: "packages/focus-gate/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/focus-gate" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/focus-gate/package.json",
					"packages/focus-gate/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): focus-gate ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
