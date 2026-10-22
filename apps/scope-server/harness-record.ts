/**
 * harness-record.ts — translate a chat turn driven by an external harness CLI
 * into the observation events the rest of the app already reads.
 *
 * A pi chat records itself: its extension posts `turn_start`, `user_message`,
 * `assistant_message`, … to the server, so the session appears in the workspace
 * rail and its transcript can be replayed later. An external harness (Claude
 * Code, Codex, Gemini, opencode, Cline, Kilo, …) has no such extension: Chat
 * owns the process, so Chat must also own the record. Without this a harness
 * conversation existed only in memory (and in the Chat view's localStorage
 * snapshot) and was invisible to the rail, which lists database sessions.
 *
 * Keep the event shapes the same as pi's — the rail, Single view, trajectory and
 * usage helpers all key off `user_message` / `assistant_message` / turn events.
 */
import * as crypto from "node:crypto";
import type { ObsEvent } from "../../shared/types.ts";

export interface HarnessRecordStart {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
  /** What the user typed (not the composed prompt carrying earlier turns). It
   *  has to match the Chat view's thread so opening the row adopts the thread
   *  instead of creating a second conversation. */
  prompt: string;
  at: number;
}

export interface HarnessRecordTool {
  name: string;
  args?: string;
  callId?: string;
}

export interface HarnessRecordEnd {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
  text: string;
  thinking?: string;
  tools?: HarnessRecordTool[];
  outcome: "done" | "error" | "aborted";
  error?: string;
  at: number;
}

export type HarnessRecord =
  | { kind: "start"; start: HarnessRecordStart }
  | { kind: "end"; end: HarnessRecordEnd };

/** Allocate a seq from this session's shared counter (the server seeds it from
 *  `getMaxSeq`, so a restart never collides or goes backwards). */
export type NextSeq = () => number;

function base(
  record: HarnessRecordStart | HarnessRecordEnd,
  type: string,
  seq: number,
  ts: string,
): ObsEvent {
  return {
    event_id: `harness-${crypto.randomUUID()}`,
    session_id: record.sessionId,
    seq,
    ts,
    type,
    pool: "default",
    tags: [`harness:${record.harness}`],
    payload: {},
    // Deliberately no provider: the model is already qualified by the CLI
    // (`openai/gpt-5`, `anthropic/claude-sonnet-4-5`), and prefixing it with the
    // harness id would make the context-window lookup miss.
    model: record.model || undefined,
    agent_name: record.harness,
    cwd: record.cwd,
  };
}

/** Events that open a turn: the lifecycle marker and the user's prompt. */
export function harnessStartEvents(start: HarnessRecordStart, nextSeq: NextSeq): ObsEvent[] {
  const ts = new Date(start.at || Date.now()).toISOString();
  const turn = base(start, "turn_start", nextSeq(), ts);
  turn.payload = { harness: start.harness };
  const user = base(start, "user_message", nextSeq(), ts);
  user.payload = { text: start.prompt };
  return [turn, user];
}

/** Events that close a turn: the tools it used, the reply, and the lifecycle
 *  marker. An aborted run keeps its partial reply so Stop does not erase what
 *  the agent already wrote. */
export function harnessEndEvents(end: HarnessRecordEnd, nextSeq: NextSeq): ObsEvent[] {
  const ts = new Date(end.at || Date.now()).toISOString();
  const events: ObsEvent[] = [];
  for (const [i, tool] of (end.tools || []).entries()) {
    if (!tool?.name) continue;
    const call = base(end, "tool_call", nextSeq(), ts);
    call.payload = {
      tool_name: tool.name,
      args: tool.args || "",
      tool_call_id: tool.callId || `harness-tool-${i}`,
    };
    events.push(call);
  }

  const assistant = base(end, "assistant_message", nextSeq(), ts);
  const payload: Record<string, unknown> = {
    text: end.text || "",
    harness: end.harness,
  };
  if (end.thinking) payload.thinking = end.thinking;
  if (end.model) payload.model = end.model;
  if (end.outcome === "aborted") payload.stop_reason = "cancelled";
  else if (end.outcome === "error") {
    payload.stop_reason = "error";
    if (end.error) payload.error_message = end.error;
  } else {
    payload.stop_reason = "end_turn";
  }
  assistant.payload = payload;
  // A turn stopped before the agent said anything has no reply to show. Keep an
  // empty message only when it carries a reason (an error) or work (thinking /
  // tools); otherwise the transcript would open on a blank assistant bubble.
  if (end.text || end.thinking || events.length || end.error) events.push(assistant);

  const done = base(end, "turn_end", nextSeq(), ts);
  done.payload = { harness: end.harness, reason: end.outcome };
  events.push(done);
  return events;
}
