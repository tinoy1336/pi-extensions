> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-deepseek-cost

Price the session footer from the configured house tariff, per message timestamp.

```bash
pi install npm:@tinoy/pi-deepseek-cost
```

## What it needs at call time

A configured tariff table: without one, pricing is disabled and the reason names the file to write.

## The footer field

The status line carries the running total in both currencies, then the window glyph and the remaining
time in the window in force: `$1.2345 ¥8.9000 \ue30d 1d 3h`. The remainder is floored and shows at
most the two largest non-zero units — `1d 3h`, `11h 5m`, `53m 4s`, `38s` — so a second unit of zero is
dropped (`2d`, `5h`, `1m`) and seconds stand alone under a minute. The label is at most 7 characters
(`59m 59s`), which makes the field at most 9 cells beside the glyph; `bash packages/deepseek-cost/rig/run.sh`
from the repository root pins every shape and that ceiling (the rig is a checkout gate and is not part
of the published payload).

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
