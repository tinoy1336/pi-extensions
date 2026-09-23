# @tinoy/pi-focus-state

The focus-mode state contract: one owner for `$XDG_RUNTIME_DIR/pi-focus.json` and for the
per-session ledgers beside it. This package is a library: it registers nothing with pi, and
its `pi.extensions` list is empty so that installing it cannot load anything. It is meant to
arrive as a dependency of the extensions that gate desktop intrusion and of the ones that
must not notify through that gate:

```json
{ "dependencies": { "@tinoy/pi-focus-state": "^0.1.0" } }
```

Installing it into pi directly (`pi install npm:@tinoy/pi-focus-state`) is harmless and does
nothing: the state file is only meaningful once something toggles it.

## The contract

- **Mode file** — `$XDG_RUNTIME_DIR/pi-focus.json`, holding `{ "mode": "on" | "off", "since"?: string }`.
  It lives on tmpfs, so it resets to `off` at reboot: there is no stale-focus trap. It is
  read fresh on every call, and it is the whole contract between the session that toggles it
  and every consumer that reads it.
- **Two states only** — `on` gates desktop intrusion, `off` does not. The names `quiet` and
  `locked` read as `on`, and `full` reads as `off`, so a file written under the earlier
  three-mode names still reads correctly.
- **Fail-open** — a missing, unreadable or corrupt file reads as `off`. A defect here can
  never mute a session silently.
- **Ledgers** — one JSONL ledger per session process, `<runtime dir>/pi-focus.<session>-<pid>.ledger.jsonl`.
  The pid keeps two processes apart when one inherits the other's session id; a session with
  no id yet uses its pid alone.
- **No configuration** — this module reads no config file, registers no tool and carries no
  policy about what a gated session may do. A consumer that wants the mode to mean something
  imports the state and decides.

## API

| Export | Purpose |
| --- | --- |
| `readFocusState()` | the current state, fail-open to `off` |
| `focusActive(state?)` | true while desktop intrusion is gated |
| `FOCUS_STATE_PATH` | the mode file's path |
| `focusLedgerPathFor(owner?)` | this session process's ledger path |
| `focusLedgerFiles()` | every focus ledger in the runtime dir, this session's included |
| `clearFocusLedgers()` | remove all of them; returns how many were removed |
| `watchFocusState(onChange, debounceMs?)` | watch the runtime dir for state changes; returns a safe disposer |
| `FocusMode`, `FocusState` | `"on" \| "off"`, and `{ mode, since? }` |

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `focus-gate` | a session that actually toggles the mode, so `on`/`off` means something | the state stays `off` and nothing is gated — this library only reads and writes a contract | not a package |

The gate and the notifier are separate packages: this library is the shared contract they
read. The gate ships as its own package in this repository; until one is installed, nothing
sets the mode, and every reader sees `off`.

## Dependencies

Node builtins only (`node:fs`, `node:path`). No pi package is imported, so this package
declares no peer dependency.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
