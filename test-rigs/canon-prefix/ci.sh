#!/usr/bin/env bash
# ci.sh — run the canon-prefix rig in CI and say exactly which harness failed and why.
#
# The rig is four offline harnesses over the canon package's system-prompt seam
# (this directory), quiet and fast: no container, no provider, no pi install. A failure
# here has two different meanings, and this script keeps them apart in the job log and in
# the step summary:
#
#   * RIG FAILURE          — a harness ran and a check failed (run.sh exit 1). A real defect
#                            in the modules under test; the failing harnesses are printed
#                            with their FAIL lines and annotated, one annotation per harness.
#   * PRECONDITION FAILURE — the rig never judged anything (run.sh exit 2): no usable node,
#                            no canon store, a missing harness. Never read as a defect in the
#                            packages.
#
# Bounds: run.sh takes no bound of its own — the four harnesses are node scripts that exit on
# their own — so the workflow job's timeout-minutes is the ceiling that catches a stall.
#
# The output is classified from ONE snapshot of the run's output, so the verdict cannot
# disagree with what the run said. CANON_RIG_CI_STDIN=1 (with CANON_RIG_CI_STATUS=<code>)
# reads that output from stdin instead of running the rig: it exists so every verdict below
# can be exercised without a failing harness.
set -euo pipefail

cd "$(dirname "$0")/../.."
RIG="test-rigs/canon-prefix/run.sh"

status=0

if [ -n "${CANON_RIG_CI_STDIN:-}" ]; then
	log_text="$(cat)"
	status="${CANON_RIG_CI_STATUS:-0}"
else
	log="$(mktemp "${TMPDIR:-/tmp}/pi-extensions-canon-rig-ci.XXXXXX.log")"
	trap 'rm -f "${log}"' EXIT
	echo "running: bash ${RIG}"
	set +e
	bash "${RIG}" 2>&1 | tee "${log}"
	status="${PIPESTATUS[0]}"
	set -e
	echo "${RIG} exited ${status}"
	log_text="$(cat "${log}")"
fi

matching() {
	grep -E "$1" <<<"${log_text}" || true
}

harness_exits="$(matching '^(harness|harness-hooks|harness-chain|freeze-harness): exit ')"
failing_harnesses="$(matching '^(harness|harness-hooks|harness-chain|freeze-harness): exit [^0]')"
harness_failures="$(matching '^[[:space:]]+FAIL  ')"
abort_lines="$(matching '^CANON RIG ABORT: |^CANON RIG PRECONDITION FAILURE: ')"
verdict_line="$(matching '^(CANON RIG PASS|CANON RIG FAILURE): ')"

emit() {
	local label="$1" lines="$2" line
	while IFS= read -r line; do
		if [ -n "${line}" ]; then
			printf -- '- %s: %s\n' "${label}" "${line}"
		fi
	done <<<"${lines}"
}

# The step summary when the runner provides one, else stdout. Never a hard-coded
# /dev/stdout redirect: a caller that closed or replaced its own stdout would turn a
# completed verdict into a shell error, and the exit code must carry the verdict.
summary() {
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		cat >>"${GITHUB_STEP_SUMMARY}" || true
	else
		cat
	fi
}

report() {
	{
		echo "### $1"
		echo
		echo "- exit status: ${status}"
		echo "- ${verdict_line:-<no rig verdict line>}"
		emit "failing harness" "${failing_harnesses}"
		emit "failed check" "${harness_failures}"
		emit "precondition" "${abort_lines}"
		emit "harness override" "${harness_exits}"
	} | summary
}

if [ "${status}" -eq 0 ]; then
	echo "RIG PASS: ${verdict_line:-<no rig verdict line>}"
	report "RIG PASS"
	exit 0
fi

if [ "${status}" -eq 2 ]; then
	echo "PRECONDITION FAILURE: the rig never judged anything — this is not a defect in the" >&2
	echo "modules under test." >&2
	printf '%s\n' "${abort_lines}" | grep -E '[^[:space:]]' | sed 's/^/  /' >&2 || true
	while IFS= read -r line; do
		if [ -n "${line}" ]; then
			echo "::error::${line}"
		fi
	done <<<"${abort_lines}"
	report "PRECONDITION FAILURE — the rig never ran"
	exit 1
fi

if [ "${status}" -ne 1 ]; then
	echo "UNEXPECTED EXIT ${status}: run.sh exits 0 (pass), 1 (harness failure) or 2" >&2
	echo "(precondition) and nothing else." >&2
	report "UNEXPECTED EXIT ${status} — the runner's contract does not cover it"
	exit 1
fi

echo "RIG FAILURE: a harness ran and a check failed." >&2
printf '%s\n' "${failing_harnesses}" "${harness_failures}" "${verdict_line}" |
	grep -E '[^[:space:]]' | sed 's/^/  /' >&2 || true

# One annotation per failing harness, so the pull request names the harness rather than only
# the job. The step summary carries the failed checks too.
while IFS= read -r line; do
	if [ -n "${line}" ]; then
		echo "::error::${line}"
	fi
done <<<"${failing_harnesses}"

report "RIG FAILURE — a harness ran and failed"
exit 1
