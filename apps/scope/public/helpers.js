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
  };

  // Expose helpers on window.SCOPE so every view can access them explicitly.
  window.SCOPE = window.SCOPE || {};
  Object.assign(window.SCOPE, HELPERS);
})();
