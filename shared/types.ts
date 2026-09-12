// shared/types.ts — shared types for the Pi Scope server and DB layer.
// Imported (as ../../shared/types.ts) by apps/scope/server.ts and apps/scope/db.ts.

/** Max allowed size (bytes) for a POST /events request body. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** A single observation event ingested by the SCOPE server. */
export interface ObsEvent {
  event_id: string;
  session_id: string;
  seq: number;
  ts: string;
  type: string;
  pool?: string;
  tags?: string[];
  payload?: unknown;
  provider?: string;
  model?: string;
  agent_name?: string;
  session_file?: string;
  cwd?: string;
  /** Set on events from a spawned subagent: the pi session that spawned it.
   *  Passed by the harness via the SCOPE_PARENT_SESSION env var. */
  parent_session_id?: string;
}

/** Summary row for a session as returned by the DB layer. */
export interface SessionSummary {
  session_id: string;
  pool: string;
  agent_name?: string;
  cwd?: string;
  session_file?: string;
  provider?: string;
  model?: string;
  first_ts: string;
  last_ts: string;
  event_count: number;
  tags: string[];
  has_shutdown?: boolean;
  /** Type of the most recent turn lifecycle event, `'turn_start'` or
   *  `'turn_end'`, or undefined when a session recorded none. A session is
   *  "running" from `turn_start` until `turn_end`; only after `turn_end` is it
   *  waiting for the next user prompt. Used for the running/waiting status dot
   *  so a long tool call or a wait on a subagent no longer flips the row to
   *  "waiting" after the recency window elapses. */
  last_turn_event?: string;
  /** First user message sent to the LLM in this session (truncated preview). */
  first_msg?: string;
  /** Session that spawned this one. Exact value recorded from the
   *  SCOPE_PARENT_SESSION env var by the pi-scope extension; falls back to a
   *  heuristic inference from spawn-ish tool_call events when absent. */
  parent_session_id?: string;
  /** Authoritative context window (in tokens) resolved server-side from the
   *  model metadata store for `<provider>/<model>`. 0/absent when the model is
   *  unknown — the client then falls back to its own heuristic table. Used as
   *  the denominator for the Single-view context-utilization bar. */
  context_window?: number;
}
