# pi-extensions

pi extensions, and the shared library they are built on, in one npm workspace.

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
| `cliff.toml` | `git-cliff` changelog configuration |
| `LICENSE` | MIT |

## Development

```bash
npm install          # installs the toolchain and links the workspace packages
npm run typecheck    # tsc --noEmit over every package
npm run lint         # biome check
npm run changelog    # git-cliff, Conventional Commits grouped by type
```

Commits follow Conventional Commits (`feat(canon): …`), enforced where the commit
is written by the local `commit-msg` hook.

## Licence

MIT — see [LICENSE](LICENSE).
