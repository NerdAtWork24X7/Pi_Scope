/**
 * helpers.js — Shared pure helpers for the Pi Scope frontend.
 * Loaded before app.js so helpers are available on window.SCOPE.
 */
(function () {
  "use strict";

  function fmtTs(ts) {
    try { return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch { return ts?.slice(11, 19) ?? "?"; }
  }

  function fmtRel(ts) {
    if (!ts) return "";
    const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return s <= 0 ? "now" : `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

  function trunc(s, n) { if (!s) return ""; s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }

  function shortId(id) { return id?.slice(0, 8) ?? "?"; }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < String(s).length; i++) {
      h ^= String(s).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function toolNameColors(name) {
    const h = hashString(name);
    const hue = h % 360;
    const sat = 58 + ((h >>> 8) % 14);
    return {
      bg: `hsl(${hue} ${sat}% 22%)`,
      border: `hsl(${hue} ${Math.min(86, sat + 12)}% 46%)`,
      fg: `hsl(${hue} 92% 88%)`,
    };
  }

  function toolNamePillHTML(evt) {
    if (evt.type !== "tool_call" && evt.type !== "tool_result") return "";
    const name = evt.payload?.tool_name;
    if (!name) return "";
    const c = toolNameColors(name);
    return `<span class="tool-name-pill" title="${escapeHtml(name)}" style="--tool-bg:${c.bg};--tool-border:${c.border};--tool-fg:${c.fg}">${escapeHtml(trunc(name, 36))}</span>`;
  }

  function parseDuration(str) {
    const m = str.match(/^(\d+)([mh])$/);
    if (!m) return 0;
    const val = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === "m") return val * 60 * 1000;
    if (unit === "h") return val * 60 * 60 * 1000;
    return 0;
  }

  function fmtDuration(ms) {
    if (!ms || ms < 1000) return ms ? `${ms}ms` : "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  // Activity-window classification for the collapsed-sidebar status dot.
  function activityStatus(s) {
    if (!s?.last_ts) return "gray";
    const ageS = (Date.now() - new Date(s.last_ts).getTime()) / 1000;
    if (ageS <= 10) return "green";
    if (ageS <= 20) return "orange";
    return "gray";
  }

  function agentLetter(s) {
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? s.session_id ?? "?";
    const ch = String(name).trim().charAt(0).toUpperCase();
    return ch || "?";
  }

  // ─── Event rendering helpers ───────────────────────────────────────────────
  // These are shared across single, swimlane, and race views.

  // Find the LLM's final text response for the turn closed by `turnEnd`.
  // Scans backward through `events` (session-ordered by seq) and returns the last
  // assistant_message text (or agent_end.final_response) seen before the turn
  // ended. Empty string when nothing was captured.
  function turnFinalResponse(turnEnd, events) {
    if (!events || !events.length) return "";
    const sid = turnEnd.session_id;
    const ti = turnEnd.payload?.turn_index;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.seq > turnEnd.seq) continue;
      if (e.session_id !== sid) continue;
      if (ti != null && e.payload?.turn_index != null && e.payload.turn_index !== ti) continue;
      if (e.type === "agent_end" && e.payload?.final_response) return e.payload.final_response;
      if (e.type === "assistant_message") {
        const t = e.payload?.text ?? e.payload?.content ?? "";
        if (t) return t;
      }
    }
    return "";
  }

  function summaryFor(evt, events) {
    events = events || window.__SCOPE_STATE?.events;
    const p = evt.payload ?? {};
    switch (evt.type) {
      case "session_start": return `start · ${p.reason ?? "?"}`;
      case "session_shutdown": return `shutdown · ${p.reason ?? "?"}`;
      case "agent_start": return `▶ ${trunc(p.prompt, 80)}`;
      case "llm_request": {
        const parts = [`System prompt`];
        const tools = p.tools?.length ?? 0;
        if (tools) parts.push(`${tools} tools`);
        if (p.model) parts.push(p.model);
        if (p.message_count != null) parts.push(`${p.message_count} msgs`);
        return parts.join(" · ");
      }
      case "agent_end": {
        const base = `■ ${p.message_count ?? "?"} messages`;
        return p.final_response ? `${base} · ${trunc(p.final_response, 220)}` : base;
      }
      case "turn_start": return `turn #${p.turn_index ?? "?"}`;
      case "turn_end": {
        const fr = turnFinalResponse(evt, events);
        const base = `turn #${p.turn_index ?? "?"}`;
        const usage = p.usage ? ` · ${p.usage.total_tokens}tk` : "";
        return fr ? `${base}${usage} · ${trunc(fr, 200)}` : `${base}${usage}`;
      }
      case "user_message": return `you: ${trunc(p.text, 100)}`;
      case "assistant_message": return `ai: ${trunc(p.text, 100)} · ${p.usage?.total_tokens ?? 0}tk · $${(p.usage?.cost_total ?? 0).toFixed(4)}${p.latency_ms ? " · " + p.latency_ms + "ms" : ""}`;
      case "thinking": return `〽 ${trunc(p.text, 100)}`;
      case "tool_call": return `→ ${p.tool_name}(${trunc(JSON.stringify(p.args ?? {}), 60)})`;
      case "tool_result": return `← ${p.tool_name} · ${p.is_error ? "✗" : "✓"} · ${trunc(p.content_text, 80)}`;
      case "model_change": return `model: ${p.previous_model ?? "?"} → ${p.provider}/${p.model}`;
      case "compaction": return `📦 compact · ${p.tokens_before ?? "?"} tk → "${trunc(p.summary_preview, 60)}"`;
      case "branch_nav": return `🌿 branch · ${shortId(p.from_id)} → ${shortId(p.to_id)}`;
      case "error": return `! ${trunc(p.message, 100)}`;
      case "custom": return `${p.custom_type ?? "custom"}`;
      default: return "";
    }
  }

  function summaryClass(evt, events) {
    events = events || window.__SCOPE_STATE?.events;
    if (evt.type === "thinking") return "italic dim";
    if (evt.type === "agent_end") return evt.payload?.final_response ? "" : "dim";
    if (evt.type === "turn_end") return turnFinalResponse(evt, events) ? "" : "dim";
    if (["session_shutdown","turn_start"].includes(evt.type)) return "dim";
    return "";
  }

  function renderDetailHTML(evt) {
    const cBtn = `<button class="copy-btn" onclick="event.stopPropagation();SCOPE.copyEvent('${evt.event_id}')">📋</button>`;
    const wBtn = `<button class="wrap-btn" onclick="event.stopPropagation();let p=this.parentElement.querySelector('pre');p.style.whiteSpace=p.style.whiteSpace==='pre-wrap'?'pre':'pre-wrap';this.textContent=p.style.whiteSpace==='pre-wrap'?'↩':'→'">→</button>`;

    if (evt.type === "agent_end") {
      const fr = evt.payload?.final_response
        ? `<pre>${escapeHtml(evt.payload.final_response)}</pre>`
        : `<div class="race-llm-empty">no final response captured</div>`;
      return `${cBtn}${wBtn}<div style="margin:2px 0 6px;color:var(--muted);font-size:12px">final response · ${evt.payload?.message_count ?? "?"} messages</div>${fr}`;
    }

    if (evt.type === "turn_end") {
      const fr = turnFinalResponse(evt, window.__SCOPE_STATE?.events);
      const frHTML = fr
        ? `<pre>${escapeHtml(fr)}</pre>`
        : `<div class="race-llm-empty">no final response captured</div>`;
      return `${cBtn}${wBtn}<div style="margin:2px 0 6px;color:var(--muted);font-size:12px">final response · turn #${evt.payload?.turn_index ?? "?"}</div>${frHTML}<pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre>`;
    }

    const chips = [];
    if (evt.type === "tool_result" && evt.payload?.details_summary?.exit_code !== undefined) {
      const ec = evt.payload.details_summary.exit_code;
      chips.push(`<span class="exit-chip ${ec !== 0 ? 'err' : 'ok'}">exit ${ec}</span>`);
    }
    if (evt.type === "assistant_message") {
      if (evt.payload?.stop_reason) chips.push(`<span class="exit-chip ok">${escapeHtml(evt.payload.stop_reason)}</span>`);
      if (evt.payload?.latency_ms) chips.push(`<span class="exit-chip ok">${evt.payload.latency_ms}ms</span>`);
      if (evt.payload?.turn_index !== undefined) chips.push(`<span class="exit-chip ok">turn ${evt.payload.turn_index}</span>`);
    }
    return `${cBtn}${wBtn}${chips.join(" ")}<pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre>`;
  }

  // Approximate model context windows used for the context-bar percentage.
  const MODEL_CONTEXT_WINDOWS = [
    [/^claude-(haiku|sonnet|opus|3|4|5)/i, 200_000],
    [/^claude-/i, 200_000],
    [/^gpt-5/i, 400_000],
    [/^gpt-4o/i, 128_000],
    [/^gpt-4/i, 128_000],
    [/^o[13]/i, 200_000],
    [/^gemini-1\.5-pro/i, 2_000_000],
    [/^gemini-(2|3)/i, 1_000_000],
    [/^gemini-1\.5/i, 1_000_000],
    [/^gemini-/i, 1_000_000],
    [/^z-ai\/glm-4\.6/i, 200_000],
    [/^glm-/i, 128_000],
    // DeepSeek: pi treats these as 64k in its own context bar (verified against
    // a live deepseek-v4-flash session showing 9% with input=5683 → 5683/64000
    // ≈ 8.9%). Even though DeepSeek's API can physically accept 128k+, pi caps
    // the user-facing window at 64k as a conservative budget. We mirror pi's
    // value to keep our context % aligned with what the user sees in terminal.
    [/^deepseek/i, 64_000],
  ];
  const DEFAULT_CONTEXT_WINDOW = 128_000;
  function getContextWindow(model) {
    if (!model) return DEFAULT_CONTEXT_WINDOW;
    for (const [re, n] of MODEL_CONTEXT_WINDOWS) if (re.test(model)) return n;
    return DEFAULT_CONTEXT_WINDOW;
  }

  const HELPERS = {
    fmtTs,
    fmtRel,
    fmtTokens,
    trunc,
    shortId,
    escapeHtml,
    hashString,
    toolNameColors,
    toolNamePillHTML,
    parseDuration,
    fmtDuration,
    activityStatus,
    agentLetter,
    getContextWindow,
    turnFinalResponse,
    summaryFor,
    summaryClass,
    renderDetailHTML,
  };

  // Expose helpers on window.SCOPE so every view can access them explicitly.
  window.SCOPE = window.SCOPE || {};
  Object.assign(window.SCOPE, HELPERS);
})();
