# pi-extensions

[![CI](https://github.com/tinoy1336/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/tinoy1336/pi-extensions/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tinoy/pi-canon?label=pi-canon)](https://www.npmjs.com/package/@tinoy/pi-canon)

pi extensions, and the shared library they are built on, in one npm workspace.

Source, releases and issue tracker: <https://github.com/tinoy1336/pi-extensions>.

Each package under `packages/` is published to npm on its own. `@tinoy/pi-canon`
is a pi extension; `@tinoy/pi-ext-lib` is a plain library that other packages in
this repo (and any future extension package) depend on.

## Install

```bash
pi install npm:@tinoy/pi-canon
pi install npm:@tinoy/pi-ext-lib   # library only: nothing is registered with pi
```

## Layout

| Path | Purpose |
| --- | --- |
| `packages/ext-lib` | `@tinoy/pi-ext-lib` — shared helpers: the hook log envelope, the TUI tool-header builder, the system-prompt block seam |
| `packages/canon` | `@tinoy/pi-canon` — durable system-prompt rules: the canon store, its four tools, `/canon` and `/canon-dump` |
| `tsconfig.base.json` | the compiler options every package typechecks under (strict, no emit, TS sources shipped raw) |
| `tsconfig.json` | the workspace typecheck program — the root `typecheck` script runs `tsc --noEmit` over every package |
| `biome.json` | lint + format for the whole workspace |
| `commitlint.config.mjs` | Conventional Commits, run from `.githooks/commit-msg` |
| `.githooks/commit-msg` | the commit-msg hook: `git config core.hooksPath .githooks` is set by the root `prepare` script on install |
| `cliff.toml` | `git-cliff` changelog configuration (local preview; the shipped changelogs are per package) |
| `release/` | semantic-release configuration, one file per package |
| `scripts/` | the checks and release helpers CI runs: pack contents, the stranger install, the release gate and tag withdrawal |
| `docker/` | the stranger-install smoke test: its Dockerfile and the harness that runs inside it |
| `.github/workflows/` | `ci.yml` (checks + smoke), `release.yml` (semantic-release on merge), `live-turn.yml` (manual model turn) |
| `RELEASING.md` | how a release happens, the one-time npm bootstrap, forcing/skipping one, and rollback |
| `LICENSE` | MIT |

## Development

```bash
npm install          # installs the toolchain and links the workspace packages
npm run typecheck    # tsc --noEmit over every package
npm run lint         # biome check
npm run check:pack   # the exact file list of each published package
npm run smoke        # stranger-install smoke test in a container (docker; $CONTAINER_ENGINE to override)
npm run smoke:local  # the same harness against the same tarball install, no container
npm run release:dry  # what the next release would publish (needs an npm login)
npm run changelog    # git-cliff preview of a changelog
```

The same commands are what CI runs, so a green local run means a green `check` job.
Releases are automated: see [RELEASING.md](RELEASING.md).

Commits follow Conventional Commits (`feat(canon): …`), enforced where the commit
is written by the local `commit-msg` hook.

## Licence

MIT — see [LICENSE](LICENSE).
