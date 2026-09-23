# @tinoy/pi-deepseek-cost

Price the session footer from the configured house tariff, per message timestamp.

```bash
pi install npm:@tinoy/pi-deepseek-cost
```

## What it needs at call time

A configured tariff table: without one, pricing is disabled and the reason names the file to write.

## Registers

no tool

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `tariff.json` | the rates this machine is billed at | pricing is disabled and the footer prints no figure | not a package |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`, `@tinoy/pi-tariff`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
