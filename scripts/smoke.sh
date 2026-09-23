#!/usr/bin/env bash
# Stranger-install smoke test.
#
# Both modes install from `npm pack` output only, so they exercise the published
# payload rather than the checkout beside it:
#
#   (default) build docker/Dockerfile and run it — a clean Node image, a pinned pi
#             release, no source tree. This is what CI runs.
#   --local   the same harness on this machine against the same tarball install, for
#             a machine with no container daemon.
#
# The container engine is `docker` unless CONTAINER_ENGINE names another one.
set -euo pipefail

cd "$(dirname "$0")/.."

mode="${1:---docker}"
work="$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions-smoke.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

echo "packing workspace packages into ${work}/tarballs"
mkdir -p "${work}/tarballs"
timeout 300 npm pack --pack-destination "${work}/tarballs" -w @tinoy/pi-ext-lib -w @tinoy/pi-canon >/dev/null

if [ "${mode}" = "--local" ]; then
	app="${work}/app"
	bash scripts/stranger-install.sh "${app}" "${work}/tarballs"
	cp docker/smoke.mjs "${app}/smoke.mjs"
	echo "running the smoke harness against ${app}"
	# HOME is redirected so the extension's hook-log sink lands in the scratch tree
	# instead of the invoking user's ~/.local/share/pi-hooks.
	cd "${app}"
	HOME="${work}/home" PI_CODING_AGENT_DIR="${work}/agent" timeout 600 node smoke.mjs
	exit 0
fi

engine="${CONTAINER_ENGINE:-docker}"
if ! command -v "${engine}" >/dev/null 2>&1; then
	echo "no container engine '${engine}' on PATH — rerun with --local" >&2
	exit 3
fi
if ! timeout 30 "${engine}" info >/dev/null 2>&1; then
	echo "container engine '${engine}' is not reachable (no daemon) — rerun with --local" >&2
	exit 3
fi

stage="${work}/context"
mkdir -p "${stage}/scripts" "${stage}/docker"
cp -a "${work}/tarballs" "${stage}/tarballs"
cp scripts/stranger-install.sh "${stage}/scripts/stranger-install.sh"
cp docker/Dockerfile docker/smoke.mjs "${stage}/docker/"

timeout 900 "${engine}" build -t pi-extensions-smoke -f "${stage}/docker/Dockerfile" "${stage}"
timeout 600 "${engine}" run --rm pi-extensions-smoke
