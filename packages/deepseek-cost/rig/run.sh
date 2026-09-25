#!/usr/bin/env bash
# run.sh — the deepseek-cost footer-remainder harness, from any checkout.
#
# One node script over this package's exported label helpers
# (`remainingLabel`, `windowAt`, `windowLabel`). No container, no provider, no pi
# install, no agent dir and no writes: the helpers take the instant they price, so
# the harness is a pure-function check of the string the footer shows.
#
# Exit codes, so a caller can keep the two failure classes apart:
#   0  every check passed
#   1  a check FAILED (its FAIL lines are printed) — a real defect in the labels
#   2  a precondition is unmet (no usable node, no module under test) — the rig
#      never judged anything, so this must never be read as a passing suite
#
# The harness exits on its own; COST_RIG_TIMEOUT is the ceiling that catches a stall.
set -uo pipefail

RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOUND="${COST_RIG_TIMEOUT:-120}"

abort() {
	printf 'COST RIG PRECONDITION FAILURE: %s\n' "$1" >&2
	exit 2
}

command -v node >/dev/null 2>&1 ||
	abort "node is not on PATH; the harness needs node --experimental-strip-types (node >= 22.6)."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)' ||
	abort "node $(node -v) is too old for --experimental-strip-types (needs node >= 22.6)."
[ -f "${RIG_DIR}/harness.ts" ] || abort "missing harness ${RIG_DIR}/harness.ts"

LOG="$(mktemp "${TMPDIR:-/tmp}/deepseek-cost-rig-XXXXXX.log")" || abort "mktemp failed"
timeout "${BOUND}" node --experimental-strip-types "${RIG_DIR}/harness.ts" 2>&1 | tee "${LOG}"
status="${PIPESTATUS[0]}"

if [ "${status}" -eq 0 ]; then
	rm -f "${LOG}"
	exit 0
fi

if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
	printf 'COST RIG PRECONDITION FAILURE: the harness did not finish within %ss\n' "${BOUND}" >&2
	exit 2
fi

if [ "${status}" -eq 2 ]; then
	printf 'harness log kept: %s\n' "${LOG}" >&2
	exit 2
fi

printf 'harness log kept: %s\n' "${LOG}" >&2
printf 'COST RIG FAILURE: the harness judged the labels and a check failed\n' >&2
exit 1
