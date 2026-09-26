// semantic-release configuration for @tinoy/pi-ext-lib.
//
// Run from the repository root (`semantic-release --extends release/ext-lib.mjs`).
// The working directory stays at the root on purpose: the workspace lockfile lives
// there, and @semantic-release/git commits the paths it is given relative to the
// working directory — a release run inside `packages/ext-lib` would leave the root
// lockfile modified but uncommitted, and the next `npm ci` would then fail on a
// lockfile that disagrees with the package manifests. `pkgRoot` points the npm
// plugin at the package itself.
//
// The tag format is per package: each package carries its own version lineage.
export default {
	branches: ["main"],
	// biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release fills this placeholder itself
	tagFormat: "ext-lib-v${version}",
	plugins: [
		// The stock commit-analyzer and release-notes-generator read every commit since the tag;
		// this one reads only the commits that touched the library (release/scoped-commits.mjs).
		{
			path: "./release/scoped-commits.mjs",
			dir: "packages/ext-lib",
			preset: "conventionalcommits",
		},
		["@semantic-release/changelog", { changelogFile: "packages/ext-lib/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/ext-lib" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/ext-lib/package.json",
					"packages/ext-lib/CHANGELOG.md",
					"package-lock.json",
				],
				// biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release fills these placeholders itself
				message: "chore(release): ext-lib ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
