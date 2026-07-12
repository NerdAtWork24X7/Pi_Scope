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
      cursorBlink: true, fontSize: 13, fontFamily: "'MesloLGS NFM', monospace",
      rightClickSelectsWord: false,
      theme: { background: "#0d1117", foreground: "#c9d1d9" }, scrollback: 5000,
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    setupContextMenu(container);
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

  // Build a lightweight right-click menu offering Copy / Paste, since xterm
  // does not ship one and the native browser menu can't reach the terminal
  // selection or pipe pasted text into the PTY.
  function setupContextMenu(container) {
    let menu = document.getElementById("term-ctx-menu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "term-ctx-menu";
      menu.className = "term-menu";
      menu.setAttribute("hidden", "");
      menu.innerHTML =
        '<button type="button" data-act="copy">Copy</button>' +
        '<button type="button" data-act="paste">Paste</button>';
      document.body.appendChild(menu);
      document.addEventListener("mousedown", (e) => {
        if (menu && !menu.contains(e.target)) hideMenu();
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });
      window.addEventListener("resize", hideMenu);
      menu.addEventListener("click", (e) => {
        const act = e.target.getAttribute("data-act");
        if (!act) return;
        e.stopPropagation();
        if (act === "copy") doCopy();
        else if (act === "paste") doPaste();
        hideMenu();
      });
    }
    function hideMenu() { menu.setAttribute("hidden", ""); }
    function showMenu(x, y) {
      menu.removeAttribute("hidden");
      // Keep the menu inside the viewport.
      const r = menu.getBoundingClientRect();
      const px = Math.min(x, window.innerWidth - r.width - 4);
      const py = Math.min(y, window.innerHeight - r.height - 4);
      menu.style.left = Math.max(4, px) + "px";
      menu.style.top = Math.max(4, py) + "px";
      const copyBtn = menu.querySelector('[data-act="copy"]');
      if (copyBtn) copyBtn.disabled = !(term && term.getSelection());
    }
    async function doCopy() {
      if (!term) return;
      const text = term.getSelection();
      if (!text) return;
      try { await navigator.clipboard.writeText(text); }
      catch { fallbackCopy(text); }
    }
    async function doPaste() {
      if (!term) return;
      let text = "";
      try { text = await navigator.clipboard.readText(); }
      catch { return; }
      if (text) term.paste(text);
    }
    function fallbackCopy(text) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY);
    });
    // Hide when the terminal scrolls, so the menu doesn't float detached.
    container.addEventListener("scroll", hideMenu, true);
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
