> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-io-guard

Write coordination for a crew of sessions sharing one tree. The worker side runs hooks
only: it records what this worker read and guards what it writes. The foreman side is
a single tool, `io_status`, for inspection and the atomic reclaim of a claim.

```bash
pi install npm:@tinoy/pi-io-guard
```

## What it needs at call time

A writable store directory — `~/.local/pi/foreman/io` under the home directory, holding
the per-worker claim records, the per-write locks, the parked proposals and the version
stamps. The guard fails closed: an unreadable claim, an untrusted or missing version
record, or a guard error all refuse the write rather than allow it.

A package with no fleet in the session still loads: `io_status` answers for whatever
claim records are on disk, and the write guard simply has nothing to allow.

## Registers

`io_status`.

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-fleet` | a dispatcher that hires workers against these claims and reclaims them on retirement | the records are written and read by hand, and nothing turns a reclaim into a new hire | `pi install npm:@tinoy/pi-fleet` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peers with a `*`
range. Plain dependency: `@tinoy/pi-ext-lib`, whose `globOverlap` decides what "this
path is inside that claim" means, so the guard and the dispatcher cannot disagree about
a glob.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
