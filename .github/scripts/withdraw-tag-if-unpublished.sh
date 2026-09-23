#!/usr/bin/env bash
# Withdraw the tag a failed release step created — unless its version reached the
# registry, in which case the tag is what keeps the next run from cutting it again.
#
# semantic-release creates and pushes the release tag BEFORE it runs the publish
# plugins ("Create the tag before calling the publish plugins as some require the tag
# to exists", semantic-release/lib/index.js), so a publish that fails leaves the tag
# behind and the release job removes it (scripts/withdraw-tag.sh, which owns the
# snapshot diff and the deletion).
#
# That removal is safe only while the version is NOT on the registry. A step that fails
# AFTER `npm publish` succeeded (the release commit's push refused, the GitHub release
# refused) leaves the version published; deleting its tag makes the next run compute
# the same version again from the same commits and fail on "You cannot publish over the
# previously published versions: X" — on every run, with no way out but a manual tag
# push. Keeping the tag ends that: the next release measures from it and cuts the
# following version. The registry is asked before anything is deleted, and a registry
# that cannot be asked at all also keeps the tag — deleting is the irreversible
# direction, and a tag left in place is recoverable.
#
# usage: withdraw-tag-if-unpublished.sh <tags-before-file> <package-name> <tag-prefix>
set -euo pipefail

before="${1:?usage: withdraw-tag-if-unpublished.sh <tags-before-file> <package-name> <tag-prefix>}"
package="${2:?usage: withdraw-tag-if-unpublished.sh <tags-before-file> <package-name> <tag-prefix>}"
prefix="${3:?usage: withdraw-tag-if-unpublished.sh <tags-before-file> <package-name> <tag-prefix>}"

after="${before}.after"
git tag | sort >"${after}"
created="$(comm -13 "${before}" "${after}" || true)"
rm -f "${after}"

if [ -z "${created}" ]; then
	echo "no tag created by this run"
	exit 0
fi

# 0 = the version is on the registry, 1 = the registry says it is absent,
# 2 = the registry could not be asked (or npm is unavailable).
version_state() {
	local spec="$1"
	local out
	if out="$(timeout 60 npm view "${spec}" version 2>&1)"; then
		return 0
	fi
	case "${out}" in
	*E404* | *404*) return 1 ;;
	*) return 2 ;;
	esac
}

withdrawable=1
for tag in ${created}; do
	version="${tag#"${prefix}"}"
	case "${version}" in
	[0-9]*) state=0; version_state "${package}@${version}" || state=$? ;;
	*) state=2 ;;
	esac
	case "${state}" in
	0)
		withdrawable=0
		echo "keeping tag ${tag}: ${package}@${version} is on the registry, so the release reached npm"
		echo "  the tag is what keeps the next run measuring from ${version} instead of cutting it again"
		echo "  fix the cause of the failure and re-run: Actions -> Release -> Run workflow"
		;;
	2)
		withdrawable=0
		echo "keeping tag ${tag}: the registry could not be asked about ${package}@${version}, and deleting is the irreversible direction"
		;;
	*)
		echo "withdrawable tag ${tag}: ${package}@${version} is not on the registry"
		;;
	esac
done

if [ "${withdrawable}" -eq 1 ]; then
	bash scripts/withdraw-tag.sh "${before}"
else
	echo "no tag withdrawn: at least one tag created by this step must stay"
fi
