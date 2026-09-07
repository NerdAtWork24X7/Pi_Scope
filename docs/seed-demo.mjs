#!/usr/bin/env node
/**
 * seed-demo.mjs — Fill a running Pi Scope server with a realistic demo session
 * so you can explore every view without attaching a real coding agent.
 *
 *   node docs/seed-demo.mjs
 *
 * Uses the default local server (http://127.0.0.1:43190). Override with env:
 *   SCOPE_URL=http://127.0.0.1:43190  SCOPE_TOKEN=<token>  node docs/seed-demo.mjs
 *
 * The script posts three sessions:
 *   • a "coder" agent adding dark mode to the Pi Scope settings page,
 *   • a "tester" subagent spawned by it, and
 *   • a second project session with a failed command (to see error rows).
 * Events are idempotent (fixed event_ids), so re-running is safe.
 */

const BASE = process.env.SCOPE_URL ?? "http://127.0.0.1:43190";
const TOKEN = process.env.SCOPE_TOKEN ?? "";
const NOW = Date.now();
const min = 60_000;

let seq = 0;
const t = (ago) => (payload) => ({ ...payload, _ago: ago });

function evt(type, payload, { session, agent, model, cwd, tags, provider, parent } = {}) {
  return {
    event_id: `demo-${session.slice(0, 8)}-${seq}`,
    session_id: session,
    seq: seq++,
    ts: new Date(NOW - (payload._ago ?? 0)).toISOString(),
    type,
    payload: { ...payload, _ago: undefined },
    pool: "default",
    tags: tags ?? [],
    cwd,
    agent_name: agent,
    model,
    provider,
    parent_session_id: parent,
  };
}

const USAGE = (input, output, cost, extra = {}) => ({
  input, output, total_tokens: input + output, cost_total: cost,
  cache_read: extra.cacheRead ?? 0, cache_write: extra.cacheWrite ?? 0,
});

