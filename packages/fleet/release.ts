/**
 * fleet/release — the ONE way a worker's claim is released.
 *
 * Ownership is stated in TWO records, and a release that moves only one of them
 * leaves the path owned for the other reader:
 *
 *   - the roster entry, which is what the hire-time overlap check reads
 *     (`claimConflict(roster.claims(r), owns)`), and
 *   - the guard's claim record at `io/claims/<worker>.json`, which is what the
 *     worker's own writes are authorised against and where the generation fence is
 *     pinned from.
 *
 * That mismatch is why `io_status reclaim` can look like a release while the next
 * hire is refused anyway: the guard's generation moves, the roster's claim does
 * not. Every release goes through here — the ordinary retire, the reconcile that
 * settles a finished run, and the gone-run pass that clears a worker a reboot
 * destroyed.
 */
import { hookLog } from "@tinoy/pi-ext-lib";
import { readClaim, reclaimClaim } from "@tinoy/pi-io-guard/claims.ts";
import type { Worker } from "./roster.ts";

/**
 * Release this worker's claim in both records: the roster row becomes `retired`
 * (a terminal state the overlap check honours) and the guard's claim record is
 * WITHDRAWN by generation, so a process still running under that name has its next
 * write refused.
 *
 * The withdrawal is a read-check-write against the current generation, so a
 * concurrent release loses rather than clobbering the winner. A worker with no
 * claim record needs nothing: there is no guard-side ownership to withdraw.
 */
export function releaseClaim(ioRootPath: string, w: Worker): void {
	w.state = "retired";
	const cur = readClaim(ioRootPath, w.name);
	if (!cur) return;
	const res = reclaimClaim(ioRootPath, w.name, cur.generation);
	if (!res.ok) {
		// The roster row is released either way, and that is the record the overlap
		// check reads. A guard record that lags can only make a run that still exists
		// fail closed, so it is reported rather than retried here.
		hookLog("fleet", "claim-withdraw-refused", { worker: w.name, reason: res.reason });
	}
}
