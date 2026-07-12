(function () {
  const TERMINAL_PATH = "/terminal";
  let term = null, fit = null, ws = null, container = null;

  function token() { return new URLSearchParams(location.search).get("token") || ""; }
  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + TERMINAL_PATH + "?token=" + encodeURIComponent(token());
  }
  function setStatus(text, live) {
    const el = document.getElementById("terminal-status");
    if (el) el.textContent = text;
    const d = document.getElementById("terminal-dot");
    if (d) d.className = "live-dot " + (live ? "green" : "red");
  }

  function ensureTerm() {
    if (term) return;
    term = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: "monospace",
      theme: { background: "#0d1117", foreground: "#c9d1d9" }, scrollback: 5000,
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    term.onData((data) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    window.addEventListener("resize", () => { requestAnimationFrame(() => { try { fit.fit(); } catch {} }); });
  }

  function connect() {
    ensureTerm();
    // Reuse the existing socket if it's still live — switching away from and
    // back to the Terminal view must NOT reset the session.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      setStatus("connected", true);
    };
    ws.onmessage = (ev) => {
      const data = ev.data;
      // Server control frames are JSON starting with '{'; never render them.
      if (typeof data === "string" && data.charCodeAt(0) === 0x7b /* '{' */) {
        try {
          const m = JSON.parse(data);
          if (m && m.type === "cwd" && typeof m.cwd === "string") {
            if (window.__setCwd) window.__setCwd(m.cwd);
            return;
          }
        } catch {}
      }
      if (term) term.write(data);
    };
    ws.onclose = () => { setStatus("disconnected", false); ws = null; };
    ws.onerror = () => { setStatus("error", false); };
  }

  function disconnect() {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (term) { try { term.dispose(); } catch {} term = null; fit = null; }
  }

  window.__terminalClear = function () { if (term) term.reset(); };
  window.__terminalOnShow = function () {
    if (!container) container = document.getElementById("terminal-mount");
    connect();
    // Pane just became visible (was display:none) — recompute size before fit.
    requestAnimationFrame(() => { try { if (fit) fit.fit(); } catch {} });
  };
  window.__terminalOnHide = function () {
    // Keep the PTY + socket alive so the session survives view switches.
    // Only tear down fully on unload.
  };
  window.addEventListener("beforeunload", disconnect);
})();
