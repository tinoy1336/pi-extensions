// semantic-release configuration for @tinoy/pi-ipc.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository root so
// the workspace lockfile is inside the release commit, and point `pkgRoot` at the package.
// Released after ext-lib, because this package depends on it.
//
// The release config declares release/scoped-commits.mjs in place of the stock commit-analyzer
// and release-notes-generator: both of those read every commit since the package's tag, so a
// version cut here could carry another package's change in its changelog.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its own placeholders.
export default {
	branches: ["main"],
	tagFormat: "ipc-v${version}",
	plugins: [
		{ path: "./release/scoped-commits.mjs", dir: "packages/ipc", preset: "conventionalcommits" },
		["@semantic-release/changelog", { changelogFile: "packages/ipc/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/ipc" }],
		[
			"@semantic-release/git",
			{
				assets: ["packages/ipc/package.json", "packages/ipc/CHANGELOG.md", "package-lock.json"],
				message: "chore(release): ipc ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
