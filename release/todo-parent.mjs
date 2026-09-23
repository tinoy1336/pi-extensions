// semantic-release configuration for @tinoy/pi-todo-parent.
//
// Same shape as release/ext-lib.mjs, and for the same reasons: run from the repository
// root so the workspace lockfile is inside the release commit, and point `pkgRoot` at the
// package. Released after ext-lib, because this package depends on it.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: semantic-release fills its
// placeholders itself.
export default {
	branches: ["main"],
	tagFormat: "todo-parent-v${version}",
	plugins: [
		["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
		["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
		["@semantic-release/changelog", { changelogFile: "packages/todo-parent/CHANGELOG.md" }],
		["@semantic-release/npm", { pkgRoot: "packages/todo-parent" }],
		[
			"@semantic-release/git",
			{
				assets: [
					"packages/todo-parent/package.json",
					"packages/todo-parent/CHANGELOG.md",
					"package-lock.json",
				],
				message:
					"chore(release): todo-parent ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		"@semantic-release/github",
	],
};
