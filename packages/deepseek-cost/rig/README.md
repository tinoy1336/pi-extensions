# deepseek-cost label rig

Guards ONE invariant: the string this package puts in the footer status line —
the window glyph plus the remaining time in the tariff window in force — keeps the
declared shape and never outgrows the width the footer tolerates.

## Running it

```sh
bash packages/deepseek-cost/rig/run.sh
```

Node >= 22.6 (`--experimental-strip-types`) and nothing else: the harness drives the
package's own exported `remainingLabel`, `windowAt` and `windowLabel` with an injected
instant, so there is no live pi, no provider, no agent dir, no terminal and no fixture
file. It starts no process beyond node and writes nothing.

Exit codes:

| exit | meaning |
| --- | --- |
| `0` | every check passed — the last line reads `ALL <n> DEEPSEEK-COST CHECKS PASSED` |
| `1` | a check failed; every `FAIL` line names the actual and the expected value |
| `2` | a precondition was unmet (no usable node, no module under test, the harness did not finish inside `COST_RIG_TIMEOUT`, default 120 s), so nothing was judged |

`COST_RIG_MODULE` points the harness at another copy of the module, which is how a
different revision is compared against the same expectations. That copy has to sit
outside a `node_modules` tree: node refuses `--experimental-strip-types` for a file
whose real path is under one.

## What it pins

| check | why it exists |
| --- | --- |
| one remainder per shape | the four shapes the footer may show (`1d 3h`, `11h 5m`, `53m 4s`, `38s`) plus the widest form (`59m 59s`) and a case inside the second peak window |
| the second unit dropped when it is zero | a whole day reads `2d`, a whole hour `5h`, a whole minute `1m`, never `2d 0h` |
| the glyph and the right-aligned field | the valley crescent and the peak sun; a short label is padded to three cells, so the field never drops below five |
| shape over a dense sweep | two weeks at a 10-minute stride: one or two units, non-zero, in descending order, each below its radix, never three units |
| width over the same sweep | no label wider than 7 cells and no rendered field wider than 9 (glyph + space + label) — the ceiling the footer's width budget was measured against |

Every case is a Beijing wall-clock instant in the week of 2026-06-01 (Sat 06th,
Sun 07th, Mon 08th). The window rule is Beijing time, so each case is built relative
to a weekday boundary at 09:00, 14:00 or 18:00 — what an interval actually ends at —
and the harness converts the wall clock with the fixed UTC+8 offset (Asia/Shanghai
has no daylight saving).

The cases are exact strings, not ranges, so a change in how many units are shown
fails here rather than reaching the footer.

## Wiring

The harness is the checkout's gate, not a published file: `package.json` ships
`index.ts`, `README.md` and `LICENSE` only, so `rig/` travels with the repository and
never with the package. `.github/workflows/ci.yml` runs it in the `cost-rig` job, which
calls `run.sh` after `npm ci`; a working tree can run the same script by hand.
