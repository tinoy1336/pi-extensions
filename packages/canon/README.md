# @tinoy/pi-canon

Durable system-prompt rules ("canon") for pi. Rules and learned facts are stored
on disk, scoped by model (`global` or a model id) and audience (`all`, `parent`,
`foreman`, `subagent`), and injected into every matching session's system prompt.
Runtime edits reach running sessions as notices; the injected block is a
session-start snapshot, so a running session's prompt never changes mid-session.

```bash
pi install npm:@tinoy/pi-canon
```

## What it does

- **Store** — `~/.pi/agent/canon/canon.json`: `{entries: [{id, text, model, audience, reason?, category?}], categories: [{id, title, description?}]}`. Written atomically; a missing or corrupt store reads as empty.
- **Tools** — `canon_add`, `canon_remove`, `canon_edit`, `canon_category`.
- **Commands** — `/canon` (list, add, remove, edit, category management) and `/canon-dump`.
- **Injection** — the block is appended at `before_agent_start` and re-normalized on every provider request, so a run started by an injected message carries the same bytes as an interactive prompt.
- **Peer notices** — entry changes are broadcast over the pi-intercom bus (namespace `canon`); receivers match the entry scope against their own model and audience.
- **Tail sections** — another extension contributes prompt text through the `canon:section` event; its ids are published on `canon:sections`.

## Dependencies

pi supplies these, so they are declared as peer dependencies with `*` and are not
bundled: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`.
`@tinoy/pi-ext-lib` is a plain dependency.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
