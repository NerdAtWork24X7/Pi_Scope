/**
 * session-seed.ts — a recorded conversation, handed to a fresh pi session as a
 * preamble.
 *
 * A recorded session's identity is its pi session file. When that file is gone
 * pi cannot resume the conversation at all (see `resumeTargetProblem` in
 * chat.ts), but Pi Scope still holds every event of it — so continuing such a
 * session seeds a NEW conversation with a bounded transcript of what was said
 * and done. The agent then answers with the work in view instead of starting
 * from nothing. This is the case the agent-team harness creates: it writes each
 * subagent's session log into the workspace and deletes it when the dispatch
 * ends (`wipeSessionFile`), so those sessions can never be resumed by pi.
 *
 * The block is written once, at the start of the turn that could not resume
 * (see `startChat`'s `resumeSeed`); every later turn of the same subprocess
 * already carries it in the session's own history.
 *
 * The continuation itself is recorded as a NEW session — the file that was
 * deleted cannot be written again, because the path belongs to the tool that
 * removed it (see `resumeTargetProblem`) — so the original row keeps its
 * transcript and the continued conversation appears beside it in the rail.
 *
 * Delimited on purpose: the transcript is prepended to the user's own message,
 * which is what pi records as the turn's `user_message` — so the clients strip
 * it back out for display (`stripSessionSeed` in public/helpers.js, which keys
 * on the two markers below; keep the three strings in sync).
 *
 * Reads only: the row owning a pi session file, and that session's events.
 */

import { type PreparedQueries, rowToEvent } from "./db.ts";
import type { ObsEvent } from "../../shared/types.ts";

/** Opens the block. Matched as a PREFIX by the client's strip, so the reason
 *  that follows the dash can change freely. */
export const SEED_HEAD = "[Continued session transcript";
/** Closes it. Everything the user typed follows this line. */
export const SEED_TAIL = "[End of continued session transcript]";

/** Total characters of transcript the block may carry (the header is extra).
 *  ~6k tokens — small next to the conversation it stands in for, large enough
 *  for a real working session. */
export const SEED_MAX_CHARS = 24_000;
/** Per-part caps, so one giant tool dump cannot crowd out the dialogue. */
export const SEED_TEXT_MAX = 3_000;
export const SEED_ARGS_MAX = 400;
export const SEED_RESULT_MAX = 600;
/** How many of the newest events are examined (the budget decides how many are
 *  kept; a long conversation is read from its tail, which is what the work
 *  continues from). */
export const SEED_SCAN_EVENTS = 400;

/** Trim a value to `max` characters, marking what was dropped. */
function clamp(value: unknown, max: number): string {
  const s = String(value ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)} …(truncated)`;
}

/** A tool call's arguments on one line (pi hands them as an object). */
function argsLine(args: unknown): string {
  if (args == null) return "";
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return clamp(text, SEED_ARGS_MAX);
}

/**
 * One event as transcript lines, or "" for events that carry no conversation
 * (lifecycle, usage, llm_request…) or nothing readable at all.
 *
 * Thinking is deliberately dropped: it is the largest part of a turn and the
 * least useful to continue from, and the block says so.
 */
function renderEvent(ev: ObsEvent): string {
  const p = (ev.payload ?? {}) as Record<string, any>;
  switch (ev.type) {
    case "user_message": {
      const text = clamp(p.text, SEED_TEXT_MAX);
      return text ? `### user\n${text}` : "";
    }
    case "assistant_message": {
      // A provider failure is recorded ON the message it killed — without it the
      // continued conversation looks like the agent simply chose not to answer.
      const text = clamp(p.text, SEED_TEXT_MAX);
      const failed = p.error_message ? `\n(failed: ${clamp(p.error_message, 300)})` : "";
      return text || failed ? `### assistant\n${text}${failed}` : "";
    }
    case "tool_call":
      return `→ ${p.tool_name || "tool"} ${argsLine(p.args)}`.trimEnd();
    case "tool_result": {
      const body = clamp(p.content_text ?? p.content, SEED_RESULT_MAX);
      return `← ${p.tool_name || "tool"}${p.is_error ? " (failed)" : ""}: ${body}`;
    }
    case "error":
      return `[error] ${clamp(p.message || p.detail, 300)}`;
    default:
      return "";
  }
}

/** The session that owns a pi session file, else the id the caller sent.
 *  A file is a conversation's identity (see `canonicalSessionId`), and it is the
 *  file whose absence brought us here — so it outranks a subprocess key. */
function resolveSessionId(q: PreparedQueries, sessionFile: string, sessionId: string): string {
  if (sessionFile) {
    try {
      const row = q.getSessionByFile.get({ $session_file: sessionFile }) as { session_id?: string } | undefined;
      if (row?.session_id) return row.session_id;
    } catch { /* no such row — fall through to the id */ }
  }
  return sessionId;
}

/**
 * The seed block for a session whose own pi session file is gone, or "" when
 * there is nothing to hand over (an unknown session, or one that recorded no
 * conversation). `reason` names why the file could not be resumed, so the agent
 * is told what happened rather than guessing.
 */
export function buildSessionSeed(
  q: PreparedQueries,
  opts: { sessionFile?: string; sessionId?: string; reason?: string },
): string {
  const sessionId = resolveSessionId(q, (opts.sessionFile || "").trim(), (opts.sessionId || "").trim());
  if (!sessionId) return "";

  let rows: any[];
  try {
    rows = q.getSessionEvents.all({
      $session_id: sessionId,
      $limit: SEED_SCAN_EVENTS,
      $before_seq: null,
      $type: "",
    }) as any[];
  } catch {
    return "";
  }
  if (!rows.length) return "";

  // Newest first: keep whole events until the budget runs out. Stopping at the
  // first overflow (rather than skipping past it) keeps the block a contiguous
  // tail of the conversation instead of a patchwork with holes in it.
  const kept: string[] = [];
  let used = 0;
  let from = 0;
  for (; from < rows.length; from++) {
    const part = renderEvent(rowToEvent(rows[from]));
    if (!part) continue;
    if (used + part.length > SEED_MAX_CHARS) break;
    kept.push(part);
    used += part.length;
  }
  if (!kept.length) return "";
  const omitted = rows.length - from;

  const reason = (opts.reason || "").trim();
  const lines = [
    `${SEED_HEAD}${reason ? ` — pi could not resume this session: ${reason}` : ""}]`,
    "This is the only record of this conversation. Treat it as your memory of the work done",
    "so far: continue from where it ended and do not repeat what it reports as finished.",
    "Reasoning is omitted; tool calls are summarised.",
  ];
  if (omitted > 0) lines.push("(Earlier parts of this conversation are omitted; the newest events follow.)");
  lines.push("", kept.reverse().join("\n"), SEED_TAIL);
  return lines.join("\n");
}
