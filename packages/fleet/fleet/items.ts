/**
 * fleet/items — the foreman's item ledger.
 *
 * One file per session (`~/.local/pi/foreman/items-<sessionId>.json`), owned by
 * the foreman, holding one record per work item. It is the foreman's own working
 * memory and is deliberately NOT the todo board: the board is the workers' surface
 * and is rebuilt from the session branch, so it cannot hold the foreman's own
 * bookkeeping across a compaction or a resume.
 *
 * An item is the smallest unit with exactly one owner and one write claim. Two
 * owners is two items; no write claim at all is the `["none"]` sentinel.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const ITEMS_DIR = join(process.env.HOME ?? "/root", ".local/pi/foreman");

export type ItemState = "queued" | "live" | "done" | "failed";

const STATES: readonly ItemState[] = ["queued", "live", "done", "failed"];

export interface ItemClaims {
	owns: string[];
	exclusive: string[];
	/** True when the caller declared the `["none"]` sentinel here. The normalised list
	 *  is empty either way, so without this the ledger cannot tell "declared nothing"
	 *  from "said nothing at all" — and an item must declare its claim. */
	exclusiveDeclared?: boolean;
}

export interface Item {
	id: string;
	text: string;
	scope: string;
	worker?: string;
	state: ItemState;
	claims: ItemClaims;
	/** Which prompt or steer produced the item; free text, kept for tracing. */
	provenance?: string;
	artifact?: string;
	/** The worker's turn count when this item went live, and the requests it took
	 *  (turns at `done` minus this). Recorded rather than inferred: K-hat — the
	 *  forecast the retirement rule compares against break-even — is built from
	 *  exactly these numbers, and a proxy would forecast from something else. */
	startedTurns?: number;
	requests?: number;
	createdAt: number;
	updatedAt: number;
}

export interface Ledger {
	sessionId: string;
	nextId: number;
	items: Item[];
}

export function ledgerPath(sessionId: string): string {
	// The session id reaches a filename, so anything that could escape the
	// directory is refused rather than sanitised into a different file.
	return join(ITEMS_DIR, `items-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function loadLedger(sessionId: string): Ledger {
	try {
		const raw = JSON.parse(readFileSync(ledgerPath(sessionId), "utf8")) as Ledger;
		if (Array.isArray(raw?.items)) {
			return {
				sessionId,
				nextId:
					typeof raw.nextId === "number" && raw.nextId > 0 ? raw.nextId : raw.items.length + 1,
				items: raw.items.filter(
					(i): i is Item =>
						typeof i?.id === "string" && typeof i?.text === "string" && STATES.includes(i?.state),
				),
			};
		}
	} catch {
		/* missing or corrupt: start empty rather than losing the session's ability to record */
	}
	return { sessionId, nextId: 1, items: [] };
}

/** Atomic: a ledger half-written is a ledger that lost items. */
export function saveLedger(ledger: Ledger): void {
	mkdirSync(ITEMS_DIR, { recursive: true });
	const path = ledgerPath(ledger.sessionId);
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
	renameSync(tmp, path);
}

export interface NewItem {
	text: string;
	scope: string;
	worker?: string;
	state?: ItemState;
	claims?: Partial<ItemClaims>;
	provenance?: string;
	artifact?: string;
}

export function addItem(sessionId: string, input: NewItem): Item {
	const ledger = loadLedger(sessionId);
	const now = Date.now();
	const item: Item = {
		id: `itm-${ledger.nextId}`,
		text: input.text,
		scope: input.scope,
		...(input.worker ? { worker: input.worker } : {}),
		// A queued item is never pre-marked in progress: that is the same rule the
		// worker board follows, and it is what makes "live" mean work has started.
		state: input.state ?? "queued",
		claims: {
			owns: input.claims?.owns ?? [],
			exclusive: input.claims?.exclusive ?? [],
			// Carried through deliberately: this is the only record that the caller SAID
			// `["none"]` rather than saying nothing, and rebuilding the object without it
			// lost that distinction on every single add.
			...(input.claims?.exclusiveDeclared ? { exclusiveDeclared: true } : {}),
		},
		...(input.provenance ? { provenance: input.provenance } : {}),
		...(input.artifact ? { artifact: input.artifact } : {}),
		createdAt: now,
		updatedAt: now,
	};
	ledger.items.push(item);
	ledger.nextId += 1;
	saveLedger(ledger);
	return item;
}

export interface ItemPatch {
	text?: string;
	scope?: string;
	worker?: string | null;
	state?: ItemState;
	claims?: Partial<ItemClaims>;
	artifact?: string | null;
	startedTurns?: number;
	requests?: number;
}

export function updateItem(sessionId: string, id: string, patch: ItemPatch): Item | null {
	const ledger = loadLedger(sessionId);
	const item = ledger.items.find((i) => i.id === id);
	if (!item) return null;
	if (patch.text !== undefined) item.text = patch.text;
	if (patch.scope !== undefined) item.scope = patch.scope;
	if (patch.worker !== undefined) {
		if (patch.worker === null) delete item.worker;
		else item.worker = patch.worker;
	}
	if (patch.state !== undefined) item.state = patch.state;
	if (patch.artifact !== undefined) {
		if (patch.artifact === null) delete item.artifact;
		else item.artifact = patch.artifact;
	}
	if (patch.claims !== undefined) {
		if (patch.claims.owns !== undefined) item.claims.owns = patch.claims.owns;
		if (patch.claims.exclusive !== undefined) item.claims.exclusive = patch.claims.exclusive;
	}
	if (patch.startedTurns !== undefined) item.startedTurns = patch.startedTurns;
	if (patch.requests !== undefined) item.requests = patch.requests;
	item.updatedAt = Date.now();
	saveLedger(ledger);
	return item;
}

export function listItems(sessionId: string, state?: ItemState): Item[] {
	const items = loadLedger(sessionId).items;
	return state ? items.filter((i) => i.state === state) : items;
}

/** One line per item, for the foreman's own reading. Both halves of the claim are
 *  shown: printing only one hid the file claim whenever an exclusive token was set. */
export function renderItem(item: Item): string {
	const claim = [
		item.claims.owns.length ? item.claims.owns.join(", ") : "",
		item.claims.exclusive.length
			? `exclusive=${item.claims.exclusive.join("+")}`
			: item.claims.exclusiveDeclared
				? "exclusive=none (declared)"
				: "",
	]
		.filter(Boolean)
		.join("; ");
	return `${item.id} [${item.state}] ${item.worker ?? "unassigned"} — ${item.text} (${item.scope}${claim ? `; ${claim}` : ""})${item.artifact ? ` -> ${item.artifact}` : ""}`;
}

/**
 * Retention. The ledger is durable, not immortal: one file per foreman session
 * otherwise accumulates forever, while mode files and rosters are pruned. Ages by
 * each file's own mtime, because a ledger written to this week is live
 * bookkeeping whatever its name says.
 */
export function pruneOldLedgers(maxAgeMs: number = 30 * 24 * 3600 * 1000): number {
	let removed = 0;
	try {
		for (const f of readdirSync(ITEMS_DIR)) {
			if (!f.startsWith("items-") || !f.endsWith(".json")) continue;
			const p = join(ITEMS_DIR, f);
			try {
				if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
					unlinkSync(p);
					removed++;
				}
			} catch {
				/* leave it */
			}
		}
	} catch {
		/* nothing to prune */
	}
	return removed;
}
