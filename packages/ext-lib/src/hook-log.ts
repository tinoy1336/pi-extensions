/**
 * hook-log: the ONE diagnostics envelope every extension writes.
 *
 * Each extension grew its own log file, its own line shape and its own path,
 * so answering "what did my extensions actually do this session" meant reading
 * four formats in four places. Every diagnostic line now lands here as
 * `{ts, source, kind, detail}`, one JSON object per line.
 *
 * This file is OBSERVABILITY ONLY — nothing reads it back to make a decision.
 * Functional ledgers keep their own files (focus-gate's ledger is read by the
 * gate itself to queue deferred actions; no-subagent-fork's rewrites are its
 * own audit trail). Diagnostics here, state there.
 *
 * Fail-open: a logging failure must never break the tool call that emitted it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".local/share/pi-hooks");

export const HOOK_LOG_PATH = join(LOG_DIR, "log.jsonl");

export function hookLog(source: string, kind: string, detail: Record<string, unknown> = {}): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    // Identity for readers has two parts, because neither alone is enough:
    //   `proc` — the pi process that emitted this (unique per running session,
    //            immune to environment inheritance). Footer counters filter on it.
    //   `sid`  — PI_SESSION_ID. Useful for cross-session analytics, but it is an
    //            INHERITED env var: a pi started from inside another pi session
    //            keeps the parent's id, so it can NOT be trusted as identity.
    appendFileSync(
      HOOK_LOG_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        proc: process.pid,
        sid: process.env.PI_SESSION_ID ?? "",
        source,
        kind,
        detail,
      }) + "\n",
    );
  } catch {
    /* never break a tool call over logging */
  }
}
