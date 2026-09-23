# ---- matrix stage: the subset matrix --------------------------------------------
#
# Does an install of SOME packages load cleanly? Build it by name:
#
#   docker build --target matrix -f docker/Dockerfile <context>
#   docker run --rm pi-extensions-matrix [--case <id>]
#
# A separate stage, and it is NOT the last one: the smoke stage below stays the default
# build target, so scripts/smoke.sh keeps building the image it always did. The layout
# inside the image mirrors the repository, because the runner resolves
# scripts/stranger-install.sh relative to its own parent directory.
FROM node:22-bookworm-slim AS matrix

ARG PI_VERSION=0.86.1

WORKDIR /work
COPY tarballs/ /tarballs/
COPY scripts/stranger-install.sh /work/scripts/stranger-install.sh
COPY docker/matrix.mjs /work/docker/matrix.mjs
COPY docker/matrix.json /work/docker/matrix.json
ENV PI_VERSION=${PI_VERSION}
ENTRYPOINT ["node", "/work/docker/matrix.mjs", "--tarballs", "/tarballs"]

# ---- stranger-install smoke test -------------------------------------------------
#
# A clean Node image, a pinned pi release, and the packages installed from the
# `npm pack` tarballs staged at /tarballs — nothing from the source tree. The image
# exists to catch one failure class: a package that loads for its author and throws
# for a stranger, because a module, an extension entry or a store path is missing from
# the published payload.
#
# Build context is the repository root; the tarballs are produced before the build by
# scripts/smoke.sh (CI runs the same script).
FROM node:22-bookworm-slim

ARG PI_VERSION=0.86.1

WORKDIR /work/app
COPY tarballs/ /tarballs/
COPY scripts/stranger-install.sh /work/stranger-install.sh
RUN bash /work/stranger-install.sh /work/app /tarballs "${PI_VERSION}"

# The harness runs from the installed app directory, so `import` resolves pi and the
# packages exactly as a stranger's code would — from the app's own node_modules.
COPY docker/smoke.mjs /work/app/smoke.mjs
ENV PI_CODING_AGENT_DIR=/work/agent
CMD ["node", "smoke.mjs"]
