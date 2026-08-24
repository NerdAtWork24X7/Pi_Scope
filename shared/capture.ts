/**
 * capture.ts — Parser functions for provider-format LLM request/response bodies.
 *
 * These functions take the EXACT JSON body that was sent to/received from an LLM
 * provider (Anthropic, OpenAI, etc.) and extract the fields needed to create scope
 * events.  The capture endpoints (POST /capture/llm-request, POST /capture/llm-response)
 * use these parsers so the server is harness-agnostic — any client can POST raw
 * provider payloads and the dashboard renders them unchanged.
 */

// ─── Type helpers ───────────────────────────────────────────────────────────

export interface ParsedRequest {
  system_prompt: string;
  messages: { role: string; content: any }[];
  tools: string[];
  model: string | undefined;
  args: Record<string, string>;
}

export interface ParsedResponse {
  text: string;
  thinking: string;
  tool_calls: { id: string; name: string; args: Record<string, any> }[];
  stop_reason: string;
  usage: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  model: string | undefined;
}

// ─── Provider detection ─────────────────────────────────────────────────────

type ProviderFamily = "anthropic" | "openai" | "generic";

function detectProvider(body: any): ProviderFamily {
  if (!body || typeof body !== "object") return "generic";
  // Anthropic request: has `messages` array and optionally `system` (string or array).
  // Anthropic response: has `type === "message"` and `content` array with blocks.
  if (body.type === "message" && Array.isArray(body.content)) return "anthropic";
  if (body.messages && !body.choices && !body.object) {
    // Likely Anthropic request (messages but no OpenAI-style choices/object)
    // Additional heuristic: Anthropic uses `max_tokens`, OpenAI uses `max_tokens` too,
    // but Anthropic system prompt is at `body.system`, OpenAI puts it in messages[0].
    if ("system" in body) return "anthropic";
    // Could still be OpenAI — check messages[0] role
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const r = body.messages[0].role;
      if (r === "system" || r === "developer") return "openai";
    }
  }
  // OpenAI request: has `messages` array, no `system` top-level, no `type: "message"`
  // OpenAI response: has `choices` array and `object: "chat.completion"`
  if (body.object === "chat.completion" || body.object === "chat.completion.chunk") return "openai";
  if (Array.isArray(body.choices)) return "openai";
  if (Array.isArray(body.messages) && !body.system) return "openai";
  return "generic";
}

// ─── Request parsers ────────────────────────────────────────────────────────

function extractSystemPromptAnthropic(body: any): string {
  if (body.system == null) return "";
  if (typeof body.system === "string") return body.system;
  if (Array.isArray(body.system)) {
    return body.system
      .map((b: any) => (typeof b === "string" ? b : b?.text ?? ""))
      .join("\n")
      .trim();
  }
  return "";
}

function extractSystemPromptOpenAI(body: any): string {
  if (!Array.isArray(body.messages)) return "";
  const sysMsg = body.messages.find(
    (m: any) => m && (m.role === "system" || m.role === "developer")
  );
  if (!sysMsg) return "";
  const c = sysMsg.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("\n").trim() : "";
}

function extractUserMessages(body: any): { role: string; content: any }[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.filter((m: any) => m && (m.role === "user" || m.role === "assistant"));
}

function extractTools(body: any): string[] {
  if (!Array.isArray(body.tools)) return [];
  const names: string[] = [];
  for (const t of body.tools) {
    if (!t || typeof t !== "object") continue;
    const name = typeof t.name === "string" ? t.name : t.function?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

const STRUCTURAL_KEYS = new Set(["system", "messages", "tools", "model"]);

function extractRequestArgs(body: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== "object") return out;
  for (const key of Object.keys(body)) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    // Stringify objects/arrays; plain values stay as-is.
    if (Array.isArray(raw) || typeof raw === "object") {
      try { out[key] = JSON.stringify(raw); } catch { out[key] = String(raw); }
    } else {
      out[key] = String(raw);
    }
  }
  return out;
}

export function extractUserMsgPreview(body: any): string | undefined {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") {
      return m.content.slice(0, 400).trim() || undefined;
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === "text" && b.text) {
          return b.text.slice(0, 400).trim() || undefined;
        }
      }
    }
  }
  return undefined;
}

// ─── Response parsers ───────────────────────────────────────────────────────

