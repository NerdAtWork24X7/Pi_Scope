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
    // Coerce once — the old loop called String(s) on every iteration.
    const str = String(s);
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
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
  // The session's turn lifecycle is the ground truth for "still working": a
  // turn stays open from turn_start until turn_end, so a long tool call or a
  // wait on a dispatched subagent keeps the row green instead of flipping to
  // "waiting" when the 10s activity window lapses. Only after turn_end (the
  // agent finished and is waiting for the next prompt) does it turn orange.
  function subagentStatus(s) {
    if (s?.has_shutdown) return "red";
    if (s?.last_turn_event === "turn_start") {
      // An OPEN turn only reads "working" while the server can vouch for it.
      // The server annotates every session with `turn_live`: a turn that began
      // before the server's current run — the pi that opened it was killed when
      // the app was closed — or one the server knows is gone is NOT live, so the
      // row must not stay green forever after the process is gone. Absent (an
      // older server or a fixture that predates the field) keeps the historical
      // "the open turn is the truth" behaviour.
      return s.turn_live === false ? "orange" : "green";
    }
    if (s?.last_turn_event === "turn_end") return "orange";
    // Sessions with no captured turn events (older harnesses, capture-only
    // sessions) fall back to the recency heuristic.
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
  // ── Memo for the two backward scans below ────────────────────────────────
  // turnFinalResponse / agentFinalResponse walk the WHOLE event list backwards,
  // and the Single view calls them once or twice per rendered row — a long
  // session therefore re-scanned thousands of events per row, which is O(n²)
  // over a render (and over the event stream while a search filter is on).
  //
  // The cache is keyed by the event-list identity plus its length and last
  // event: any append changes that key, so nothing stale can outlive new
  // events. Results only depend on events up to the row's own seq, which later
  // (higher-seq) appends can never change — recomputation after an append is
  // merely wasted, never wrong.
  const finalResponseCache = new WeakMap();
  function finalResponseCacheFor(events) {
    const last = events.length ? events[events.length - 1] : null;
    const key = events.length + "|" + (last?.event_id || last?.seq || "");
    let holder = finalResponseCache.get(events);
    if (!holder || holder.key !== key) {
      holder = { key, turn: new Map(), agent: new Map() };
      finalResponseCache.set(events, holder);
    }
    return holder;
  }

  function turnFinalResponse(turnEnd, events) {
    if (!events || !events.length) return "";
    const cache = finalResponseCacheFor(events);
    const ck = `${turnEnd.session_id}|${turnEnd.payload?.turn_index ?? ""}|${turnEnd.seq}`;
    if (cache.turn.has(ck)) return cache.turn.get(ck);
    const out = turnFinalResponseUncached(turnEnd, events);
    cache.turn.set(ck, out);
    return out;
  }

  function turnFinalResponseUncached(turnEnd, events) {
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
    const cache = finalResponseCacheFor(events);
    const ck = `${agentEnd.session_id}|${agentEnd.seq}`;
    if (cache.agent.has(ck)) return cache.agent.get(ck);
    const out = agentFinalResponseUncached(agentEnd, events);
    cache.agent.set(ck, out);
    return out;
  }

  function agentFinalResponseUncached(agentEnd, events) {
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
      if (p.system_prompt) html += `<details><summary style="color:var(--accent-ink);cursor:pointer;font-size:12px">system prompt (${p.system_prompt.length} chars)</summary><pre style="max-height:300px;overflow:auto;margin-top:4px;white-space:pre-wrap">${escapeHtml(p.system_prompt)}</pre></details>`;
      if (p.tools?.length) html += `<div style="margin:2px 0;color:var(--muted);font-size:11px">${p.tools.length} tools: ${escapeHtml(p.tools.join(", "))}</div>`;
      if (p.request_args && Object.keys(p.request_args).length) html += `<div style="margin:2px 0;color:var(--muted);font-size:11px">args: ${escapeHtml(JSON.stringify(p.request_args))}</div>`;
      html += `<details><summary style="cursor:pointer;font-size:12px;color:var(--muted)">📄 raw JSON</summary><pre style="margin-top:4px">${escapeHtml(JSON.stringify(p, null, 2))}</pre></details>`;
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
      html += `<details><summary style="cursor:pointer;font-size:12px;color:var(--muted)">📄 raw JSON</summary><pre style="margin-top:6px">${escapeHtml(JSON.stringify(p, null, 2))}</pre></details>`;
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
      html += `<details><summary style="cursor:pointer;font-size:12px;color:var(--muted)">📄 raw JSON</summary><pre style="margin-top:4px">${escapeHtml(JSON.stringify(p, null, 2))}</pre></details>`;
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
              agentEndHTML = `<div style="margin:8px 0 4px;color:var(--accent-ink);font-size:12px;font-weight:600">sent to orchestrator · ${e.payload?.message_count ?? "?"} messages</div><pre style="border-left:3px solid var(--accent);padding-left:10px">${escapeHtml(agentFr)}</pre>`;
            }
            break;
          }
        }
      }

      return `${cBtn}${wBtn}<div style="margin:2px 0 6px;color:var(--muted);font-size:12px">final response · turn #${evt.payload?.turn_index ?? "?"}</div>${frHTML}${agentEndHTML}<details><summary style="cursor:pointer;font-size:12px;color:var(--muted)">📄 raw JSON</summary><pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre></details>`;
    }

    // tool_result never reaches here — its own branch above returns first.
    const chips = [];
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
    return `${cBtn}${wBtn}${chips.join(" ")}<details><summary style="cursor:pointer;font-size:12px;color:var(--muted)">📄 raw JSON</summary><pre>${escapeHtml(JSON.stringify(evt.payload, null, 2))}</pre></details>`;
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

  /**
   * Transient bottom-center toast, for one-off messages that must not take over
   * a view's own status/banner row (e.g. the terminal refusing a workspace cd
   * while another program owns the PTY). `kind` is "err" | "warn" | undefined.
   * Re-used by any view; creates its element lazily and restarts the enter
   * animation on a re-toast.
   */
  let _toastEl = null, _toastTimer = null;
  function toast(msg, kind) {
    if (!_toastEl) {
      _toastEl = document.createElement("div");
      _toastEl.id = "scope-toast";
      _toastEl.className = "scope-toast";
      _toastEl.setAttribute("role", "status");
      _toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.toggle("err", kind === "err");
    _toastEl.classList.toggle("warn", kind === "warn");
    clearTimeout(_toastTimer);
    _toastEl.classList.remove("show");
    void _toastEl.offsetWidth; // force reflow so the animation replays
    _toastEl.classList.add("show");
    _toastTimer = setTimeout(() => _toastEl.classList.remove("show"), 3200);
  }
  // ─── Markdown rendering ────────────────────────────────────────────────────
  // A small, dependency-free markdown renderer shared by the desktop Chat view
  // and the phone layout: fenced code blocks, headings, lists, quotes,
  // bold/italic/strikethrough, inline code and links. Callers pass a
  // `codeBlock(lang, code)` to draw fenced code their own way (the desktop adds
  // a copy button, the phone a compact header), so the parse itself stays
  // identical across clients. Input is escaped first, then inline forms are
  // pulled out in order so one can't inject into another.

  // ─── Media in message / result text ───────────────────────────────────────
  // pi can hand back a picture — a screenshot, a chart, a generated diagram, a
  // pasted data: URI — or a video (a direct file, or a YouTube link) as a
  // markdown image, a bare URL, or a raw data: URI. These find those sources so
  // a view can DRAW them, and gate each one to a scheme a browser may safely
  // load (never a javascript:/vbscript: smuggled in as an image/video source).
  const IMAGE_MD_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;
  const IMAGE_DATA_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
  const IMAGE_URL_RE = /https?:\/\/[^\s"'<>()]+/gi;
  // A URL that names a picture file (optionally with a ?query / #fragment tail).
  const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#][^\s"'<>)]*)?$/i;
  // Characters that hug a URL in running text but are never part of it: sentence
  // punctuation and the markdown delimiters a reply wraps a link in — an inline
  // code span (`https://…/a.png`) or bold (**https://…/a.png**). Left on the
  // match they fail the file test (the picture is never drawn), and a URL that
  // only survived because a ?query came after the extension would carry the
  // delimiter straight into its src and 404.
  const URL_TRAIL_RE = /[.,;:!?'"`*]+$/;
  // A direct video file, and YouTube, whose still frame we can derive from the
  // link alone (…/watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID).
  const VIDEO_FILE_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)(?:[?#][^\s"'<>)]*)?$/i;
  const VIDEO_HOST_RE = /(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
  // A filesystem path pi printed in place of a URL — "saved to tmp/chart.png",
  // "./shot.jpg", "/home/me/clip.mp4". pi can hand back a picture it wrote to
  // disk instead of an http link, and the browser cannot load that on its own;
  // the view turns it into a served URL via a caller-supplied resolver (see
  // mediaInText's opts.resolve). The lookahead keeps a real URL (which has
  // "://") out of the match — those are found by IMAGE_URL_RE above. `[` is NOT a
  // boundary, so a markdown link's label ("[chart.png](…)") is never mistaken for
  // a path — only its parenthesised target is, via `(`.
  const LOCAL_MEDIA_RE = /(^|[\s`"'\(])((?![a-z][a-z0-9+.-]*:\/\/)[\w.@~+-]*(?:\/[\w.@~+-]+)*\.(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|ogv|ogg|mov|m4v))(?![\w-])/gi;
  // A single result can carry a whole deck of media; cap what we paint so a
  // pathological payload can't stretch the page (or the DOM) without bound.
  const MAX_RESULT_MEDIA = 12;

  function mediaSrcAllowed(u) {
    const scheme = String(u).match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme && !/^(https?|data)$/i.test(scheme[1])) return false;
    if (/^data:/i.test(u) && !/^data:image\//i.test(u)) return false;
    return true;
  }

  // "image" or "video" — decided from the source alone.
  function mediaKind(src) {
    if (VIDEO_FILE_RE.test(src) || VIDEO_HOST_RE.test(src)) return "video";
    return "image";
  }

  // A still frame for a video we cannot download ourselves: YouTube exposes one
  // per id, keyed off the link alone.
  function videoPoster(src) {
    const yt = String(src).match(VIDEO_HOST_RE);
    if (yt) return `https://img.youtube.com/vi/${yt[1]}/mqdefault.jpg`;
    return "";
  }

  // The URL a view should actually load for `u`. http(s)/inline data sources pass
  // through unchanged; a local path is handed to the caller's `opts.resolve`, which
  // returns a servable URL (the Chat views build a sandboxed /media link) or "" —
  // and "" means we cannot show it, so the reference is left as plain text.
  function mediaSrc(u, opts) {
    const s = String(u == null ? "" : u);
    if (!s) return "";
    if (/^(?:https?:|data:)/i.test(s)) return s;
    const resolve = opts && typeof opts.resolve === "function" ? opts.resolve : null;
    return resolve ? String(resolve(s) || "") : "";
  }

  // Every picture or video `raw` references, in the order the text mentions them,
  // de-duplicated and capped. `alt` carries the markdown alt text when the source
  // had one; `kind` is "image" | "video"; a video's `poster` is a still frame
  // when one can be derived without fetching the video. A source that is a local
  // path (not a URL) is only kept when `opts.resolve` can serve it; its row then
  // carries `local: true` and `name` (the original path, for the label).
  function mediaInText(raw, opts) {
    const text = String(raw == null ? "" : raw);
    const found = [];
    const add = (src, alt, at) => { if (src) found.push({ src: String(src).replace(/\s+$/, ""), alt: alt || "", at }); };
    for (const m of text.matchAll(IMAGE_MD_RE)) add(m[2], m[1], m.index);
    for (const m of text.matchAll(IMAGE_DATA_RE)) add(m[0], "", m.index);
    for (const m of text.matchAll(IMAGE_URL_RE)) {
      const u = m[0].replace(URL_TRAIL_RE, "");
      if (IMAGE_FILE_RE.test(u) || VIDEO_FILE_RE.test(u) || VIDEO_HOST_RE.test(u)) add(u, "", m.index);
    }
    // A path pi wrote to instead of a link ("saved to tmp/chart.png"). Only
    // searched when the caller can serve it, so a view with no workspace context
    // never invents rows it cannot load.
    if (opts && typeof opts.resolve === "function") {
      for (const m of text.matchAll(LOCAL_MEDIA_RE)) add(m[2], "", m.index);
    }
    found.sort((a, b) => a.at - b.at);
    const out = [];
    const seen = new Set();
    for (const f of found) {
      if (out.length >= MAX_RESULT_MEDIA) break;
      if (!mediaSrcAllowed(f.src)) continue;
      const key = f.src.length + ":" + f.src.slice(0, 64);
      if (seen.has(key)) continue;
      seen.add(key);
      // http(s)/data flow straight through; a local path must resolve to a real
      // source or it is dropped (nothing to draw).
      const isUrl = /^(?:https?:|data:)/i.test(f.src);
      let src = f.src;
      let name = "";
      let local = false;
      if (!isUrl) {
        const served = opts && typeof opts.resolve === "function" ? String(opts.resolve(f.src) || "") : "";
        if (!served || !mediaSrcAllowed(served)) continue;
        src = served; name = f.src; local = true;
      }
      const kind = mediaKind(f.src);
      out.push({ src, alt: f.alt, kind, local, name, poster: kind === "video" ? videoPoster(f.src) : "" });
    }
    // `localOnly` is for a caller that draws markdown/URL pictures INLINE in the
    // prose: the only reference it cannot draw itself is a bare local path
    // ("saved to tmp/chart.png"), so the table is narrowed to exactly those and
    // a picture never appears twice.
    return opts && opts.localOnly ? out.filter((m) => m.local) : out;
  }

  // A short label for the table's Name column: a YouTube id, the last path
  // segment of a URL, or the media type of an inline data: URI.
  function mediaFileName(src) {
    const s = String(src || "");
    const yt = s.match(VIDEO_HOST_RE);
    if (yt) return `youtube.com — ${yt[1]}`;
    if (/^data:/i.test(s)) {
      const m = s.match(/^data:((?:image|video)\/[a-z0-9.+-]+);/i);
      return m ? `inline ${m[1].replace(/^(?:image|video)\//, "")}` : "inline media";
    }
    // Drop any ?query / #fragment, then take the last path segment.
    const seg = s.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
    if (!seg) return "media";
    try { return decodeURIComponent(seg); } catch { return seg; }
  }

  // Order a table's rows biggest item first. Run once every row has been
  // measured (or failed), so the order follows real pixel area rather than the
  // order the text happened to mention them.
  function sortMediaRows(tbody) {
    if (!tbody) return;
    const rows = [...tbody.querySelectorAll("tr.img-row")];
    rows.sort((a, b) => (Number(b.dataset.imgArea) || 0) - (Number(a.dataset.imgArea) || 0));
    for (const r of rows) tbody.appendChild(r);
  }

  // The thumbnail cell for one item. An image is drawn directly; a video gets a
  // play badge over either its still frame (a poster, when we can derive one) or
  // a muted <video> that shows its own first frame. Either way the whole cell is
  // a link to the source.
  function mediaThumbHtml(im) {
    const src = escapeHtml(im.src);
    const alt = escapeHtml(im.alt);
    const link = (inner) =>
      `<a class="result-image${im.kind === "video" ? " result-video" : ""}" href="${src}" target="_blank" rel="noopener noreferrer">` +
      `${inner}${im.kind === "video" ? `<span class="media-play" aria-hidden="true"></span>` : ""}</a>`;
    if (im.kind === "video") {
      return im.poster
        ? link(`<img src="${escapeHtml(im.poster)}" alt="${alt}" loading="lazy" decoding="async">`)
        : link(`<video src="${src}" preload="metadata" muted playsinline></video>`);
    }
    return link(`<img src="${src}" alt="${alt}" loading="lazy" decoding="async">`);
  }

  // The table every picture or video a result references is drawn in — one row
  // per item: a thumbnail, its name (a link to the source), and its pixel
  // dimensions. The size cell starts as a placeholder; hydrateMediaTables fills
  // it and re-orders the rows. A thumbnail is lazy so a transcript full of them
  // only loads what is on screen.
  //
  // The whole table folds behind a <summary> that reads like a Thought block's
  // header — an accent label with a line icon and a ▸ caret — so a deck of media
  // collapses the same way a thought does. It starts COLLAPSED to keep a result
  // scannable; the count badge on the summary keeps the media discoverable while
  // folded.
  function mediaTableHtml(items) {
    if (!items || !items.length) return "";
    const count = items.length;
    const icon =
      `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
    const rows = items.map((im) => {
      const name = im.alt || im.name || mediaFileName(im.src);
      const href = escapeHtml(im.src);
      return (
        `<tr class="img-row" data-kind="${im.kind}"${im.local ? ' data-local="1"' : ""}>` +
        `<td class="img-cell img-cell-thumb">${mediaThumbHtml(im)}</td>` +
        `<td class="img-cell img-cell-name"><a href="${href}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(name)}">${escapeHtml(name)}</a></td>` +
        `<td class="img-cell img-cell-size" data-img-size>measuring…</td>` +
        `</tr>`
      );
    }).join("");
    return (
      `<details class="result-media">` +
      `<summary class="result-media-sum">` +
      `<span class="result-media-label">${icon}Media</span>` +
      `<span class="result-media-count">${count}</span>` +
      `</summary>` +
      `<div class="result-images img-gallery"><table class="image-table">` +
      `<thead><tr><th class="img-cell img-cell-thumb">Media</th><th class="img-cell img-cell-name">Name</th><th class="img-cell img-cell-size">Size</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>` +
      `</details>`
    );
  }
  function resultMediaHtml(raw, opts) {
    return mediaTableHtml(mediaInText(raw, opts));
  }

  // Measure every rendered media table under `root` (a DOM node), filling each
  // row's size cell from the loaded image's natural dimensions (or the video's
  // intrinsic size) and putting the rows in largest-first order. Idempotent: a
  // table already measured is skipped, and an item still in flight re-orders the
  // rows when it lands.
  function hydrateMediaTables(root) {
    const scope = root || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    for (const table of scope.querySelectorAll("table.image-table")) {
      if (table.dataset.measured === "1") continue;
      table.dataset.measured = "1";
      const tbody = table.querySelector("tbody");
      const rows = tbody ? [...tbody.querySelectorAll("tr.img-row")] : [];
      let pending = rows.length;
      // Drop rows that referenced a local path which turned out not to exist — a
      // 404'd thumbnail is worse than no row at all — and remove the whole table
      // (its wrapper) once no row is left.
      const finalize = () => {
        if (tbody && !tbody.querySelectorAll("tr.img-row").length) {
          const node =
            (table.closest ? table.closest(".result-media") : null) ||
            (table.closest ? table.closest(".result-images") : null) ||
            table;
          if (node.remove) node.remove();
          return;
        }
        sortMediaRows(tbody);
      };
      const done = () => { if (--pending <= 0) finalize(); };
      const settle = (row, el) => {
        const w = el.naturalWidth || el.videoWidth || 0;
        const h = el.naturalHeight || el.videoHeight || 0;
        const cell = row.querySelector("[data-img-size]");
        if (w && h) {
          row.dataset.imgArea = String(w * h);
          if (cell) cell.textContent = `${w} × ${h}`;
        } else if (cell) {
          cell.textContent = "unavailable";
        }
      };
      for (const row of rows) {
        const el = row.querySelector("img, video");
        if (!el) { done(); continue; }
        const isVideo = typeof el.videoWidth === "number";
        const ready = isVideo ? el.readyState >= 1 : !!el.complete;
        const broken = isVideo ? !!el.error : (el.complete && el.naturalWidth === 0);
        const isLocal = row.dataset && row.dataset.local === "1";
        if (ready) {
          // Already errored before we attached (a cached/instant failure): a local
          // path is dropped, anything else is labelled unavailable.
          if (broken && isLocal) row.remove();
          else settle(row, el);
          done();
        } else {
          const ev = isVideo ? "loadedmetadata" : "load";
          el.addEventListener(ev, () => { settle(row, el); done(); }, { once: true });
          el.addEventListener("error", () => {
            if (isLocal) row.remove();
            else settle(row, el);
            done();
          }, { once: true });
        }
      }
      if (!pending) finalize();
    }
  }

  // Inline formatting on ALREADY-ESCAPED text. `opts.dropImages` keeps a picture
  // out of the text flow — a markdown embed is dropped, a link that points at one
  // still reads as a link — because the Chat views draw the media themselves, in
  // a thumbnail table (see mediaTableHtml). Any other bare URL is turned into a
  // link either way, so a URL pi prints is always clickable.
  function markdownInline(text, opts) {
    const dropImages = !!(opts && opts.dropImages);
    const prot = [];
    const stash = (html) => { prot.push(html); return "\x01" + (prot.length - 1) + "\x01"; };
    text = text.replace(/`([^`\n]+)`/g, (m, c) => stash(`<code>${c}</code>`));
    // Images first, so the link rule below doesn't eat the "[alt](url)" part.
    text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, u) => {
      // Only http(s), inline data images, or a local path the caller can serve —
      // never a javascript:/vbscript: style scheme smuggled in as an image source.
      if (!mediaSrcAllowed(u)) return m;
      const src = mediaSrc(u, opts);
      if (!src) return m;
      if (dropImages) return "";
      return stash(`<a href="${src}" target="_blank" rel="noopener noreferrer"><img src="${src}" alt="${alt}" loading="lazy" decoding="async"></a>`);
    });
    // A link to a picture is drawn AS the picture — pi commonly returns an image
    // as `[name.jpg](https://…/name.jpg)`, and a bare link leaves the reader with
    // a filename instead of the photo. A link to a local media file
    // (`[chart](tmp/chart.png)`) is resolved to a servable URL when the caller
    // can, and otherwise left as literal text. With dropImages a picture link
    // stays a plain link, and the photo is drawn in the table instead.
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, l, u) => {
      const isHttp = /^https?:\/\//i.test(u);
      // Only an http(s) link or a local media path is handled here; a data:,
      // mailto: or javascript: target is left as literal text.
      const isLocalMedia =
        !isHttp && !/^[a-z][a-z0-9+.-]*:/i.test(u) && (IMAGE_FILE_RE.test(u) || VIDEO_FILE_RE.test(u));
      if (!isHttp && !isLocalMedia) return m;
      const url = mediaSrc(u, opts);
      if (!url) return m;
      return (!dropImages && IMAGE_FILE_RE.test(u))
        ? stash(`<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="${l}" loading="lazy" decoding="async"></a>`)
        : stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${l}</a>`);
    });
    // A bare image source with no markdown around it — pi sometimes returns just
    // the URL, or a data: URI — is drawn as a picture too. Runs after the link
    // rule, so a "[label](url)" link is already stashed and left alone.
    text = text.replace(/(^|[\s(])(data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s<>()"']+)/gi, (m, pre, u) => {
      const clean = u.replace(/[.,;:!?]+$/, "");
      const tail = u.slice(clean.length);
      if (!/^data:image\//i.test(clean) && !IMAGE_FILE_RE.test(clean)) return m;
      if (dropImages) return m;
      return pre + stash(`<img src="${clean}" alt="" loading="lazy" decoding="async">`) + tail;
    });
    // Any remaining bare URL — a plain link pi printed, a video page, a path with
    // no picture or video extension — becomes a real link, so a URL in a result
    // is always clickable. Markdown links and the sources above are already
    // stashed as placeholders, so only a truly bare URL reaches here.
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>()"']+)/gi, (m, pre, u) => {
      const clean = u.replace(/[.,;:!?]+$/, "");
      const tail = u.slice(clean.length);
      return pre + stash(`<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>`) + tail;
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => stash(`<strong>${t}</strong>`));
    text = text.replace(/~~([^~\n]+)~~/g, (m, t) => stash(`<del>${t}</del>`));
    text = text.replace(/\*([^*\n]+)\*/g, (m, t) => stash(`<em>${t}</em>`));
    return text.replace(/\x01(\d+)\x01/g, (m, i) => prot[+i] || "");
  }

  function defaultCodeBlock(lang, code) {
    return `<pre class="md-code"><code>${escapeHtml(code)}</code></pre>`;
  }

  // A table row: `| a | b |` → ["a", "b"] (outer pipes optional).
  function mdRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }
  // The `|---|---|` divider that turns the line above it into a table header.
  function mdTableSep(line) {
    if (!line.includes("|") || !line.includes("-")) return false;
    return mdRow(line).every((c) => /^:?-+:?$/.test(c));
  }
  // `:--` left, `--:` right, `:-:` centre, `---` default.
  function mdAlign(cell) {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  }

  // Render `raw` markdown to HTML. `opts.codeBlock(lang, code)` overrides how a
  // fenced block is drawn (default: a bare <pre><code>).
  function markdownHtml(raw, opts) {
    const codeBlock = (opts && typeof opts.codeBlock === "function") ? opts.codeBlock : defaultCodeBlock;
    const fences = [];
    let text = String(raw == null ? "" : raw).replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      fences.push({ lang: (lang || "").trim(), code: code.replace(/\n\s*$/, "") });
      return "\x00F" + (fences.length - 1) + "\x00";
    });
    text = markdownInline(escapeHtml(text), opts);

    const lines = text.split("\n");
    const blocks = [];
    let i = 0;
    const flush = (cur) => {
      if (cur) {
        if (cur.lines && cur.lines.join("").trim()) blocks.push(cur);
        else if (cur.type !== "p") blocks.push(cur);
      }
    };
    let cur = null;
    while (i < lines.length) {
      const ln = lines[i];
      const fm = ln.match(/^\x00F(\d+)\x00$/);
      if (fm) { flush(cur); cur = null; blocks.push({ type: "code", idx: +fm[1] }); i++; continue; }
      const hm = ln.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { flush(cur); cur = null; blocks.push({ type: "head", level: hm[1].length, html: hm[2] }); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { flush(cur); cur = null; blocks.push({ type: "hr" }); i++; continue; }
      if (!ln.trim()) { flush(cur); cur = null; i++; continue; }
      // Table: a header row with pipes, then a |---| alignment row.
      if (ln.includes("|") && i + 1 < lines.length && mdTableSep(lines[i + 1])) {
        flush(cur); cur = null;
        const header = mdRow(ln);
        const align = mdRow(lines[i + 1]).map(mdAlign);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(mdRow(lines[i]));
          i++;
        }
        blocks.push({ type: "table", header, align, rows });
        continue;
      }
      const lm = ln.match(/^\s*[-*•]\s+(.*)$/);
      if (lm) {
        flush(cur); cur = null;
        const items = [];
        while (i < lines.length) {
          const s = lines[i].trim();
          if (!s) break;
          const it = s.match(/^[-*•]\s+(.*)$/);
          if (!it) break;
          items.push(it[1]); i++;
        }
        blocks.push({ type: "ul", items });
        continue;
      }
      const om = ln.match(/^\s*\d+[.)]\s+(.*)$/);
      if (om) {
        flush(cur); cur = null;
        const items = [];
        while (i < lines.length) {
          const s = lines[i].trim();
          if (!s) break;
          const it = s.match(/^\d+[.)]\s+(.*)$/);
          if (!it) break;
          items.push(it[1]); i++;
        }
        blocks.push({ type: "ol", items });
        continue;
      }
      if (/^&gt;\s?/.test(ln)) {
        flush(cur); cur = null;
        const q = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
        blocks.push({ type: "quote", lines: q });
        continue;
      }
      if (!cur) cur = { type: "p", lines: [] };
      cur.lines.push(ln);
      i++;
    }
    flush(cur);

    const h = [];
    for (const b of blocks) {
      if (b.type === "code") {
        const f = fences[b.idx];
        if (!f) continue;
        h.push(codeBlock(f.lang, f.code));
        continue;
      }
      if (b.type === "hr") { h.push("<hr>"); continue; }
      if (b.type === "head") { const tag = b.level <= 2 ? "h3" : "h4"; h.push(`<${tag}>${b.html}</${tag}>`); continue; }
      if (b.type === "ul") { h.push("<ul>" + b.items.map((x) => `<li>${x}</li>`).join("") + "</ul>"); continue; }
      if (b.type === "ol") { h.push("<ol>" + b.items.map((x) => `<li>${x}</li>`).join("") + "</ol>"); continue; }
      if (b.type === "quote") { h.push("<blockquote>" + b.lines.map((x) => `<p>${x}</p>`).join("") + "</blockquote>"); continue; }
      if (b.type === "table") {
        const cell = (tag, c, k) => {
          const a = b.align[k];
          return `<${tag}${a ? ` style="text-align:${a}"` : ""}>${c}</${tag}>`;
        };
        const head = "<tr>" + b.header.map((c, k) => cell("th", c, k)).join("") + "</tr>";
        const body = b.rows.map((r) => "<tr>" + r.map((c, k) => cell("td", c, k)).join("") + "</tr>").join("");
        h.push(`<table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table>`);
        continue;
      }
      h.push("<p>" + b.lines.join("<br>") + "</p>");
    }
    return h.join("");
  }

  // The block appended to a Chat prompt so pi is told which files the user
  // attached and the exact paths to read them from. Only the PATHS travel — the
  // bytes never enter the prompt — and pi reads each file with its own tools.
  // Empty (so the prompt is unchanged) when nothing is attached.
  function attachmentsBlock(paths) {
    const list = (paths || []).map((p) => String(p == null ? "" : p).trim()).filter(Boolean);
    if (!list.length) return "";
    return "Attached files (read each from its path):\n" + list.map((p) => `- ${p}`).join("\n");
  }

  // The markers of the transcript block the server prepends when a recorded
  // session's own pi session file is gone and its conversation has to be seeded
  // into a fresh one instead (see session-seed.ts — keep these in sync). pi
  // records the WHOLE prompt as the turn's user_message, so a refetched
  // transcript would otherwise show that block as something the user typed.
  const SEED_HEAD = "[Continued session transcript";
  const SEED_TAIL = "[End of continued session transcript]";

  /** The user's own message, with any seeded-transcript block removed. A record
   *  that lost its tail (a truncated snapshot) is left untouched: showing the
   *  block is better than showing nothing. */
  function stripSessionSeed(text) {
    const t = String(text == null ? "" : text);
    const head = t.indexOf(SEED_HEAD);
    if (head < 0) return t;
    const tail = t.indexOf(SEED_TAIL);
    if (tail < 0) return t;
    return t.slice(tail + SEED_TAIL.length).replace(/^\s+/, "");
  }

  // ─── Model selects: type to filter ───────────────────────────────────────
  /**
   * A model <select> opens the browser's own list, which cannot be searched:
   * with a few hundred provider ids the only way to reach one is to scroll.
   * This turns every `select[data-model-select]` into a combobox — clicking (or
   * typing on) the select opens an anchored panel with a search box; the typed
   * words filter the options as substrings, ↑/↓ move, Enter picks, Esc closes.
   *
   * The <select> itself stays in the DOM and keeps its value and its `change`
   * event, so every existing handler, poll and test keeps working: the panel is
   * a view of the select's options, never a replacement for it. One delegated
   * listener covers every such select, including the ones rendered after load
   * (the settings page, the office floor, the workflow canvas).
   *
   * The styles live here rather than in styles.css/mobile.css because this one
   * component is shared by the desktop page, the phone page and two plugin
   * bundles; three copies of the same rules would drift.
   */
  const SEL = { pop: null, input: null, list: null, for: null, active: 0, rows: [], observer: null };

  function selCss() {
    if (document.getElementById("scope-sel-filter-css")) return;
    const style = document.createElement("style");
    style.id = "scope-sel-filter-css";
    style.textContent =
      `.scope-sel-pop{position:fixed;z-index:var(--z-modal,1200);display:flex;flex-direction:column;gap:4px;` +
      `padding:6px;box-sizing:border-box;background:var(--glass-bg-strong,var(--surface,#fff));color:var(--text,#242423);` +
      `border:1px solid var(--border,var(--border-subtle,#e3e3df));border-radius:var(--r-card,6px);` +
      `box-shadow:var(--shadow-panel,0 18px 48px rgba(0,0,0,.2));font-family:var(--font-body,system-ui,sans-serif);` +
      `font-size:13px;line-height:1.4;}` +
      `.scope-sel-pop[hidden]{display:none;}` +
      `.scope-sel-search{width:100%;box-sizing:border-box;margin:0;padding:6px 8px;` +
      `background:var(--field-bg,var(--surface-2,#f5f5f3));color:inherit;` +
      `border:1px solid var(--border,var(--border-subtle,#d3d3cc));border-radius:var(--r-control,4px);` +
      `font-family:var(--mono,monospace);font-size:12.5px;outline:none;}` +
      `.scope-sel-search:focus{border-color:var(--accent,#ffd43b);box-shadow:0 0 0 3px var(--accent-soft,rgba(255,212,59,.28));}` +
      `.scope-sel-list{max-height:290px;overflow-y:auto;padding:2px;border-radius:var(--r-control,4px);` +
      `background:var(--surface,#fbfbfa);}` +
      `.scope-sel-opt{display:flex;align-items:baseline;gap:6px;padding:5px 7px;border-radius:4px;cursor:pointer;` +
      `font-family:var(--mono,monospace);font-size:12.5px;color:var(--text,#242423);white-space:nowrap;overflow:hidden;}` +
      `.scope-sel-opt.scope-sel-sub{padding-left:29px;}` +
      `.scope-sel-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:400;}` +
      `.scope-sel-group{display:flex;align-items:center;gap:6px;padding:8px 7px 4px;` +
      `font-family:var(--mono,monospace);font-size:11.5px;font-weight:700;line-height:1.2;color:var(--text,#242423);}` +
      `.scope-sel-group:not(:first-child){margin-top:3px;border-top:1px solid var(--hairline,var(--border,#e3e3df));}` +
      `.scope-sel-provider-ico{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;` +
      `width:15px;height:15px;border-radius:3px;font-family:var(--mono,monospace);font-size:9px;font-weight:700;line-height:1;` +
      `background:var(--accent-soft,#fff1b6);color:var(--accent-ink,#554400);}` +
      `.scope-sel-provider-ico.t1{background:var(--tint-green,rgba(131,207,156,.14));color:var(--green,#2f7d4a);}` +
      `.scope-sel-provider-ico.t2{background:var(--tint-orange,rgba(227,178,79,.14));color:var(--orange,#9a6b12);}` +
      `.scope-sel-provider-ico.t3{background:var(--tint-purple,rgba(173,140,242,.14));color:var(--purple,#6d4ec4);}` +
      `.scope-sel-provider-ico.t4{background:var(--tint-cyan,rgba(106,162,240,.12));color:var(--cyan,#2e6bb8);}` +
      `.scope-sel-provider-ico.t5{background:var(--tint-red,rgba(255,158,150,.14));color:var(--red,#b7382f);}` +
      `.scope-sel-opt.scope-sel-active{background:var(--accent-soft,#fff1b6);color:var(--accent-ink,#554400);}` +
      `.scope-sel-opt.scope-sel-current{box-shadow:inset 2px 0 0 var(--accent,#ffd43b);}` +
      `.scope-sel-none{padding:9px 8px;color:var(--muted,var(--text-3,#71716c));font-size:12.5px;}`;
    document.head.appendChild(style);
  }

  /** A small provider avatar: its initial on a tinted chip, with the tint fixed
   *  per provider so the same provider reads the same wherever it is listed. */
  function providerIconHtml(provider) {
    const name = String(provider || "").trim();
    const initial = (name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return `<span class="scope-sel-provider-ico t${hash % 6}" aria-hidden="true">${escapeHtml(initial)}</span>`;
  }

  /** The option rows of `select` that match every word in `query`, ordered by
   *  provider then model. A model select may carry its provider as an
   *  <optgroup> (Settings, Chat) or inline in the option text as
   *  "provider/model" (the mobile sheet, Git's plugin setting), so both shapes
   *  are split the same way: the provider becomes a heading and the model name
   *  alone is the selectable label. */
  function selRowsFor(select, query) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [];
    for (const opt of select.options) {
      const group = opt.parentElement && opt.parentElement.tagName === "OPTGROUP" ? opt.parentElement : null;
      if (opt.disabled || (group && group.disabled)) continue;
      const label = String(opt.textContent || "").trim() || opt.value;
      const groupLabel = group ? String(group.label || "") : "";
      const hay = `${opt.value} ${label} ${groupLabel}`.toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      // The first slash is the provider separator; any further slashes belong
      // to the model's own id (e.g. "kilo/inclusionai/ling-3.0"). Only a real
      // id parses: "(agent default — google/gemini-…)" keeps its whole label.
      let provider = groupLabel;
      let name = label;
      if (provider) {
        if (name.startsWith(provider + "/")) name = name.slice(provider.length + 1);
      } else if (opt.value) {
        const cut = name.indexOf("/");
        const head = cut > 0 ? name.slice(0, cut) : "";
        if (cut > 0 && cut < name.length - 1 && /^[A-Za-z0-9._-]+$/.test(head)) {
          provider = head;
          name = name.slice(cut + 1);
        }
      }
      rows.push({ value: opt.value, name, provider, index: rows.length });
    }
    // Empty-value rows ("default", "(none)", "(choose a model)") stay pinned
    // first; everything else is grouped by provider and then by model name.
    // Bare aliases (no provider) keep the order the harness reported, so a CLI
    // whose list is deliberately ordered is not alphabetised behind its back.
    rows.sort((a, b) => {
      if (!a.value || !b.value) {
        if (!a.value && !b.value) return a.index - b.index;
        return a.value ? 1 : -1;
      }
      if (!a.provider && !b.provider) return a.index - b.index;
      if (!a.provider !== !b.provider) return a.provider ? -1 : 1;
      return a.provider.localeCompare(b.provider) ||
        a.name.localeCompare(b.name) ||
        a.value.localeCompare(b.value) ||
        a.index - b.index;
    });
    return rows;
  }

  function selEnsurePop() {
    if (SEL.pop) return;
    selCss();
    const pop = document.createElement("div");
    pop.className = "scope-sel-pop";
    pop.hidden = true;
    pop.innerHTML =
      `<input class="scope-sel-search" type="text" role="combobox" aria-autocomplete="list" ` +
      `aria-controls="scope-sel-listbox" aria-expanded="true" placeholder="Type to filter…" ` +
      `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">` +
      `<div class="scope-sel-list" id="scope-sel-listbox" role="listbox"></div>`;
    document.body.appendChild(pop);
    SEL.pop = pop;
    SEL.input = pop.querySelector(".scope-sel-search");
    SEL.list = pop.querySelector(".scope-sel-list");

    SEL.input.addEventListener("input", () => { SEL.active = 0; selPaint(); selPlace(); });
    SEL.input.addEventListener("keydown", (e) => {
      // The panel is a modal-ish popup: its keystrokes are the search's, never a
      // shortcut of the view behind it (Esc would otherwise close the whole
      // popup this picker was opened from).
      e.stopPropagation();
      const n = SEL.rows.length;
      if (e.key === "ArrowDown") { e.preventDefault(); SEL.active = n ? (SEL.active + 1) % n : 0; selPaint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); SEL.active = n ? (SEL.active - 1 + n) % n : 0; selPaint(); }
      else if (e.key === "Home") { e.preventDefault(); SEL.active = 0; selPaint(); }
      else if (e.key === "End") { e.preventDefault(); SEL.active = Math.max(0, n - 1); selPaint(); }
      else if (e.key === "Enter") { e.preventDefault(); selPick(SEL.active); }
      else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); selClose(true); }
    });
    // The list must not steal focus from the search box, or the next keystroke
    // would land nowhere.
    SEL.list.addEventListener("mousedown", (e) => e.preventDefault());
    SEL.list.addEventListener("click", (e) => {
      const row = e.target && e.target.closest ? e.target.closest("[data-idx]") : null;
      if (row) selPick(Number(row.dataset.idx));
    });
  }

  function selPaint() {
    const select = SEL.for;
    if (!select || !SEL.list) return;
    SEL.rows = selRowsFor(select, SEL.input.value);
    const n = SEL.rows.length;
    if (SEL.active >= n) SEL.active = n ? n - 1 : 0;
    if (!n) {
      SEL.list.innerHTML = `<div class="scope-sel-none">No model matches “${escapeHtml(SEL.input.value.trim())}”.</div>`;
    } else {
      let html = "";
      let lastProvider = null;
      SEL.rows.forEach((row, i) => {
        // One heading per provider, directly above that provider's models. It
        // is not a selectable row, so arrow keys still move model to model.
        if (row.provider && row.provider !== lastProvider) {
          html += `<div class="scope-sel-group" role="presentation">` +
            `${providerIconHtml(row.provider)}<span class="scope-sel-group-name">${escapeHtml(row.provider)}</span></div>`;
        }
        lastProvider = row.provider || null;
        html += `<div class="scope-sel-opt${row.provider ? " scope-sel-sub" : ""}` +
          `${i === SEL.active ? " scope-sel-active" : ""}` +
          `${row.value === select.value ? " scope-sel-current" : ""}" role="option" ` +
          `id="scope-sel-opt-${i}" data-idx="${i}" aria-selected="${i === SEL.active}" ` +
          `title="${escapeHtml(row.value)}">` +
          `<span class="scope-sel-name">${escapeHtml(row.name)}</span></div>`;
      });
      SEL.list.innerHTML = html;
    }
    SEL.input.setAttribute("aria-activedescendant", n ? `scope-sel-opt-${SEL.active}` : "");
    const active = SEL.list.querySelector(".scope-sel-active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  /** Place the panel under the select, or above it when there is more room. */
  function selPlace() {
    const select = SEL.for, pop = SEL.pop;
    if (!select || !pop) return;
    const r = select.getBoundingClientRect();
    const width = Math.min(Math.max(Math.round(r.width), 240), Math.min(420, window.innerWidth - 16));
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(6, Math.min(Math.round(r.left), window.innerWidth - width - 6))}px`;
    const height = Math.min(360, Math.max(150, pop.offsetHeight || 240));
    const below = window.innerHeight - r.bottom - 10;
    pop.style.top = below >= Math.min(height, 200) || below >= r.top - 10
      ? `${Math.round(r.bottom + 4)}px`
      : `${Math.max(6, Math.round(r.top - 4 - height))}px`;
  }

  function selOpen(select, initial) {
    if (!select || select.disabled) return;
    selEnsurePop();
    if (SEL.observer) SEL.observer.disconnect();
    SEL.for = select;
    SEL.input.value = initial ? String(initial) : "";
    SEL.rows = selRowsFor(select, SEL.input.value);
    const at = SEL.rows.findIndex((row) => row.value === select.value);
    SEL.active = at >= 0 ? at : 0;
    SEL.pop.hidden = false;
    select.setAttribute("aria-expanded", "true");
    selPaint();
    selPlace();
    SEL.input.focus({ preventScroll: true });
    SEL.input.setSelectionRange(SEL.input.value.length, SEL.input.value.length);
    // A repaint of the select (a new catalogue, a new roster) is reflected
    // while the panel is open instead of leaving a stale list behind.
    SEL.observer = new MutationObserver(() => { if (SEL.for) { selPaint(); selPlace(); } });
    SEL.observer.observe(select, { childList: true });
  }

  function selClose(refocus) {
    const select = SEL.for;
    if (SEL.observer) { SEL.observer.disconnect(); SEL.observer = null; }
    if (SEL.pop) SEL.pop.hidden = true;
    if (select) select.removeAttribute("aria-expanded");
    SEL.for = null;
    SEL.rows = [];
    if (refocus && select) select.focus({ preventScroll: true });
  }

  function selPick(index) {
    const select = SEL.for;
    const row = SEL.rows[index];
    if (!select || !row) return;
    selClose(false);
    if (select.value !== row.value) {
      select.value = row.value;
      // The select keeps its own `change` contract: the poll handlers, the
      // settings writers and the workflow's Custom… box all listen for it.
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    select.focus({ preventScroll: true });
  }

  /** Delegated open/close: one listener serves selects created at any time. */
  function selInstall() {
    const modelSelectOf = (target) => (target && target.closest ? target.closest("select[data-model-select]") : null);
    document.addEventListener("mousedown", (e) => {
      const select = modelSelectOf(e.target);
      if (select) { e.preventDefault(); selOpen(select, ""); return; }
      if (SEL.for && SEL.pop && !SEL.pop.contains(e.target)) selClose(false);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (SEL.for || e.metaKey || e.ctrlKey || e.altKey) return;
      const select = modelSelectOf(e.target);
      if (!select || select.disabled) return;
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); selOpen(select, ""); return; }
      // Typing on a focused pill starts the search, the way a combobox behaves.
      if (e.key.length === 1) { e.preventDefault(); e.stopPropagation(); selOpen(select, e.key); }
    }, true);
    document.addEventListener("focusin", (e) => {
      if (SEL.for && SEL.pop && !SEL.pop.contains(e.target) && e.target !== SEL.for) selClose(false);
    }, true);
    window.addEventListener("resize", () => { if (SEL.for) selPlace(); });
    // Any scroller other than the panel's own list moves the anchor with it.
    window.addEventListener("scroll", (e) => {
      if (!SEL.for) return;
      if (SEL.pop && SEL.pop.contains(e.target)) return;
      selClose(false);
    }, true);
  }

  const HELPERS = {
    filterableModelSelects: { install: selInstall, open: selOpen, close: selClose },
    fmtTs,
    fmtRel,
    markdownHtml,
    mediaInText,
    mediaKind,
    videoPoster,
    mediaFileName,
    mediaTableHtml,
    hydrateMediaTables,
    resultMediaHtml,
    attachmentsBlock,
    stripSessionSeed,
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
    toast,
  };

  // Expose helpers on window.SCOPE so every view can access them explicitly.
  window.SCOPE = window.SCOPE || {};
  Object.assign(window.SCOPE, HELPERS);
  window.SCOPE.isToolResultError = isToolResultError;

  // Every model picker is searchable from boot. The listeners are delegated, so
  // a picker rebuilt by a poll (the chat composer, the office roster) or
  // rendered later (Settings, the workflow panel) needs no extra wiring.
  selInstall();
})();
