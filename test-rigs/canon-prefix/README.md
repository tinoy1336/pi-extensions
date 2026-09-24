# canon-prefix offline rig

Guards ONE invariant: an installed extension must produce **byte-identical
system prompts whether a run starts from a typed prompt or from an injected
message** (a wake), so the provider prefix `[system, tools, messages]` never
moves and a wake cannot re-bill the cached prefix.

## Running it

```sh
bash test-rigs/canon-prefix/run.sh
```

The runner needs nothing from any particular machine: node >= 22.6 (the
harnesses run under `--experimental-strip-types`), and a canon store, which it
takes from `fixtures/canon.json` (`CANON_RIG_STORE=<file>` overrides). It seeds
a scratch agent prefix with that store and points `PI_CODING_AGENT_DIR` at it,
so no harness reads or writes a real agent dir. An already-exported
`PI_CODING_AGENT_DIR` is used as given instead — the shape `RIG_SOURCE=installed`
needs, since that source reads a pi install out of the agent dir. Exit `0` = all
five passed, `1` = a harness failed (named, with its `FAIL` lines), `2` = a
precondition was unmet so the rig never judged anything.

The five harnesses individually, from anywhere:

```sh
PI_CODING_AGENT_DIR=<prefix holding canon/canon.json> \
  node --experimental-strip-types test-rigs/canon-prefix/harness.ts
```

PASS = exit **0** and a final `ALL … CHECKS PASSED` line. A run writes its own
stamped artifact dir `runs/<ISO-stamp>-<pid>/` (logger rows, hook log,
`result.txt`), so a re-run is never confused with the previous one. `runs/` is
gitignored; `RIG_RUNS_DIR=<dir>` moves it (a read-only checkout needs that).

| file | what it drives |
| --- | --- |
| `harness.ts` | the seam package's pure helpers (`canonicalSystemPrompt`, `systemPromptSlot`) over every provider payload shape, then the real logger's miss/guard rows |
| `harness-hooks.ts` | canon's REAL `before_provider_request` hook wiring (typed, wake, anomaly, foreign shapes) |
| `freeze-harness.ts` | child-prompt-freeze's REAL child path + the real logger in one chain; also the launch-marker classification cases |
| `harness-chain.ts` | the composed seam: REAL canon hook **and** REAL prefix logger on one fake pi, in both handler orders |
| `harness-fleet.ts` | the foreman tool-set invariant: the REAL fleet package over a fake pi whose tool set is real, driving activation, a typed run, a tool call and a wake; asserts both run shapes render the same tools section and that the payload filter still keeps non-foreman tools off the wire |

## Which copy of the modules is under test

`RIG_SOURCE` declares it, and the rig never falls back from one to the other:

- `repo` (default) — this checkout's `packages/*`, resolved through each
  package's own `package.json` entry (`main`, else `exports["."]`), so moving an
  entry is not a rig edit. This is the copy CI covers.
- `installed` — a pi install's agent dir (`PI_CODING_AGENT_DIR`): what a running
  pi actually loads rather than what the tree holds. The two can disagree,
  because a stale copy of a package in the npm tree is the drift this rig exists
  to catch.

A module the selected source does not provide aborts the run (exit 2) naming the
file, the source and both directories it looked in, so a missing install can
never read as a passing harness. The same rule covers the store: `deriveBlock`
refuses to run when `<agent dir>/canon/canon.json` is absent, because an absent
store still renders the empty-store header and would pass the block assertion
for no reason.

`repo` is what CI runs. `installed` is the on-machine check of what pi loads:

```sh
PI_CODING_AGENT_DIR=~/.pi/agent RIG_SOURCE=installed bash test-rigs/canon-prefix/run.sh
```

`installed` carries one runtime constraint: node refuses `--experimental-strip-types`
for a file whose REAL path sits under a `node_modules` directory, so an agent
prefix holding unpacked copies aborts by name (exit 2) instead of failing five
times with the same npm stack trace. An agent prefix whose npm tree LINKS to the
checkout — or to a published copy — resolves to the link target and runs.

