/**
 * @tinoy/pi-ext-lib — the shared helpers pi extensions in this monorepo import.
 *
 * This is the package's whole public API. Every module here is host-agnostic:
 * no extension's policy, no extension's store path, no extension's tool schema.
 *
 * `hook-log.ts` and `tool-header.ts` are verbatim copies of the live extension
 * sources (a single `cp`, never edited in place here) — the second consumer of
 * each was already in the tree, so the copy is the one canonical file for any
 * package that depends on this one.
 */
export { escapeRe, globOverlap } from "./glob.ts";
export { HOOK_LOG_PATH, hookLog } from "./hook-log.ts";
export {
	deliver,
	drain,
	ensureRoot,
	IPC_AUDIENCES,
	IPC_CHANNEL_METHODS,
	IPC_ENVELOPE_VERSION,
	IPC_KINDS,
	IPC_NAMESPACE_PATTERN,
	IPC_REGISTER_EVENT,
	IPC_REGISTRY_READY_EVENT,
	IPC_TEXT_CAP,
	type IpcAudience,
	type IpcDone,
	type IpcDrainRefusal,
	type IpcEnvelope,
	type IpcKind,
	type IpcPresence,
	type IpcRefusal,
	ipcRoot,
	parseEnvelope,
	parsePresence,
	peersWithNamespace,
	processStartTicks,
	readPeers,
	sweepStale,
	writePresence,
} from "./ipc.ts";
export { type NeighbourReport, optionalNeighbour } from "./neighbour.ts";
export {
	canonicalSystemPrompt,
	PROMPT_APPEND_SEP,
	systemPromptSlot,
} from "./system-prompt.ts";
export {
	argNumber,
	argText,
	clip,
	type HeaderComponent,
	type HeaderPart,
	type HeaderTheme,
	renderToolHeader,
	safeToolHeader,
} from "./tool-header.ts";
