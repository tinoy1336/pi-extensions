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
- **Category headings** — a category sub-heading inside a scope group prints the store id after the word `category` (`#### Behavioural Preferences [category 1cg5lr]`), which is the same id a `canon_add` refusal lists; the word keeps it from reading as an entry handle, which the block renders as `[1i15c2]`. Uncategorized entries carry no id, and a scope group holding a single category stays flat with no sub-heading.
- **Peer notices** — entry changes are broadcast over the pi-intercom bus (namespace `canon`); receivers match the entry scope against their own model and audience.
- **Tail sections** — another extension contributes prompt text through the `canon:section` event; its ids are published on `canon:sections`.

## Exports

`index.ts` is the package entry, and it is also the module API:

| Export | What it is |
| --- | --- |
| default | the pi extension factory — the hooks, the four tools and the two commands |
| `setTailSection(id, text)` | contribute a tail section, replaced per id |
| `registeredSectionIds()` | the ids currently registered |

The tail-section registry stays here because it owns this package's event contract: the
`canon:section` / `canon:sections` names, the `canon` hook-log source, and the section
cap. `setTailSection` / `registeredSectionIds` are exported for this package's own use
and are never re-exported elsewhere; another extension reaches the registry through the
`canon:section` event, because an exported function is unreachable across the loader's
module isolation.

## The system-prompt seam

The seam canon composes the tail through — `canonicalSystemPrompt(systemPrompt, block)`,
`systemPromptSlot(payload)` and the append separator `PROMPT_APPEND_SEP` — is NOT
exported from this package. It lives in `@tinoy/pi-ext-lib` (`src/system-prompt.ts`),
together with the rule that makes it shared: `before_agent_start` fires only from the
interactive `prompt()` path, so an appended block has to be re-normalized on every
provider request for the request prefix to stay byte-identical. Canon imports it from
there, and so does any other extension that appends to the system prompt — import
`@tinoy/pi-ext-lib`, not this package. What stays here is the policy: the block's
content, its scope rules, and what happens when the payload carries no rewritable slot.

## Dependencies

pi supplies these, so they are declared as peer dependencies with `*` and are not
bundled: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`.
`@tinoy/pi-ext-lib` is a plain dependency; the prompt seam above is imported from it,
not re-exported by this package.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