The block is derived from that store at run time by firing the real
`before_agent_start` hook, never from a recorded fixture, so a store edit cannot
silently desync the harness from the extension.

## Session shape is declared, never inherited

Every case declares the launch shape it tests through `setSessionShape()`
(`rig.ts`), which clears all three session markers first: `PI_SUBAGENT` (the
pi-subagent wrapper), `PI_SUBAGENT_CHILD` (the pi-subagents async runner — every
crew worker's shape) and `PI_FOREMAN`. A crew worker shell exports
`PI_SUBAGENT_CHILD=1`, so without this a rig run from inside the crew was
classified as a child and silently tested a different subject than the same rig
in a plain shell; `freeze-harness.ts`'s parent case failed outright, because it
neutralised only `PI_SUBAGENT`.

`harness.ts`, `harness-hooks.ts` and `harness-chain.ts` declare `parent`.
`freeze-harness.ts` declares it per case: `parent` (nothing registered),
`wrapper-child` (`PI_SUBAGENT=1`) and `async-child` (`PI_SUBAGENT_CHILD=1`), then
runs its child path in the `async-child` shape that a crew worker arrives
through.

A run needs no live pi: the hook log is resolve-hooked to the recorder (the
seam package's `hook-log.ts`), the cache-prefix log goes to this run's own dir,
and the store is read-only.

Negative controls: every harness should be able to FAIL. Add `RIG_MUTATE=<name>`:
`harness.ts` `no-append`, `harness-hooks.ts` `stale-block`,
`freeze-harness.ts` `no-restore`, `harness-chain.ts` `no-canon`, `harness-fleet.ts`
`loader-name` (renames the stub loader so the `*_enable` exemption misses it, which is
the coupling of that exemption — a mutated run must be red). A mutated run must exit
non-zero.

```sh
RIG_MUTATE=stale-block bash test-rigs/canon-prefix/run.sh   # exit 1 (a harness failed)
RIG_MUTATE=loader-name bash test-rigs/canon-prefix/run.sh   # exit 1 (the fleet arm)
```

`harness-fleet.ts` rejects a mutation name it does not define with exit `2` rather than
running unmuted, so a foreign name there reads as a precondition failure, not a pass.

## CI

`.github/workflows/ci.yml` job `canon-rig` runs `bash test-rigs/canon-prefix/ci.sh`,
which runs `run.sh` and classifies the run from one snapshot of its output:
`RIG PASS`, `RIG FAILURE` (a harness failed — every failing harness is printed
and annotated with its `FAIL` lines), or `PRECONDITION FAILURE` (exit 2 —
nothing was judged). The wrapper takes no bound of its own; the job's
`timeout-minutes` is the ceiling for the whole suite.

## What is not in this repository

The cost-bearing live legs (`live/run-leg.py` and the two extensions it loads)
launch a real pi process and make real provider requests. They need pi, provider
credentials and a machine to spend on, so they are neither in CI nor in this
checkout; they stay beside the local rig at `~/.pi/agent/test-rigs/canon-prefix/`,
which is also where their recorded evidence lives. The offline suite above is
what CI runs, and the live legs remain the authority for the true process path.

## Residual limits

- The dispatcher is a fake pi: it approximates pi's real (unsorted) handler
  order and does not exercise pi's payload construction, session/branch,
  compaction, or provider serialization. The chain harness runs both orders to
  bound the ordering risk.
- `@earendil-works/pi-coding-agent` is bundled inside the pi binary, so the
  specifier is resolve-shimmed to `pi-sdk-shim.mjs` (`defineTool`). Divergence
  from the bundled module is unverified. The seam's `hook-log.ts`
  (observability only) is redirected to `hook-log-recorder.mjs`.
- The derived block reflects the shape the rig declares plus `PI_MODEL`/ctx.model.
  Canon renders its block once per process, so one rig run covers one audience
  only; a fork rendered for another model is covered by the stale/doubled
  `canonicalSystemPrompt` cases.
- The fixture store is small and synthetic: the rig rejects a store that renders
  no `## Canon` block, not one whose entries changed.
