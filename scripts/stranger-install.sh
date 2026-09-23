#!/usr/bin/env bash
# Install the packed packages the way a stranger does.
#
# Target directory is emptied and rebuilt: a plain `package.json`, a pinned pi release
# from the registry, then the two `npm pack` tarballs. No workspace, no source tree,
# no monorepo root — so whatever this installs is what the registry serves, and the
# package's `files` list is exercised for real (a module the list omits is missing
# here, not hidden by the checkout beside it).
#
# The pinned pi version matches the version the repository compiles its types
# against (root package.json devDependencies).
set -euo pipefail

app="${1:?usage: stranger-install.sh <app-dir> <tarball-dir> [pi-version]}"
tarballs="${2:?usage: stranger-install.sh <app-dir> <tarball-dir> [pi-version]}"
pi_version="${3:-0.86.1}"

case "${app}" in
/ | "" | /home | "${HOME}")
	echo "refusing to empty ${app}" >&2
	exit 2
	;;
esac

ext_lib_tarball="$(echo "${tarballs}"/tinoy-pi-ext-lib-*.tgz)"
canon_tarball="$(echo "${tarballs}"/tinoy-pi-canon-*.tgz)"
for tarball in ${ext_lib_tarball} ${canon_tarball}; do
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
timeout 900 npm install --no-audit --no-fund "@earendil-works/pi-coding-agent@${pi_version}"
# shellcheck disable=SC2086
timeout 900 npm install --no-audit --no-fund ${ext_lib_tarball} ${canon_tarball}

node -e '
	const fs = require("node:fs");
	const root = process.cwd();
	const read = (name) =>
		JSON.parse(fs.readFileSync(`${root}/node_modules/${name}/package.json`, "utf8"));
	console.log(
		`installed: ${read("@tinoy/pi-canon").name}@${read("@tinoy/pi-canon").version}, ` +
			`${read("@tinoy/pi-ext-lib").name}@${read("@tinoy/pi-ext-lib").version}, ` +
			`pi ${read("@earendil-works/pi-coding-agent").version}`,
	);
'
