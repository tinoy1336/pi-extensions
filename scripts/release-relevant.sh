#!/usr/bin/env bash
# Path gate for one package's release.
#
# @semantic-release/commit-analyzer reads every commit since the package's own tag
# and has no path filter, so without this gate a release run for one package would
# also version and publish the other one for commits that never touched it — an
# empty version bump. The gate answers "did anything change in this package since its
# last release tag", which is the question the release job needs before it starts.
#
# Exit 0 = release this package, exit 1 = skip it.
set -euo pipefail

pkg="${1:?usage: release-relevant.sh <ext-lib|canon>}"
dir="packages/${pkg}"
last="$(git describe --tags --abbrev=0 --match "${pkg}-v*" 2>/dev/null || true)"

if [ -z "${last}" ]; then
	echo "relevant: ${dir} has no ${pkg}-v* tag yet"
	exit 0
fi

count="$(git rev-list --count "${last}..HEAD" -- "${dir}")"

if [ "${count}" -eq 0 ]; then
	echo "skip: no commit touched ${dir} since ${last}"
	exit 1
fi

echo "relevant: ${count} commit(s) touched ${dir} since ${last}"
exit 0
