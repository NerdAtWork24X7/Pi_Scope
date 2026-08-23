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
    // Tool chips follow the active DeepSeek theme: light tint on the light
    // theme, dark tint on the dark theme.
    const dark = typeof document !== "undefined" && document.body.hasAttribute("data-ds-dark-theme");
    return dark
      ? { bg: `hsl(${hue} ${sat}% 22%)`, border: `hsl(${hue} ${Math.min(86, sat + 12)}% 46%)`, fg: `hsl(${hue} 92% 88%)` }
      : { bg: `hsl(${hue} ${sat}% 92%)`, border: `hsl(${hue} ${Math.min(86, sat + 12)}% 74%)`, fg: `hsl(${hue} 55% 26%)` };
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

  // Subagent status for the expanded session list: red=stopped, orange=waiting, green=running.
  function subagentStatus(s) {
    if (s?.has_shutdown) return "red";
    if (!s?.last_ts) return "orange";
    const ageS = (Date.now() - new Date(s.last_ts).getTime()) / 1000;
    if (ageS <= 10) return "green";
    return "orange";
  }

  function agentLetter(s) {
    const name = s.agent_name ?? s.cwd?.split("/").pop() ?? s.session_id ?? "?";
    const ch = String(name).trim().charAt(0).toUpperCase();
    return ch || "?";
  }

  // ─── Event rendering helpers ───────────────────────────────────────────────
  // Shared by the single view (event rows, inline details, system-prompt modal).

  // Find the LLM's final text response for the turn closed by `turnEnd`.
  // Scans backward through `events` (session-ordered by seq) and returns the last
  // assistant_message text (or agent_end.final_response) seen before the turn
  // ended. Tries text first, then thinking, then falls back to tool_result
  // content (subagents often have tool-call-only assistant messages).  Returns
  // empty string when nothing was captured.
  function turnFinalResponse(turnEnd, events) {
    if (!events || !events.length) return "";
    const sid = turnEnd.session_id;
    const ti = turnEnd.payload?.turn_index;

    // agent_end fires *after* all turns and thus has a higher seq than any
    // turn_end — check it first (outside the seq-bound scan).
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.session_id !== sid) continue;
      if (e.type === "agent_end" && e.payload?.final_response) return e.payload.final_response;
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.seq > turnEnd.seq) continue;
      if (e.session_id !== sid) continue;
      if (ti != null && e.payload?.turn_index != null && e.payload.turn_index !== ti) continue;
      if (e.type === "assistant_message") {
        const t = e.payload?.text ?? e.payload?.content ?? "";
        if (t) return t;
        // tool-call-only message — try thinking as fallback
        const th = e.payload?.thinking ?? "";
        if (th) return th;
      }
    }
    // No assistant text found — fall back to last tool_result content in this
    // turn (subagents whose final message is all tool calls).
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.seq > turnEnd.seq) continue;
      if (e.session_id !== sid) continue;
      if (ti != null && e.payload?.turn_index != null && e.payload.turn_index !== ti) continue;
      if (e.type === "tool_result") {
        const ct = e.payload?.content_text ?? "";
        if (ct) return ct;
      }
    }
    return "";
  }

  // Fallback for agent_end when its own final_response field is missing.
  // Scans backward through events for the last assistant_message before
  // this agent_end (same session).  Mirrors turnFinalResponse but without
  // the turn_index filter.
  function agentFinalResponse(agentEnd, events) {
    if (!events || !events.length) return "";
    const sid = agentEnd.session_id;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.seq > agentEnd.seq) continue;
      if (e.session_id !== sid) continue;
      if (e.type === "assistant_message") {
        const t = e.payload?.text ?? e.payload?.content ?? "";
        if (t) return t;
        // tool-call-only message — try thinking as fallback
        const th = e.payload?.thinking ?? "";
        if (th) return th;
      }
    }
    // No assistant text found — fall back to last tool_result content.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.seq > agentEnd.seq) continue;
      if (e.session_id !== sid) continue;
      if (e.type === "tool_result") {
        const ct = e.payload?.content_text ?? "";
        if (ct) return ct;
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
        const turn = p.turn_index != null ? `turn #${p.turn_index}` : "";
        const model = p.model || "";
        const preview = p.user_msg_preview ? trunc(p.user_msg_preview, 100) : "";
        const parts = ["🡅", turn, model, preview].filter(Boolean);
        return parts.join(" · ");
      }
      case "agent_end": {
        const base = `■ ${p.message_count ?? "?"} messages`;
        const fr = p.final_response || agentFinalResponse(evt, events);
        return fr ? `${base} · ${trunc(fr, 220)}` : base;
      }
      case "turn_start": return `turn #${p.turn_index ?? "?"}`;
      case "turn_end": {
        const fr = turnFinalResponse(evt, events);
        const base = `turn #${p.turn_index ?? "?"}`;
        const usage = p.usage ? ` · ${p.usage.total_tokens}tk` : "";
        return fr ? `${base}${usage} · ${trunc(fr, 200)}` : `${base}${usage}`;
      }
      case "user_message": return `you: ${trunc(p.text, 100)}`;
      case "assistant_message": {
        const preview = p.text ? trunc(p.text, 200) : (p.thinking ? "💭 " + trunc(p.thinking, 100) : "tool call only");
        const cost = p.usage?.cost_total != null ? `$${p.usage.cost_total.toFixed(5)}` : "";
        const tk = p.usage?.total_tokens ? `${p.usage.total_tokens}tk` : "";
        const lat = p.latency_ms ? `${p.latency_ms}ms` : "";
        const tps = p.output_tps ? `~${p.output_tps}t/s` : "";
        const badges = [cost, tk, lat, tps].filter(Boolean).join(" ");
        return `ai · ${preview}${badges ? "  [" + badges + "]" : ""}`;
      }
      case "thinking": return `〽 ${trunc(p.text, 100)}`;
      case "tool_call": return `→ ${p.tool_name}(${trunc(JSON.stringify(p.args ?? {}), 60)})`;
      case "tool_result": return `← ${p.tool_name} · ${isToolResultError(p) ? "✗" : "✓"} · ${trunc(p.content_text, 80)}`;
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
    if (evt.type === "agent_end") return (evt.payload?.final_response || agentFinalResponse(evt, events)) ? "" : "dim";
    if (evt.type === "turn_end") return turnFinalResponse(evt, events) ? "" : "dim";
    if (["session_shutdown","turn_start"].includes(evt.type)) return "dim";
    return "";
  }

  function renderDetailHTML(evt) {
    const cBtn = `<button class="copy-btn" type="button" data-copy-event="${escapeHtml(evt.event_id)}">📋</button>`;
    const wBtn = `<button class="wrap-btn" onclick="event.stopPropagation();let p=this.parentElement.querySelector('pre');p.style.whiteSpace=p.style.whiteSpace==='pre-wrap'?'pre':'pre-wrap';this.textContent=p.style.whiteSpace==='pre-wrap'?'↩':'→'">→</button>`;

    // ── llm_request: show system prompt, tools, request args ────────────
    if (evt.type === "llm_request") {
      const p = evt.payload ?? {};
      let html = `${cBtn}${wBtn}`;
      if (p.system_prompt) html += `<details><summary style="color:var(--accent);cursor:pointer;font-size:12px">system prompt (${p.system_prompt.length} chars)</summary><pre style="max-height:300px;overflow:auto;margin-top:4px;white-space:pre-wrap">${escapeHtml(p.system_prompt)}</pre></details>`;
      if (p.tools?.length) html += `<div style="margin:2px 0;color:var(--muted);font-size:11px">${p.tools.length} tools: ${escapeHtml(p.tools.join(", "))}</div>`;
      if (p.request_args && Object.keys(p.request_args).length) html += `<div style="margin:2px 0;color:var(--muted);font-size:11px">args: ${escapeHtml(JSON.stringify(p.request_args))}</div>`;
      html += `<pre style="margin-top:4px">${escapeHtml(JSON.stringify(p, null, 2))}</pre>`;
      return html;
    }

    // ── assistant_message: text inline, thinking collapsible, stats ──────────
    if (evt.type === "assistant_message") {
      const p = evt.payload ?? {};
      const text = p.text ? escapeHtml(p.text) : "";
      const thinking = p.thinking ? `<details style="margin:4px 0"><summary style="color:var(--orange);cursor:pointer;font-size:12px">💭 thinking (${p.thinking.length} chars)</summary><pre style="border-left:3px solid var(--orange);padding-left:8px;margin-top:4px;white-space:pre-wrap;max-height:400px;overflow:auto">${escapeHtml(p.thinking)}</pre></details>` : "";
      const u = p.usage ?? {};
      const stats = [];
      if (u.total_tokens != null) stats.push(`${u.total_tokens} tokens`);
      if (u.cost_total != null) stats.push(`$${u.cost_total.toFixed(5)}`);
      if (u.input != null) stats.push(`${u.input} in / ${u.output ?? "?"} out`);
      if (u.cache_read) stats.push(`${u.cache_read} cache r`);
      if (u.cache_write) stats.push(`${u.cache_write} cache w`);
      if (p.latency_ms != null) stats.push(`${p.latency_ms}ms`);
      if (p.prefill_ms != null) stats.push(`prefill ${p.prefill_ms}ms`);
      if (p.output_tps != null) stats.push(`~${p.output_tps} t/s`);
      let html = `${cBtn}${wBtn}`;
      if (stats.length) html += `<div style="display:flex;flex-wrap:wrap;gap:3px 6px;margin-bottom:4px">${stats.map(s => `<span class="exit-chip ok">${escapeHtml(s)}</span>`).join("")}</div>`;
      if (text) html += `<pre style="white-space:pre-wrap;margin:0;line-height:1.5">${text}</pre>`;
      else if (!thinking) html += `<div class="llm-empty">tool call only</div>`;
      html += thinking;
      html += `<pre style="margin-top:6px">${escapeHtml(JSON.stringify(p, null, 2))}</pre>`;
      return html;
    }

    // ── tool_result: collapsible + scrollable content_text ──────────
    if (evt.type === "tool_result") {
      const p = evt.payload ?? {};
      const isErr = isToolResultError(p);
      let html = `${cBtn}${wBtn}`;
      if (isErr) {
        const summary = [];
        if (p.is_error === true) summary.push("is_error: true");
        const ec = p.details_summary?.exit_code;
        if (ec != null && ec !== 0) summary.push(`exit code ${ec}`);
        html += `<div class="llm-error-banner">⚠ ${escapeHtml(summary.join(", "))}</div>`;
      }
      const text = p.content_text || "";
      if (text) {
        const icon = isErr ? "✗" : "✓";
        const color = isErr ? "var(--red)" : "var(--green)";
        html += `<details open><summary style="cursor:pointer;font-size:12px;color:${color}">${escapeHtml(icon)} result (${text.length} chars)</summary><pre style="max-height:500px;overflow:auto;margin-top:4px;white-space:pre-wrap;border-left:2px solid ${color};padding:4px 8px;font-size:12px;line-height:1.4">${escapeHtml(text)}</pre></details>`;
      }
      html += `<pre style="margin-top:4px">${escapeHtml(JSON.stringify(p, null, 2))}</pre>`;
      return html;
    }

    if (evt.type === "agent_end") {
      const fr = evt.payload?.final_response || agentFinalResponse(evt, window.__SCOPE_STATE?.events);
      const frHTML = fr
        ? `<pre>${escapeHtml(fr)}</pre>`
        : `<div class="llm-empty">no final response captured</div>`;
      return `${cBtn}${wBtn}<div style="margin:2px 0 6px;color:var(--muted);font-size:12px">final response · ${evt.payload?.message_count ?? "?"} messages</div>${frHTML}`;
    }

    if (evt.type === "turn_end") {
      const fr = turnFinalResponse(evt, window.__SCOPE_STATE?.events);
      const frHTML = fr
        ? `<pre>${escapeHtml(fr)}</pre>`
        : `<div class="llm-empty">no final response captured</div>`;

      // Also find the agent_end event for this session — its final_response is
      // what gets sent back to the orchestrator.  Show it as a separate section
      // so the operator can distinguish the turn-level response from the
      // subagent's actual return value.
      let agentEndHTML = "";
      const events = window.__SCOPE_STATE?.events;
      if (events) {
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i];
          if (e.session_id !== evt.session_id) continue;
          if (e.type === "agent_end" && e.payload?.final_response) {
            const agentFr = e.payload.final_response;
            // Only show a separate section if it differs from the turn-level
            // response (avoid showing the same text twice).
            if (agentFr !== fr) {
              agentEndHTML = `<div style="margin:8px 0 4px;color:var(--accent);font-size:12px;font-weight:600">sent to orchestrator · ${e.payload?.message_count ?? "?"} messages</div><pre style="border-left:3px solid var(--accent);padding-left:10px">${escapeHtml(agentFr)}</pre>`;
            }
            break;
          }
        }
      }

      return `${cBtn}${wBtn}<div style="margin:2px 0 6px;color:var(--muted);font-size:12px">final response · turn #${evt.payload?.turn_index ?? "?"}</div>${frHTML}${agentEndHTML}<pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre>`;
    }

    const chips = [];
    if (evt.type === "tool_result" && evt.payload?.details_summary?.exit_code !== undefined) {
      const ec = evt.payload.details_summary.exit_code;
      chips.push(`<span class="exit-chip ${ec !== 0 || isToolResultError(evt.payload) ? 'err' : 'ok'}">exit ${ec}</span>`);
    } else if (evt.type === "tool_result" && isToolResultError(evt.payload)) {
      chips.push(`<span class="exit-chip err">failed</span>`);
    }
    if (evt.type === "assistant_message") {
      if (evt.payload?.stop_reason) chips.push(`<span class="exit-chip ok">${escapeHtml(evt.payload.stop_reason)}</span>`);
      if (evt.payload?.latency_ms) chips.push(`<span class="exit-chip ok">${evt.payload.latency_ms}ms</span>`);
      if (evt.payload?.turn_index !== undefined) chips.push(`<span class="exit-chip ok">turn ${evt.payload.turn_index}</span>`);
    }
    if (evt.type === "llm_request") {
      if (evt.payload?.model) chips.push(`<span class="exit-chip ok">${escapeHtml(evt.payload.model)}</span>`);
      if (evt.payload?.turn_index != null) chips.push(`<span class="exit-chip ok">turn ${evt.payload.turn_index}</span>`);
      if (evt.payload?.message_count != null) chips.push(`<span class="exit-chip ok">${evt.payload.message_count} msgs</span>`);
      const tools = evt.payload?.tools?.length ?? 0;
      if (tools) chips.push(`<span class="exit-chip ok">${tools} tools</span>`);
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

  // Render the boot-snapshot LLM request (system prompt + tools + model +
  // request args) for the single-view system-prompt modal.
  function renderLLMRequestHTML(payload) {
    if (!payload) {
      return `<div class="llm-empty">No system prompt captured. It is recorded from the final LLM request (before_provider_request → llm_request) only.</div>`;
    }
    const parts = [];
    parts.push(`
      <section class="llm-section">
        <h4>System prompt</h4>
        ${payload.system_prompt ? `<pre class="llm-pre">${escapeHtml(payload.system_prompt)}</pre>` : `<div class="llm-empty">not captured</div>`}
      </section>
    `);
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const toolsHTML = tools.length
      ? `<ul class="llm-tools">` + tools.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join("") + `</ul>`
      : `<div class="llm-empty">no tools captured</div>`;
    parts.push(`<section class="llm-section"><h4>Tools (${tools.length}) sent to LLM</h4>${toolsHTML}</section>`);
    if (payload.model) parts.push(`<section class="llm-section"><h4>Model</h4><div class="llm-empty">${escapeHtml(payload.model)}</div></section>`);
    if (payload.turn_index != null) parts.push(`<section class="llm-section"><h4>Turn</h4><div class="llm-empty">#${payload.turn_index}</div></section>`);
    if (payload.message_count != null) parts.push(`<section class="llm-section"><h4>Messages</h4><div class="llm-empty">${payload.message_count}</div></section>`);
    if (payload.user_msg_preview) parts.push(`<section class="llm-section"><h4>User message (preview)</h4><pre class="llm-pre">${escapeHtml(payload.user_msg_preview)}</pre></section>`);
    if (payload.request_args && Object.keys(payload.request_args).length) {
      const rows = Object.entries(payload.request_args)
        .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td><code>${escapeHtml(String(v))}</code></td></tr>`)
        .join("");
      parts.push(`<section class="llm-section"><h4>Request args</h4><table class="llm-args">${rows}</table></section>`);
    }
    return parts.join("");
  }

  // Live-event pulse color for the single view's `.evt-new` entry animation.
  // Live-entry pulse tints use the DeepSeek palette (translucent so they read
  // on both the light and dark themes).
  const PULSE_GREEN = "rgba(34,197,94,0.20)";
  const PULSE_TYPE_COLORS = {
    user_message:      "rgba(86,134,254,0.16)",
    assistant_message: "rgba(86,134,254,0.16)",
    tool_call:         "rgba(245,158,11,0.18)",
    tool_result:       "rgba(247,173,49,0.20)",
    thinking:          "rgba(124,58,237,0.16)",
    error:             "rgba(239,68,68,0.18)",
    model_change:      "rgba(8,145,178,0.16)",
    compaction:        "rgba(221,134,41,0.20)",
    branch_nav:        "rgba(8,145,178,0.16)",
  };
  function pulseColorFor(type) {
    return PULSE_TYPE_COLORS[type] || PULSE_GREEN;
  }
  window.__pulseColorFor = pulseColorFor;

  /**
   * A tool_result is an error if payload.is_error is true *or* the exit code is
   * non-zero. Many tools report failure via exit code without setting is_error.
   */
  function isToolResultError(payload) {
    if (!payload) return false;
    if (payload.is_error === true) return true;
    const ec = payload.details_summary?.exit_code;
    // Treat any non-null, non-zero exit code as an error (0 = success).
    if (ec != null && ec !== 0) return true;
    return false;
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
    subagentStatus,
    agentLetter,
    getContextWindow,
    turnFinalResponse,
    agentFinalResponse,
    summaryFor,
    summaryClass,
    renderDetailHTML,
    renderLLMRequestHTML,
  };

  // Expose helpers on window.SCOPE so every view can access them explicitly.
  window.SCOPE = window.SCOPE || {};
  Object.assign(window.SCOPE, HELPERS);
  window.SCOPE.isToolResultError = isToolResultError;
})();
