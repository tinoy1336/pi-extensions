# @tinoy/pi-fleet

The fleet tool and its write coordination, as two entries in one package: a fleet of
long-lived workers driven by one coordinating session (`fleet/index.ts`) and the
per-worker claims, locks and version checks that guard one shared tree
(`io-guard/index.ts`). They ship together because they import each other — `fleet`
writes claims through `io-guard/claims`, and `io-guard/predicates` reads
`fleet/predicates` — so splitting them would recreate that cycle across a package
boundary, or invent a third package purely to break it.

```bash
pi install npm:@tinoy/pi-fleet
```

## What it needs at call time

A writable store directory — `~/.local/pi/foreman/` under the home directory, holding
the per-session roster, the per-worker claim records, the item ledger and the adoption
sheets; pi-subagents for the transports; and `@juicesharp/rpiv-todo` for the board,
whose reducer it applies rather than reimplementing; it is an OPTIONAL peer, reached
through a guarded dynamic import, so the package loads without it and says so by name.

The `fleet` tool is registered in every session and removes itself unless foreman mode
is on, which a launcher signals with `PI_FOREMAN=1`. Without it the package is inert:
nothing is launched, no store file is written, and `io_status` still answers for the
claim records that are there.

## Registers

`fleet` (from the fleet entry) and `io_status` (from the io-guard entry).

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-canon` | the fleet discipline section reaches the system prompt | the section is offered over the event bus and nothing appends it | `pi install npm:@tinoy/pi-canon` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peers with a `*`
range. `@juicesharp/rpiv-todo` is an optional peer. Plain dependencies: `@tinoy/pi-ext-lib`,
`@tinoy/pi-tariff`.

`@tinoy/pi-tariff` is what the retirement economics read: the cache-read ratios come
from the configured price table, so a machine with no configured table gets the
refusal instead of a retirement recommendation.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
