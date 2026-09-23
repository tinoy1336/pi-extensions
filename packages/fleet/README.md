# @tinoy/pi-fleet

The crew tool and its write coordination, as two entries in one package: the foreman's
fleet of long-lived workers (`fleet/index.ts`) and the per-worker claims, locks and version
checks that guard one shared tree (`io-guard/index.ts`). They ship together because they
import each other — `fleet` writes claims through `io-guard/claims`, and
`io-guard/predicates` reads `fleet/predicates` — so splitting them would recreate that cycle
across a package boundary, or invent a third package purely to break it.

```bash
pi install npm:@tinoy/pi-fleet
```

## What it needs at call time

A roster and claim store under `~/.local/pi/foreman/`; pi-subagents for the transports; and
`@juicesharp/rpiv-todo` for the board, whose reducer it applies rather than reimplementing; it is an OPTIONAL peer, reached through a guarded dynamic import, so the package loads without it and says so by name.

## Registers

`fleet` (from the fleet entry) and `io_status` (from the io-guard entry).

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-canon` | the foreman discipline section reaches the system prompt | the section is offered over the event bus and nothing appends it | `pi install npm:@tinoy/pi-canon` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peers with a `*`
range. `@juicesharp/rpiv-todo` is an optional peer. Plain dependencies: `@tinoy/pi-ext-lib`,
`@tinoy/pi-tariff`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
