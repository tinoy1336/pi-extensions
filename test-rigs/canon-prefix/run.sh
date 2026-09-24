#!/usr/bin/env bash
# run.sh — run the five offline canon-prefix harnesses from any checkout.
#
# The harnesses render their fixture block FROM a canon store, which the module under test
# reads from `$PI_CODING_AGENT_DIR/canon/canon.json` (the extension's own rule — there is no
# rig-only store variable). With no agent dir supplied this runner seeds a scratch prefix
# from `fixtures/canon.json` (or $CANON_RIG_STORE) and points PI_CODING_AGENT_DIR at it, so
# no harness needs this machine's agent dir and none can write the user's real one. An
# already-exported PI_CODING_AGENT_DIR is used as given, which is the shape `RIG_SOURCE=installed`
# needs (that source reads a pi install's extensions and npm tree out of the agent dir).
#
# Exit codes, so a caller can keep the two failure classes apart:
#   0  every harness passed
#   1  at least one harness FAILED (named below, with its FAIL lines)
#   2  a precondition is unmet (no usable node, missing store or harness) — the rig never
#      ran, so this must never be read as a passing suite
set -uo pipefail

HARNESSES=(harness harness-hooks harness-chain freeze-harness harness-fleet)
RIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE="${CANON_RIG_STORE:-${RIG_DIR}/fixtures/canon.json}"

abort() {
	printf 'CANON RIG ABORT: %s\n' "$1" >&2
	exit 2
}

command -v node >/dev/null 2>&1 ||
	abort "node is not on PATH; the harnesses need node --experimental-strip-types (node >= 22.6)."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)' ||
	abort "node $(node -v) is too old for --experimental-strip-types (needs node >= 22.6)."
for harness in "${HARNESSES[@]}"; do
	[ -f "${RIG_DIR}/${harness}.ts" ] || abort "missing harness ${RIG_DIR}/${harness}.ts"
done

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/canon-rig-XXXXXX")" || abort "mktemp failed"
SCRATCH=""
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
	printf 'agent dir: %s (supplied)\n' "${PI_CODING_AGENT_DIR}"
else
	SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/canon-rig-agent-XXXXXX")" || abort "mktemp failed"
	[ -f "${STORE}" ] ||
		abort "no canon store at ${STORE}; pass CANON_RIG_STORE=<file> or keep fixtures/canon.json."
	mkdir -p "${SCRATCH}/canon"
	cp "${STORE}" "${SCRATCH}/canon/canon.json" || abort "could not seed the scratch store ${SCRATCH}/canon/canon.json"
	export PI_CODING_AGENT_DIR="${SCRATCH}"
	printf 'agent dir: %s (scratch, store %s)\n' "${SCRATCH}" "${STORE}"
fi

failed=()
aborted=()
for harness in "${HARNESSES[@]}"; do
	out="${LOGDIR}/${harness}.log"
	node --experimental-strip-types "${RIG_DIR}/${harness}.ts" >"${out}" 2>&1
	code=$?
	printf '%s: exit %d\n' "${harness}" "${code}"
	if [ "${code}" -eq 2 ]; then
		aborted+=("${harness}")
		grep -E '^RIG ABORT' "${out}" | sed 's/^/  /' || true
	elif [ "${code}" -ne 0 ]; then
		failed+=("${harness}")
		grep -E '^FAIL' "${out}" | head -20 | sed 's/^/  /' || true
	fi
done

if [ "${#failed[@]}" -eq 0 ] && [ "${#aborted[@]}" -eq 0 ]; then
	rm -rf "${LOGDIR}"
	[ -n "${SCRATCH}" ] && rm -rf "${SCRATCH}"
	printf 'CANON RIG PASS: %d/%d harnesses passed\n' "${#HARNESSES[@]}" "${#HARNESSES[@]}"
	exit 0
fi

printf 'harness logs kept: %s\n' "${LOGDIR}" >&2
[ -n "${SCRATCH}" ] && printf 'scratch agent dir kept: %s\n' "${SCRATCH}" >&2
if [ "${#aborted[@]}" -ne 0 ]; then
	printf 'CANON RIG PRECONDITION FAILURE: %s aborted before judging anything\n' "${aborted[*]}" >&2
	exit 2
fi
printf 'CANON RIG FAILURE: %d/%d harnesses failed: %s\n' "${#failed[@]}" "${#HARNESSES[@]}" "${failed[*]}" >&2
exit 1