function buildCoderSession() {
  const S = "sess-darkmode-9f3a2b";
  const C = { session: S, agent: "coder", model: "deepseek/deepseek-v4-flash", cwd: "/home/alexa/wk/Pi_Scope", tags: ["ui", "frontend"], provider: "deepseek" };
  const E = [];
  E.push(evt("session_start", t(42 * min)({ reason: "manual" }), C));
  E.push(evt("agent_start", t(42 * min - 8000)({ prompt: "Add dark mode support to the Settings page — a theme toggle in the header, persisted to localStorage" }), C));
  E.push(evt("llm_request", t(42 * min - 14_000)({
    model: "deepseek/deepseek-v4-flash", turn_index: 0, message_count: 28,
    user_msg_preview: "Add dark mode support to the Settings page — a theme toggle in the header, persisted to localStorage",
    tools: ["bash", "edit", "glob", "grep", "read", "write"],
    system_prompt: "You are pi, a terminal-native AI coding agent. Work in the user's project, read before you write, prefer small focused edits, verify with commands when you can, and summarize what changed and how to verify it when you finish.",
    request_args: { temperature: 1.0, max_tokens: 8192, stream: true, thinking: { type: "enabled", budget_tokens: 2048 } },
  }), C));
  E.push(evt("thinking", t(42 * min - 16_000)({ text: "The header in apps/scope/public/index.html already has a brand block and a live indicator. I'll add a theme toggle button between them, then wire the logic in app.js with localStorage persistence, and add the theme tokens to styles.css." }), C));
  E.push(evt("tool_call", t(42 * min - 18_000)({ tool_call_id: "tc-1", tool_name: "read_file", args: { path: "apps/scope/public/index.html", lines: "1-60" } }), C));
  E.push(evt("tool_result", t(42 * min - 21_000)({ tool_call_id: "tc-1", tool_name: "read_file", content_text: "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n  <title>Pi Scope</title>\n  <link rel=\"stylesheet\" href=\"styles.css\">\n</head>\n<body class=\"layout-form\">\n  <header>\n    <div class=\"brand-logo-container\" style=\"display:flex;align-items:center;gap:10px\">\n      <img src=\"logo.png\" alt=\"Pi Scope\" height=\"40\" />\n      <div class=\"brand\"><h1>Pi Scope</h1><div class=\"subtitle\">Measure to Improve</div></div>\n    </div>\n    <div id=\"header-center\">…</div>\n    <div id=\"header-right\">\n      <div id=\"live-indicator\">\n        <span id=\"live-dot\" class=\"red\"></span>\n        <span id=\"live-label\">off</span>\n      </div>\n    </div>\n  </header>", details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(42 * min - 23_000)({
    text: "The header is clean and has a natural home for the toggle in #header-right. I'll add a ☀/🌙 button there that flips a `data-ds-dark-theme` attribute on <body> and stores the choice in localStorage.",
    thinking: "Keep it dependency-free and consistent with the existing single-file UI style. The button should read the saved theme on load so the page never flashes the wrong mode.",
    usage: USAGE(13_248, 512, 0.0042, { cacheRead: 8000, cacheWrite: 1024 }),
    latency_ms: 8400, prefill_ms: 1200, output_tps: 61, stop_reason: "tool_use", turn_index: 0,
  }), C));
  E.push(evt("tool_call", t(42 * min - 25_000)({ tool_call_id: "tc-2", tool_name: "edit_file", args: { path: "apps/scope/public/index.html", edits: [{ op: "replace", find: "<div id=\"header-right\">", with: "<div id=\"header-right\">\n      <button id=\"btn-theme\" title=\"Toggle light / dark theme\">☀</button>" }] } }), C));
  E.push(evt("tool_result", t(42 * min - 27_000)({ tool_call_id: "tc-2", tool_name: "edit_file", content_text: "Applied 1 edit to apps/scope/public/index.html", details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(42 * min - 29_000)({
    text: "Toggle button is in. Now the theme wiring: a small IIFE that applies the saved theme before the UI paints, plus setTheme()/toggleTheme() on window.",
    usage: USAGE(15_990, 388, 0.0049, { cacheRead: 9600 }), latency_ms: 6100, prefill_ms: 980, output_tps: 63, stop_reason: "tool_use", turn_index: 0,
  }), C));
  E.push(evt("tool_call", t(42 * min - 31_000)({ tool_call_id: "tc-3", tool_name: "edit_file", args: { path: "apps/scope/public/app.js", edits: [{ op: "insert", after: "const STATE = {", lines: ["  theme: localStorage.getItem('scope-theme') ?? 'light',"] }] } }), C));
  E.push(evt("tool_result", t(42 * min - 33_000)({ tool_call_id: "tc-3", tool_name: "edit_file", content_text: "Applied 2 edits to apps/scope/public/app.js", details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(42 * min - 35_000)({
    text: "Logic wired. Let me boot the server and verify the toggle survives a reload.",
    usage: USAGE(18_104, 244, 0.0056, { cacheRead: 11_200 }), latency_ms: 3900, prefill_ms: 700, output_tps: 62, stop_reason: "tool_use", turn_index: 0,
  }), C));
  E.push(evt("tool_call", t(42 * min - 37_000)({ tool_call_id: "tc-4", tool_name: "run_terminal_command", args: { command: "node apps/scope/server.ts", cwd: "/home/alexa/wk/Pi_Scope" } }), C));
  E.push(evt("tool_result", t(42 * min - 39_000)({ tool_call_id: "tc-4", tool_name: "run_terminal_command", content_text: "pi-scope server v0.1.0\n  UI:    http://127.0.0.1:43190/?token=3f9a…c21d\n  DB:    /home/alexa/wk/Pi_Scope/db/scope.db", details_summary: { exit_code: 0 } }), C));
  E.push(evt("tool_call", t(42 * min - 40_000)({ tool_call_id: "tc-5", tool_name: "bash", args: { command: "curl -s http://127.0.0.1:43190/health | head -c 200" } }), C));
  E.push(evt("tool_result", t(42 * min - 40_500)({ tool_call_id: "tc-5", tool_name: "bash", content_text: '{"ok":true,"version":"0.1.0","uptime_s":3,"events_total":12,"sessions_total":1}', details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(42 * min - 41_000)({
    text: "Server boots clean and /health responds. The toggle persists across reloads via localStorage, and the theme tokens were added to styles.css.",
    usage: USAGE(20_415, 402, 0.0063, { cacheRead: 12_800 }), latency_ms: 6700, prefill_ms: 1100, output_tps: 60, stop_reason: "end_turn", turn_index: 0,
  }), C));
  E.push(evt("turn_end", t(42 * min - 41_400)({ turn_index: 0, usage: USAGE(20_415, 402, 0.0063, { cacheRead: 12_800 }), final_response: "Added a persistent dark-mode toggle to the header and made the timeline tool chips theme-aware." }), C));
  E.push(evt("compaction", t(30 * min)({ reason: "context near limit", tokens_before: 20_817, summary_preview: "Added a ☀/🌙 theme toggle to the Pi Scope header (index.html), wired setTheme/toggleTheme with localStorage persistence in app.js, added dark tokens to styles.css, and verified the server stays healthy." }), C));
  E.push(evt("user_message", t(28 * min)({ text: "Nice. Can you also make the tool-call rows in the timeline match the theme?" }), C));
  E.push(evt("llm_request", t(27.5 * min)({
    model: "deepseek/deepseek-v4-flash", turn_index: 1, message_count: 34,
    user_msg_preview: "Nice. Can you also make the tool-call rows in the timeline match the theme?",
    tools: ["bash", "edit", "glob", "grep", "read", "write"],
    request_args: { temperature: 1.0, max_tokens: 8192, stream: true, thinking: { type: "enabled", budget_tokens: 1024 } },
  }), C));
  E.push(evt("thinking", t(27 * min)({ text: "The tool-name chips in helpers.js already take a light/dark branch. I just need to add the dark tokens to the .tool-name-pill rule so the pill tints invert on the dark theme." }), C));
  E.push(evt("tool_call", t(26.8 * min)({ tool_call_id: "tc-6", tool_name: "edit_file", args: { path: "apps/scope/public/styles.css", edits: [{ op: "replace", find: ".tool-name-pill {", with: ".tool-name-pill {\n  --tool-bg: var(--pill-bg);\n  --tool-border: var(--pill-border);\n  --tool-fg: var(--pill-fg);" }] } }), C));
  E.push(evt("tool_result", t(26.4 * min)({ tool_call_id: "tc-6", tool_name: "edit_file", content_text: "Applied 1 edit to apps/scope/public/styles.css", details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(26 * min)({
    text: "Done — tool rows now use theme-aware chips that swap palettes with the toggle.",
    usage: USAGE(24_902, 296, 0.0076, { cacheRead: 15_400 }), latency_ms: 4900, prefill_ms: 850, output_tps: 60, stop_reason: "end_turn", turn_index: 1,
  }), C));
  E.push(evt("turn_end", t(25.8 * min)({ turn_index: 1, usage: USAGE(24_902, 296, 0.0076, { cacheRead: 15_400 }) }), C));
  E.push(evt("agent_end", t(25 * min)({ message_count: 18, final_response: "Added a persistent dark-mode toggle to the header and made timeline tool chips theme-aware. The server stayed healthy throughout — verify at http://127.0.0.1:43190." }), C));
  E.push(evt("session_shutdown", t(24 * min)({ reason: "completed" }), C));
  return E;
}

function buildTesterSession() {
  const S = "sess-tester-77c1d0";
  const C = { session: S, agent: "tester", model: "gemini/gemini-3.5-flash", cwd: "/home/alexa/wk/Pi_Scope", tags: ["qa"], provider: "google", parent: "sess-darkmode-9f3a2b" };
  const E = [];
  E.push(evt("session_start", t(20 * min)({ reason: "spawned" }), C));
  E.push(evt("agent_start", t(19.8 * min)({ prompt: "Verify the dark-mode toggle: toggle on, reload, assert the theme persists and the live indicator still works." }), C));
  E.push(evt("llm_request", t(19.5 * min)({ model: "gemini/gemini-3.5-flash", turn_index: 0, message_count: 12, user_msg_preview: "Verify the dark-mode toggle…", tools: ["bash", "read", "grep"], request_args: { temperature: 0.7, max_tokens: 4096, stream: true } }), C));
  E.push(evt("tool_call", t(19.2 * min)({ tool_call_id: "tt-1", tool_name: "run_terminal_command", args: { command: "npm run dev & sleep 2 && curl -s http://127.0.0.1:43190/health" } }), C));
  E.push(evt("tool_result", t(18.6 * min)({ tool_call_id: "tt-1", tool_name: "run_terminal_command", content_text: '{"ok":true,"version":"0.1.0","events_total":41,"sessions_total":2}', details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(18.2 * min)({ text: "Server healthy. Now toggling the theme in a headless browser and reloading to check persistence…", usage: USAGE(8640, 210, 0.0011), latency_ms: 3400, prefill_ms: 600, output_tps: 62, stop_reason: "tool_use", turn_index: 0 }), C));
  E.push(evt("tool_call", t(17.9 * min)({ tool_call_id: "tt-2", tool_name: "bash", args: { command: "grep -c 'scope-theme' apps/scope/public/app.js" } }), C));
  E.push(evt("tool_result", t(17.5 * min)({ tool_call_id: "tt-2", tool_name: "bash", content_text: "3", details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(17 * min)({ text: "Persistence code present (3 references). Theme toggle verified: dark mode survives reload. ✅", usage: USAGE(9210, 180, 0.0012), latency_ms: 2900, prefill_ms: 520, output_tps: 62, stop_reason: "end_turn", turn_index: 0 }), C));
  E.push(evt("turn_end", t(16.8 * min)({ turn_index: 0, usage: USAGE(9210, 180, 0.0012) }), C));
  E.push(evt("agent_end", t(16 * min)({ message_count: 9, final_response: "Dark-mode toggle verified: server healthy, persistence confirmed, live indicator unaffected." }), C));
  E.push(evt("session_shutdown", t(15 * min)({ reason: "completed" }), C));
  return E;
}

function buildApiSession() {
  const S = "sess-api-2e5f91";
  const C = { session: S, agent: "coder", model: "opencode-go/deepseek-v4-pro", cwd: "/home/alexa/wk/model_selector", tags: ["api", "backend"], provider: "opencode-go" };
  const E = [];
  E.push(evt("session_start", t(10 * min)({ reason: "manual" }), C));
  E.push(evt("agent_start", t(9.6 * min)({ prompt: "Add pagination to the model selector API — limit/offset params plus a total count in the response" }), C));
  E.push(evt("llm_request", t(9.2 * min)({ model: "opencode-go/deepseek-v4-pro", turn_index: 0, message_count: 16, user_msg_preview: "Add pagination to the model selector API…", tools: ["read", "edit", "bash"], request_args: { temperature: 0.9, max_tokens: 8192, stream: true } }), C));
  E.push(evt("tool_call", t(8.9 * min)({ tool_call_id: "ta-1", tool_name: "read_file", args: { path: "api/models.py", lines: "1-120" } }), C));
  E.push(evt("tool_result", t(8.5 * min)({ tool_call_id: "ta-1", tool_name: "read_file", content_text: "from fastapi import APIRouter, Query\nfrom .store import list_models\n\nrouter = APIRouter()\n\n@router.get(\"/models\")\nasync def get_models():\n    return {\"models\": list_models()}", details_summary: { exit_code: 0 } }), C));
  E.push(evt("tool_call", t(8.2 * min)({ tool_call_id: "ta-2", tool_name: "edit_file", args: { path: "api/models.py", edits: [{ op: "replace", find: "async def get_models():", with: "async def get_models(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):" }] } }), C));
  E.push(evt("tool_result", t(7.8 * min)({ tool_call_id: "ta-2", tool_name: "edit_file", content_text: "Applied 1 edit to api/models.py", details_summary: { exit_code: 0 } }), C));
  E.push(evt("tool_call", t(7.5 * min)({ tool_call_id: "ta-3", tool_name: "bash", args: { command: "python -m pytest tests/test_models.py -q" } }), C));
  E.push(evt("tool_result", t(7.1 * min)({ tool_call_id: "ta-3", tool_name: "bash", content_text: "___________ FAIL: tests/test_models.py::test_pagination ___________\nE   TypeError: get_models() got an unexpected keyword argument 'limit'", is_error: true, details_summary: { exit_code: 1 } }), C));
  E.push(evt("assistant_message", t(6.8 * min)({ text: "The route signature changed but the handler body still ignores the new params. Let me fix list_models to slice and count.", usage: USAGE(14_320, 260, 0.0044), latency_ms: 4100, prefill_ms: 800, output_tps: 63, stop_reason: "tool_use", turn_index: 0 }), C));
  E.push(evt("tool_call", t(6.5 * min)({ tool_call_id: "ta-4", tool_name: "edit_file", args: { path: "api/models.py", edits: [{ op: "replace", find: "return {\"models\": list_models()}", with: "all_models = list_models()\n    return {\"models\": all_models[offset:offset+limit], \"total\": len(all_models)}" }] } }), C));
  E.push(evt("tool_result", t(6.1 * min)({ tool_call_id: "ta-4", tool_name: "edit_file", content_text: "Applied 1 edit to api/models.py", details_summary: { exit_code: 0 } }), C));
  E.push(evt("tool_call", t(5.8 * min)({ tool_call_id: "ta-5", tool_name: "bash", args: { command: "python -m pytest tests/test_models.py -q && curl -s 'http://localhost:8000/models?limit=5&offset=10'" } }), C));
  E.push(evt("tool_result", t(5.4 * min)({ tool_call_id: "ta-5", tool_name: "bash", content_text: "3 passed in 0.41s\n{\"models\": [\"glm-5.3\", \"hy3\", \"deepseek-v4-pro\", \"qwen3.8-max\", \"grok-4.6\"], \"total\": 142}", details_summary: { exit_code: 0 } }), C));
  E.push(evt("assistant_message", t(5 * min)({ text: "All 3 tests pass and the API now returns page 3 (offset 10, limit 5) with a total of 142 models.", usage: USAGE(16_540, 340, 0.0051), latency_ms: 5300, prefill_ms: 950, output_tps: 64, stop_reason: "end_turn", turn_index: 0 }), C));
  E.push(evt("turn_end", t(4.8 * min)({ turn_index: 0, usage: USAGE(16_540, 340, 0.0051) }), C));
  E.push(evt("agent_end", t(4 * min)({ message_count: 11, final_response: "Pagination added: limit/offset query params, total count in the response, and 3 passing tests." }), C));
  E.push(evt("session_shutdown", t(3 * min)({ reason: "completed" }), C));
  return E;
}

async function post(events) {
  const res = await fetch(`${BASE}/events`, {
    method: "POST",
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    body: JSON.stringify(events),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`  ${data.ingested ?? "?"}/${events.length} events ingested (rejected: ${(data.rejected ?? []).length})`);
  if (data.rejected?.length) console.log("  rejected:", data.rejected.join(", "));
}

console.log(`Seeding demo sessions into ${BASE} …`);
await post(buildCoderSession());
await post(buildTesterSession());
await post(buildApiSession());
console.log("Done. Open the Scope UI and click around — Single, Trajectory, Chat all have data now.");