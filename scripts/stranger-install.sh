#!/usr/bin/env bash
# Install the packed packages the way a stranger does.
#
# Target directory is emptied and rebuilt: a plain `package.json`, a pinned pi release
# from the registry, then every `npm pack` tarball in the tarball directory. No workspace,
# no source tree, no monorepo root — so whatever this installs is what the registry
# serves, and the package's `files` list is exercised for real (a module the list omits is
# missing here, not hidden by the checkout beside it).
#
# The tarball directory decides the set: every `*.tgz` in it is installed, sorted by name.
# An EMPTY directory is legal and installs the pinned pi release alone — the case a
# harness uses to load its own fixtures with no package installed.
#
# The pinned pi version matches the version the repository compiles its types
# against (root package.json devDependencies).
set -euo pipefail

app="${1:?usage: stranger-install.sh <app-dir> <tarball-dir> [pi-version]}"
tarball_dir="${2:?usage: stranger-install.sh <app-dir> <tarball-dir> [pi-version]}"
pi_version="${3:-0.86.1}"
pi_package="@earendil-works/pi-coding-agent"

case "${app}" in
/ | "" | /home | "${HOME}")
	echo "refusing to empty ${app}" >&2
	exit 2
	;;
esac

# An empty directory is a legal set; a directory that is not there at all is not.
if [ ! -d "${tarball_dir}" ]; then
	echo "missing tarball directory: ${tarball_dir}" >&2
	exit 2
fi

# A glob, not `find`: a harness stages its tarballs as symlinks into the directory and
# `find -type f` skips those. Sorted so the install arguments do not depend on the
# directory listing order of the filesystem.
shopt -s nullglob
matches=("${tarball_dir}"/*.tgz)
shopt -u nullglob
tarballs=()
if [ "${#matches[@]}" -gt 0 ]; then
	while IFS= read -r tarball; do
		tarballs+=("${tarball}")
	done < <(printf '%s\n' "${matches[@]}" | LC_ALL=C sort)
fi

for tarball in "${tarballs[@]}"; do
	if [ ! -f "${tarball}" ]; then
		echo "missing tarball: ${tarball}" >&2
		exit 2
	fi
done

rm -rf "${app}"
mkdir -p "${app}"
cd "${app}"

cat >package.json <<'EOF'
{
	"name": "stranger-app",
	"private": true,
	"type": "module"
}
EOF

# pi first: the packages declare pi's own modules as peer dependencies, and a peer
# already present in the tree is satisfied from it instead of being fetched twice.
timeout 900 npm install --no-audit --no-fund "${pi_package}@${pi_version}"
# One install of the whole set, so the packages resolve against each other in a single
# tree. `npm install` with no argument is a different operation — it re-resolves the
# existing tree — so an empty set skips the step.
if [ "${#tarballs[@]}" -gt 0 ]; then
	timeout 900 npm install --no-audit --no-fund "${tarballs[@]}"
fi

PI_PACKAGE="${pi_package}" node -e '
	const fs = require("node:fs");
	const root = process.cwd();
	const read = (name) =>
		JSON.parse(fs.readFileSync(`${root}/node_modules/${name}/package.json`, "utf8"));
	const piPackage = process.env.PI_PACKAGE;
	const manifest = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
	// The installed tarballs are the dependencies npm recorded a local path for; pi is
	// the registry dependency beside them.
	const packages = Object.keys(manifest.dependencies)
		.filter((name) => name !== piPackage)
		.sort()
		.map((name) => `${read(name).name}@${read(name).version}`);
	console.log(`installed: ${[...packages, `pi ${read(piPackage).version}`].join(", ")}`);
'
