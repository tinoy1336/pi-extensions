#!/usr/bin/env bash
# Run the subset matrix in CI and say exactly what failed.
#
# The matrix runs in the container stage of docker/Dockerfile, with the tarball installs the
# runner stages itself (scripts/smoke-matrix.sh). CI is where the container path runs for the
# first time — every case on this machine has only ever run through `--local`, which shares
# the runner and the installer but no image — so a failure has three different meanings and
# this script keeps them apart in the job log and in the step summary:
#
#   * MATRIX FAILURE    — the runner ran and a case violated a clause. This is a real package
#                         defect; the failing cases and their clause numbers are printed and
#                         annotated, one annotation per case.
#   * CONTAINER FAILURE — the image did not build or the container did not start, or the
#                         runner's `matrix: N case(s) from …` banner never appeared, so the
#                         cases were never judged. Never read as a package defect.
#   * ENGINE ABSENT     — no container engine, or no daemon (scripts/smoke-matrix.sh exit 3).
#   * RUNNER USAGE      — the runner rejected its own arguments (exit 2), which is neither.
#   * MATRIX VACUOUS    — the run did not judge every case it declares (scripts/smoke-matrix.sh
#                         exit 4): the workspace carried no packages, or package-naming cases were
#                         skipped for absence of packages. A run that judged almost nothing must
#                         never read as a pass, and it is not a package defect either.
#
# Bounds are explicit and layered: the job carries a timeout ceiling, scripts/smoke-matrix.sh
# bounds the image build and the container run, and this script adds none of its own, so the
# phase that ran out of time is always the phase that reports it.
#
# The output is classified from ONE snapshot of the run's output, so the verdicts cannot
# disagree with each other about what the run said. SMOKE_MATRIX_CI_STDIN=1 (with
# SMOKE_MATRIX_CI_STATUS=<code>) reads that output from stdin instead of running the matrix:
# it exists so every verdict below can be exercised without a container engine.
set -euo pipefail

cd "$(dirname "$0")/../.."

status=0

if [ -n "${SMOKE_MATRIX_CI_STDIN:-}" ]; then
	log_text="$(cat)"
	status="${SMOKE_MATRIX_CI_STATUS:-0}"
else
	log="$(mktemp "${TMPDIR:-/tmp}/pi-extensions-matrix-ci.XXXXXX.log")"
	trap 'rm -f "${log}"' EXIT
	echo "running: npm run smoke:matrix (container stage)"
	set +e
	npm run smoke:matrix 2>&1 | tee "${log}"
	status="${PIPESTATUS[0]}"
	set -e
	echo "smoke:matrix exited ${status}"
	log_text="$(cat "${log}")"
fi

matching() {
	grep -E "$1" <<<"${log_text}" || true
}

failing_cases="$(matching '^[^[:space:]]+  CASE FAIL')"
harness_failures="$(matching '^[[:space:]]+FAIL  (harness|probe) ')"
clause_failures="$(matching '^[[:space:]]+clause [1-5]  FAIL')"
summary_line="$(matching '^matrix summary:' | tail -1)"
runner_banner="$(matching '^matrix: [0-9]+ case\(s\) from ' | tail -1)"
vacuous_skips="$(matching '^[[:space:]]+skipped: ')"

emit() {
	local label="$1" lines="$2" line
	while IFS= read -r line; do
		if [ -n "${line}" ]; then
			printf -- '- %s: %s\n' "${label}" "${line}"
		fi
	done <<<"${lines}"
}

report() {
	{
		echo "### $1"
		echo
		echo "- exit status: ${status}"
		echo "- runner banner: ${runner_banner:-<none — the cases were never judged>}"
		echo "- ${summary_line:-<no matrix summary line>}"
		emit "failing case" "${failing_cases}"
		emit "failing clause" "${clause_failures}"
		emit "harness/probe" "${harness_failures}"
		emit "skipped case" "${vacuous_skips}"
	} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"
}

if [ "${status}" -eq 0 ]; then
	echo "MATRIX PASS: ${summary_line:-<no matrix summary line>}"
	report "MATRIX PASS"
	exit 0
fi

if [ "${status}" -eq 3 ]; then
	echo "ENGINE ABSENT: the matrix needs a container engine and none answered" >&2
	matching "no container engine|is not reachable" >&2
	report "ENGINE ABSENT — the container path did not run (no engine)"
	exit 1
fi

# Exit 4 is the wrapper's verdict that the run did not judge every case it declares. It must be
# read BEFORE the banner test, because a vacuous run does print a banner and would otherwise
# fall through to the clause-failure class — which states a fact that is not true, since no case
# violated a clause.
if [ "${status}" -eq 4 ]; then
	echo "MATRIX VACUOUS: the run did not judge every case it declares — the workspace carried no" >&2
	echo "packages, or package-naming cases were skipped for absence of packages. The skipped cases" >&2
	echo "are listed below; this is not a package defect." >&2
	matching '^workspace: |MATRIX VACUOUS' >&2
	printf '%s\n' "${vacuous_skips}" >&2
	report "MATRIX VACUOUS — the run did not judge every case it declares"
	exit 1
fi

if [ "${status}" -eq 2 ]; then
	echo "RUNNER USAGE ERROR: the runner rejected its arguments" >&2
	report "RUNNER USAGE ERROR — the runner rejected its arguments"
	exit 1
fi

if [ -z "${runner_banner}" ]; then
	echo "CONTAINER FAILURE: the image did not build or the container did not start, so the" >&2
	echo "cases were never judged — this is not a package defect." >&2
	matching 'ERROR|error:|failed to solve|Cannot connect|not reachable' >&2
	report "CONTAINER FAILURE — no runner banner; the cases were never judged"
	exit 1
fi

if [ "${status}" -eq 2 ]; then
	echo "RUNNER USAGE ERROR: the runner rejected its arguments" >&2
	report "RUNNER USAGE ERROR — the runner rejected its arguments"
	exit 1
fi

echo "MATRIX FAILURE: the runner ran and a case violated a clause." >&2
printf '%s\n' "${failing_cases}" "${harness_failures}" "${clause_failures}" "${summary_line}" |
	grep -E '[^[:space:]]' | sed 's/^/  /' >&2 || true

# One annotation per failing case, so the pull request names the case and its clause rather
# than only the job. The summary carries the clauses and the harness failures too.
while IFS= read -r line; do
	if [ -n "${line}" ]; then
		echo "::error::${line}"
	fi
done <<<"${failing_cases}"

report "MATRIX FAILURE — a case violated a clause"
exit 1
