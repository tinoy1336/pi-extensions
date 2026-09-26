# @tinoy/pi-ipc

Talk to other pi sessions on this machine: list the peers, send to one, ask one and wait for its
answer, or broadcast to all of them.

```bash
pi install npm:@tinoy/pi-ipc
```

## What it needs at call time

A writable `$XDG_RUNTIME_DIR`, which a login session provides. The transport lives under
`$XDG_RUNTIME_DIR/pi-ipc` and is refused by name when that directory is unset, is not a directory,
or belongs to another user — it never falls back to a second location. There is no broker, no
socket, no config file and no command line: the transport is reachable only from an extension
running inside a session, and a session's id and name come from the session itself.

## Registers

`ipc`

| Action | What it does |
| --- | --- |
| `list` | the live sessions, each with a short id, name and cwd |
| `send` | one message to one peer, arriving in it as a turn of its own |
| `ask` | send, then block until the peer answers or the ask times out |
| `broadcast` | the same message to every other live session |

A peer is addressed by its full session id, a unique id prefix of 4 or more characters, or its
exact name; a target that could be more than one session is refused with the candidates. An inbound
ask prints the handle that answers it, and an ask left unanswered is named in one line at the end of
the turn — there is no `pending` action to poll. `PI_IPC_ASK_TIMEOUT_MS` sets the ask timeout
(default 600000 ms).

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-canon` | a canon edit reaches every running session as a passive notice, with no new session needed | running sessions keep the rules they started with until they are restarted | `pi install npm:@tinoy/pi-canon` |
| `@tinoy/pi-focus-gate` | a focus toggle reaches every peer as a passive notice at its next turn | each session still reads the state file, so gating is unaffected and only the notice is lost | `pi install npm:@tinoy/pi-focus-gate` |

The bus is the same contract either way: a package that registers a namespace still serves it with
this package installed or with any other implementation of the transport.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*`
range and are never bundled. Plain dependencies: `@tinoy/pi-ext-lib`, whose `ipc.ts` owns the wire —
the rendezvous path, the presence records, the inbox and the bus contract strings.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
