#!/usr/bin/env bash
# Preview what the next release would publish, without publishing or tagging.
#
# Same gate the release job uses (scripts/release-relevant.sh), so a package with no
# commits since its tag is reported as skipped here exactly as CI would skip it.
# `--dry-run` makes semantic-release log the tag, the notes and the publish steps and
# create nothing; `--no-ci` is what lets it run from a laptop.
set -euo pipefail

cd "$(dirname "$0")/.."

for pkg in ext-lib canon; do
	echo "=== ${pkg} ==="
	if bash scripts/release-relevant.sh "${pkg}"; then
		timeout 180 npx --no-install semantic-release --extends "./release/${pkg}.mjs" --dry-run --no-ci
	else
		echo "(gate: nothing to release)"
	fi
done
