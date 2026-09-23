#!/usr/bin/env bash
# Delete every git tag that appeared during a failed release step.
#
# semantic-release creates and pushes the release tag BEFORE it runs the publish
# plugins ("Create the tag before calling the publish plugins as some require the tag
# to exists", semantic-release/lib/index.js), so a publish that then fails leaves the
# tag and its GitHub-visible ref behind. The release job snapshots `git tag` before a
# package's release step and calls this script with that snapshot when the step fails:
# the difference is exactly what the step created, and nothing a previous successful
# step created is touched.
set -euo pipefail

before="${1:?usage: withdraw-tag.sh <tags-before-file>}"
after="${before}.after"

git tag | sort >"${after}"
created="$(comm -13 "${before}" "${after}" || true)"
rm -f "${after}"

if [ -z "${created}" ]; then
	echo "no tag created by this run"
	exit 0
fi

for tag in ${created}; do
	echo "withdrawing tag ${tag}"
	git push origin ":refs/tags/${tag}" || true
	git tag -d "${tag}" || true
done
