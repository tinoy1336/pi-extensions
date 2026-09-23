#!/usr/bin/env bash
# The subset matrix: does an install of SOME packages load cleanly, with the right tools
# and the right reports about what is missing?
#
# Both modes install from `npm pack` output only, so the matrix judges the published
# payloads rather than the checkout beside them:
#
#   (default) build the matrix stage of docker/Dockerfile and run it — a clean Node image,
#             a pinned pi release, no source tree. This is what CI runs.
#   --local   the same runner on this machine against the same tarball installs, for a
#             machine with no container daemon.
#
#   --case ID may follow in either mode and narrows the run to one case.
#
# The container engine is `docker` unless CONTAINER_ENGINE names another one.
set -euo pipefail

cd "$(dirname "$0")/.."

mode="--docker"
if [ "${1:-}" = "--local" ] || [ "${1:-}" = "--docker" ]; then
	mode="${1}"
	shift
fi
case_args=()
while [ "$#" -gt 0 ]; do
	case "${1}" in
	--case)
		case_args+=("--case" "${2:?--case needs an id}")
		shift 2
		;;
	*)
		echo "unknown argument: ${1}" >&2
		exit 2
		;;
	esac
done

work="$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions-matrix.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

# Every workspace package is packed, so a package added later is in the matrix without
# this script being edited.
echo "packing the workspace packages into ${work}/tarballs"
mkdir -p "${work}/tarballs"
timeout 300 npm pack --pack-destination "${work}/tarballs" --workspaces >/dev/null

if [ "${mode}" = "--local" ]; then
	echo "running the matrix against the local tarball installs"
	timeout 3600 node docker/matrix.mjs --tarballs "${work}/tarballs" --workspace "$(pwd)" "${case_args[@]+"${case_args[@]}"}"
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

# The build context mirrors the repository layout: the runner resolves
# scripts/stranger-install.sh relative to its own parent directory inside the image.
stage="${work}/context"
mkdir -p "${stage}/scripts" "${stage}/docker"
cp -a "${work}/tarballs" "${stage}/tarballs"
cp scripts/stranger-install.sh "${stage}/scripts/stranger-install.sh"
cp docker/matrix.mjs docker/matrix.json "${stage}/docker/"

timeout 900 "${engine}" build -t pi-extensions-matrix --target matrix -f docker/Dockerfile "${stage}"
timeout 3600 "${engine}" run --rm pi-extensions-matrix "${case_args[@]+"${case_args[@]}"}"
