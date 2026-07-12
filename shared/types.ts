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
}
