#!/usr/bin/env bash
# Run every package probe that is deterministic and self-contained.
#
# The failure this script exists for: nine check surfaces had accumulated beside the
# packages and nothing invoked any of them. `npm run typecheck` and `biome` pass while a
# decision inside a package drifts, because those decisions live in pure functions and
# recorders that no workspace gate reads — a scope filter that stops excluding a model,
# a gate whose pattern list stops matching, a repair that drops the wrong message. Each
# probe runs its module the way pi does and fails on its own; this is what makes that
# failure reach a merge.
#
# Shape: one `timeout` per probe, the probe's own output streamed, and any failure
# counted and reported at the end. A probe that exits non-zero fails the run; there is
# no partial credit and no retry. The bound is generous (a probe that spawns peers needs
# a few seconds) and a timeout is reported as a PROBE TIMED OUT row rather than a
# package defect.
#
# NOT RUN HERE, each because another job already owns it:
#   packages/deepseek-cost/rig/harness.ts  — the cost rig; CI job `cost-rig`
#                                            (`bash packages/deepseek-cost/rig/run.sh`)
#   test-rigs/canon-prefix/harness.ts      — the prompt rig; CI job `canon-rig`
#                                            (`bash test-rigs/canon-prefix/ci.sh`)
#
# MACHINE-BOUND PACKAGES, which is why no probe for them is in the list: a probe for one
# of these would have to be skipped here as well, so each is named with what it needs
# before anyone writes it. `nf`'s `sheet` needs python3 with Pillow; `desktop-notify`
# and `cli-keys` need a stub binary on PATH for the spawn they drive; `sudo-approve`
# needs a live `promptd` window and root; `todo-parent` needs a live parent session and
# the rpiv-todo reducer; `probe`'s compositor branch needs a running compositor. Every
# package in that list is reachable through a recorder for the part of it that does not
# touch the machine — the day one of them grows a probe, add it here and say in its
# header what it needs.
#
# `image-read` IS in the list: it needs the `magick` binary, which the runner's standard
# image ships, and it synthesises its own fixture under a scratch directory rather than
# opening any picture that belongs to anyone. On a machine without ImageMagick it fails
# with the tool's own install message, which is the actionable answer rather than a
# silent skip.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOUND="${PROBE_TIMEOUT:-120}"

abort() {
	printf 'PROBE RUNNER PRECONDITION FAILURE: %s\n' "$1" >&2
	exit 2
}

command -v node >/dev/null 2>&1 ||
	abort "node is not on PATH; the probes need node --experimental-strip-types (node >= 22.6)."
command -v timeout >/dev/null 2>&1 || abort "timeout is not on PATH (coreutils)."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)' ||
	abort "node $(node -v) is too old for --experimental-strip-types (needs node >= 22.6)."

# Every probe file in the workspace, in package order. Each is standalone: it sets the
# scratch directory it needs before importing its module, so none of them reads or
# writes the machine's own agent tree, runtime directory or diagnostics log.
PROBES=(
	packages/build/index.probe.ts
	packages/canon/index.probe.ts
	packages/child-prompt-freeze/index.probe.ts
	packages/child-request-dump/index.probe.ts
	packages/command-guard/command-guard.probe.ts
	packages/ext-lib/src/ipc.probe.ts
	packages/ext-lib/src/neighbour.probe.ts
	packages/ext-lib/src/system-prompt.probe.ts
	packages/ext-lib/src/tool-header.probe.ts
	packages/fleet/retire.probe.ts
	packages/focus-gate/index.probe.ts
	packages/focus-state/focus-state.probe.ts
	packages/image-read/index.probe.ts
	packages/io-guard/identity.probe.ts
	packages/ipc/handshake.probe.ts
	packages/ipc/tool-text.probe.ts
	packages/orphan-repair/index.probe.ts
	packages/pause/pause-state.probe.ts
	packages/read-staleness/index.probe.ts
	packages/status-metrics/index.probe.ts
	packages/tariff/tariff.probe.ts
)

failed=0
ran=0

for probe in "${PROBES[@]}"; do
	[ -f "${ROOT}/${probe}" ] || abort "missing probe ${probe} — the list and the tree disagree."
	printf '\n==== %s\n' "${probe}"
	ran=$((ran + 1))
	timeout "${BOUND}" node --experimental-strip-types "${ROOT}/${probe}"
	status=$?
	if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
		printf 'PROBE TIMED OUT after %ss: %s\n' "${BOUND}" "${probe}" >&2
		failed=$((failed + 1))
	elif [ "${status}" -ne 0 ]; then
		printf 'PROBE FAILED (exit %s): %s\n' "${status}" "${probe}" >&2
		failed=$((failed + 1))
	fi
done

printf '\n'
if [ "${failed}" -gt 0 ]; then
	printf 'PROBE RUN FAILURE: %s of %s probes failed\n' "${failed}" "${ran}" >&2
	exit 1
fi
printf 'ALL %s PROBES PASSED\n' "${ran}"
