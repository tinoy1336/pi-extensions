# pi-extensions

[![CI](https://github.com/tinoy1336/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/tinoy1336/pi-extensions/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tinoy/pi-canon?label=pi-canon)](https://www.npmjs.com/package/@tinoy/pi-canon)

pi extensions, and the shared library they are built on, in one npm workspace.

Source, releases and issue tracker: <https://github.com/tinoy1336/pi-extensions>.

Every package under `packages/` is published to npm on its own and installed on its
own. Three of them are libraries the others are built on (`@tinoy/pi-ext-lib`,
`@tinoy/pi-focus-state`, `@tinoy/pi-tariff`); the rest are pi extensions, each one
entry that registers its own tools, hooks or footer rows. `@tinoy/pi-canon` is an
extension as well. The shared helpers live only in the library: `@tinoy/pi-canon`
imports the system-prompt seam
(`canonicalSystemPrompt`, `systemPromptSlot`, `PROMPT_APPEND_SEP`) from
`@tinoy/pi-ext-lib` and does not re-export it, so a consumer that needs it — for
example an extension that appends a block to the system prompt on its own —
imports `@tinoy/pi-ext-lib`.

## Install

**Install one, or several.** `pi install npm:@tinoy/pi-read-staleness` works on its
own. Nothing here requires another package: an extension's hard dependencies are its own
entry and the shared library packages, which npm installs for you.

| Package | What it does | Needs | Works better with |
| --- | --- | --- | --- |
| `@tinoy/pi-ext-lib` | shared helpers: the hook-log envelope, the TUI tool-header builder, the system-prompt block seam | — | — |
| `@tinoy/pi-canon` | durable system-prompt rules: the canon store, its tools, `/canon`, and the tail-section registry other extensions contribute through | — | — |
| `@tinoy/pi-focus-state` | the focus-mode state contract: the state file, the per-session ledgers, their paths | — | `@tinoy/pi-focus-gate`, which toggles the mode the file carries |
| `@tinoy/pi-tariff` | the house price table's shape, validation and refusal | a tariff table with your own rates (`tariff.json`) — no rate ships | — |
| `@tinoy/pi-read-staleness` | the body of a repeat full-file read is replaced by a one-line stub | — | — |
| `@tinoy/pi-orphan-repair` | an orphaned tool result is dropped from the outbound request | — | — |
| `@tinoy/pi-cache-prefix-log` | one JSONL row per cache-prefix change | — | `@tinoy/pi-canon` records the tail-section ids with each row |
| `@tinoy/pi-child-request-dump` | a structure-only JSONL record of each child session's request | — | — |
| `@tinoy/pi-desktop-notify` | the `desktop_notify` tool and the settled-response ping | a desktop notification daemon (`notify-send`) | — |
| `@tinoy/pi-probe` | one bounded status probe for a unit, a process or a hyprctl query | systemd `--user` with `journalctl` and `pgrep`; `hyprctl` for the opt-in branch | — |
| `@tinoy/pi-intercom-broadcast` | the `broadcast` tool | the pi-intercom broker for `broadcast` | — |
| `@tinoy/pi-no-subagent-fork` | a spawn's `context: "fork"` is rewritten to `"fresh"` | — | — |
| `@tinoy/pi-image-read` | `image_read`: downscale or crop an image, report the token estimate | ImageMagick (`magick`) | — |
| `@tinoy/pi-command-guard` | destructive shell commands are blocked with the safe alternative named | — | — |
| `@tinoy/pi-status-metrics` | footer counters: calls blocked, bytes kept out of context, anchors, gated actions | — | `@tinoy/pi-command-guard` and `@tinoy/pi-read-staleness` feed two of its rows |
| `@tinoy/pi-nf` | `nf`: glyph search, contact sheet, escape audit | `python3` with Pillow and a Nerd Font file for `sheet` (`search` and `audit` need nothing) | — |
| `@tinoy/pi-build` | the bounded `build` tool for a compile, lint or typecheck command | a shell with the toolchain the command itself uses | `@tinoy/pi-fleet` for crew isolation |
| `@tinoy/pi-child-prompt-freeze` | a child session's rewritten system prompt is pinned and restored | a child session (inert in a parent) | — |
| `@tinoy/pi-todo-parent` | the child session's todo tool, applied to the spawning session's list | `@juicesharp/rpiv-todo` in the spawning session, and the pi-subagents supervisor channel to carry the mutation | — |
| `@tinoy/pi-focus-gate` | machine-global focus mode: a session works but cannot touch the desktop | Hyprland, AGS, `grim` and the `inject` wrapper for the actions it gates | — |
| `@tinoy/pi-drift-anchor` | reasoning-register drift is detected and re-anchored with a tail line | — | `@tinoy/pi-canon`, whose block the anchor texts name |
| `@tinoy/pi-deepseek-cost` | the session footer priced from the house tariff | a tariff table with your own rates (`tariff.json`) | — |
| `@tinoy/pi-cli-keys` | provider API keys hydrated into the session environment | a Proton Pass vault plus a local `cli-keys` command | — |
| `@tinoy/pi-sudo-approve` | root commands run behind a user-approved prompt, with an audit log | AGS/promptd for the approval window | — |
| `@tinoy/pi-fleet` | the crew tool and its write coordination: roster, per-worker claims, locks, version checks (two entries) | pi-subagents for the transports, and `@juicesharp/rpiv-todo` for the board | `@tinoy/pi-canon`, whose foreman discipline section reaches the system prompt |

**Install everything.** The full set above is the known-good set: matrix case `A2` installs
all of it from the tarballs and loads it in one pi process, and the case fails unless every
package loads and registers exactly the tools its own single-package case names. Each
package installs on its own, so the whole set is a loop over the workspace manifests:

```bash
for d in packages/*/; do pi install "npm:$(node -p "require('./$d/package.json').name")"; done
```

**Caveats.** Installing a subset never produces a fatal error; a missing neighbour is
reported by name in the diagnostics log, and any capability that depends on a machine
feature refuses at call time with the reason. `Needs` above names the capability, not
the package, for everything that is outside npm — a missing one never stops the install
and never stops the load.

**Two operator settings that are not packages.** Both are configuration for the session
that hosts these extensions, and neither ships in a package:

- the `context` setting of `subagent/config.json` — the default a subagent spawn resolves
to. `@tinoy/pi-no-subagent-fork` rewrites a requested `fork` at call time, but a machine
that should never fork starts from this setting (`fresh`).
- the `subagents.defaultExtensions` settings route — a child session runs as its own
process and loads the extensions listed there, which is how the child-side packages
(`@tinoy/pi-child-prompt-freeze`, `@tinoy/pi-child-request-dump`) reach a child at all.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/` | one directory per npm package: the pi extensions and the three libraries they share — see the table under [Install](#install) |
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