function parseResponseAnthropic(body: any): ParsedResponse {
  let text = "";
  let thinking = "";
  const tool_calls: { id: string; name: string; args: Record<string, any> }[] = [];
  let stop_reason = "stop";

  if (Array.isArray(body.content)) {
    for (const block of body.content) {
      if (block.type === "text") text += (block.text || "") + "\n";
      else if (block.type === "thinking") thinking += (block.thinking || block.text || "") + "\n";
      else if (block.type === "tool_use") {
        tool_calls.push({
          id: block.id || block.tool_use_id || "",
          name: block.name || "",
          args: block.input || {},
        });
      }
    }
  }

  if (body.stop_reason) stop_reason = body.stop_reason;
  if (body.stop_sequence) stop_reason = body.stop_sequence;

  const usage = body.usage ?? {};
  return {
    text: text.trim(),
    thinking: thinking.trim(),
    tool_calls,
    stop_reason,
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
      cache_write: usage.cache_creation_input_tokens ?? 0,
    },
    model: body.model ?? undefined,
  };
}

function parseResponseOpenAI(body: any): ParsedResponse {
  let text = "";
  let thinking = "";
  const tool_calls: { id: string; name: string; args: Record<string, any> }[] = [];
  let stop_reason = "stop";

  if (Array.isArray(body.choices)) {
    const choice = body.choices[0];
    if (choice) {
      const msg = choice.message || choice.delta || {};
      text = msg.content ?? "";
      stop_reason = choice.finish_reason ?? "stop";

      // OpenAI reasoning content (o1/o3 thinking)
      if (msg.reasoning_content) thinking = msg.reasoning_content;

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function?.arguments ?? "{}");
          } catch { args = {}; }
          tool_calls.push({
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            args,
          });
        }
      }
    }
  }

  const usage = body.usage ?? {};
  return {
    text: text.trim(),
    thinking: thinking.trim(),
    tool_calls,
    stop_reason,
    usage: {
      input: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      output: usage.completion_tokens ?? usage.output_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
      cache_write: usage.cache_creation_input_tokens ?? 0,
    },
    model: body.model ?? undefined,
  };
}

function parseResponseGeneric(body: any): ParsedResponse {
  // Fallback: try to extract text from common patterns
  let text = "";
  let thinking = "";
  let stop_reason = "stop";
  const tool_calls: { id: string; name: string; args: Record<string, any> }[] = [];
  let usage_input = 0, usage_output = 0, cache_read = 0, cache_write = 0;
  let model: string | undefined;

  if (body.content) {
    if (typeof body.content === "string") text = body.content;
    else if (Array.isArray(body.content)) {
      for (const b of body.content) {
        if (b.type === "text") text += (b.text || "") + "\n";
        else if (b.type === "thinking") thinking += (b.thinking || b.text || "") + "\n";
      }
    }
  }

  if (body.choices?.[0]) {
    const c = body.choices[0];
    if (c.text) text = c.text;
    if (c.finish_reason) stop_reason = c.finish_reason;
  }

  if (body.usage) {
    usage_input = body.usage.input_tokens ?? body.usage.prompt_tokens ?? body.usage.input ?? 0;
    usage_output = body.usage.output_tokens ?? body.usage.completion_tokens ?? body.usage.output ?? 0;
    cache_read = body.usage.cache_read_input_tokens ?? body.usage.cache_read ?? 0;
    cache_write = body.usage.cache_creation_input_tokens ?? body.usage.cache_write ?? 0;
  }

  if (body.model) model = body.model;

  return {
    text: text.trim(),
    thinking: thinking.trim(),
    tool_calls,
    stop_reason,
    usage: { input: usage_input, output: usage_output, cache_read, cache_write },
    model,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Parse a raw LLM provider request body into the fields needed for scope events. */
export function parseLLMRequestBody(body: any): ParsedRequest {
  const provider = detectProvider(body);
  let system_prompt = "";
  let messages: { role: string; content: any }[] = [];
  let tools: string[] = [];
  let model: string | undefined;
  let args: Record<string, string> = {};

  switch (provider) {
    case "anthropic":
      system_prompt = extractSystemPromptAnthropic(body);
      messages = extractUserMessages(body);
      tools = extractTools(body);
      model = typeof body.model === "string" ? body.model : undefined;
      args = extractRequestArgs(body);
      break;
    case "openai":
      system_prompt = extractSystemPromptOpenAI(body);
      messages = extractUserMessages(body);
      tools = extractTools(body);
      model = typeof body.model === "string" ? body.model : undefined;
      args = extractRequestArgs(body);
      break;
    default:
      // Generic: try both
      system_prompt = extractSystemPromptAnthropic(body) || extractSystemPromptOpenAI(body);
      messages = extractUserMessages(body);
      tools = extractTools(body);
      model = typeof body.model === "string" ? body.model : undefined;
      args = extractRequestArgs(body);
      break;
  }

  return { system_prompt, messages, tools, model: model || undefined, args };
}

/** Parse a raw LLM provider response body into the fields needed for scope events. */
export function parseLLMResponseBody(body: any): ParsedResponse {
  const provider = detectProvider(body);
  switch (provider) {
    case "anthropic": return parseResponseAnthropic(body);
    case "openai": return parseResponseOpenAI(body);
    default: return parseResponseGeneric(body);
  }
}