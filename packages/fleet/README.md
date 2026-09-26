> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-fleet

The fleet tool: long-lived worker sessions driven by one coordinating session — the
roster, the board, hiring and retirement, steering, and the foreman discipline
section.

```bash
pi install npm:@tinoy/pi-fleet
```

The write coordination those workers rely on — per-worker path claims, locks and
version checks, and the `io_status` tool — ships separately as `@tinoy/pi-io-guard`,
which this package depends on.

## What it needs at call time

A writable store directory — `~/.local/pi/foreman/` under the home directory, holding
the per-session roster, the item ledger and the adoption sheets — and pi-subagents for
the transports. `@juicesharp/rpiv-todo` supplies the board, whose reducer the fleet
applies rather than reimplementing; it is an OPTIONAL peer, reached through a guarded
dynamic import, so the package loads without it and says so by name.

The `fleet` tool is registered in every session and removes itself unless foreman mode
is on, which a launcher signals with `PI_FOREMAN=1`. Without it the package is inert:
nothing is launched and no store file is written.

## Registers

`fleet`.

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-canon` | the fleet discipline section reaches the system prompt | the section is offered over the event bus and nothing appends it | `pi install npm:@tinoy/pi-canon` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peers with a `*`
range. `@juicesharp/rpiv-todo` is an optional peer. Plain dependencies:
`@tinoy/pi-ext-lib`, `@tinoy/pi-io-guard`, `@tinoy/pi-tariff`.

`@tinoy/pi-tariff` is what the retirement economics read: the cache-read ratios come
from the configured price table, so a machine with no configured table gets the
refusal instead of a retirement recommendation.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
