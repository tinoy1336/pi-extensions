# Stranger-install smoke test.
#
# A clean Node image, a pinned pi release, and the two packages installed from the
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
