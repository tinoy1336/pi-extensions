# @tinoy/pi-tariff

The house price table's contract: one owner for the configured tariff file, its validation
and its refusal. Two consumers read it — the cost footer and the fleet's retirement
economics — and a second copy of the numbers anywhere would let one of them decide against
last month's table while the other reported this month's. This package is a library: it
registers nothing with pi, and its `pi.extensions` list is empty so that installing it
cannot load anything. It is meant to arrive as a dependency:

```json
{ "dependencies": { "@tinoy/pi-tariff": "^0.1.0" } }
```

Installing it into pi directly (`pi install npm:@tinoy/pi-tariff`) is harmless and does
nothing on its own: with no configured table it refuses, and no consumer is present to price
from it.

## No rate ships in this package

The table is DATA. This package carries `EXAMPLE_TARIFF` — a synthetic 1 : 10 : 100 ladder
that is no vendor's tariff — so the file's shape is documented in code and the refusal can
print the exact shape it wants. Nothing prices from the example: a rate that is not the one
this machine is billed at is worse than no figure at all.

The live table is read from `PI_TARIFF_CONFIG` when set, else `<agent dir>/tariff.json`
(`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). It is never part of this package and never
in the tarball.

## What an unconfigured machine gets

A refusal, never a price. `TARIFF.ok` is false and `TARIFF.reason` names the file to write
and the shape to write it in, with the example table inlined. Each consumer decides how that
surfaces: the cost footer registers no pricing and stays empty, while the fleet's retirement
check returns its own typed refusal naming the same file.

The file is read once, when the module is first imported, so an edit applies to the next
session, not the running one.

## API

| Export | Purpose |
| --- | --- |
| `TARIFF` | `{ ok: true, table, path }` or `{ ok: false, reason, path }` |
| `liveTariff()` | the configured table, or a throw carrying the refusal reason — the one gate a pricer goes through |
| `TARIFF_CONFIG_PATH` | where the table was read from |
| `EXAMPLE_TARIFF` | the synthetic shape documentation; never a price |
| `ratios(table, column?, window?)` | the cache-read ratios derived from a given table, not from literals |
| `WINDOWS`, `HOUSE_TARIFF_MODELS` | `["valley", "peak"]`, and the model ids billed at this tariff |
| `TariffConfig`, `TariffTable`, `TariffRow`, `TariffLoad`, `Window`, `Ratios` | the types |

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `tariff.json` | the rates this machine is billed at, so the footer and the retirement maths are about real money | every consumer refuses and prices nothing | not a package |

`tariff.json` is operator-supplied data, by design: this package ships the shape and the
refusal, never the numbers.

## Dependencies

`@tinoy/pi-ext-lib` for the diagnostics line an unconfigured machine emits once per process.
No pi package is imported, so this package declares no peer dependency.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
