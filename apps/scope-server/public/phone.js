// phone.js — "open Pi Scope on your phone" pairing panel.
//
// The server can be LAN-bound (SCOPE_HOST=0.0.0.0); this renders a QR of the
// phone URL so the desktop screen can be scanned instead of hand-typing a
// URL that carries a UUID auth token.
//
// Data comes from GET /lan (token-gated — the response embeds the token).
(function () {
  const LAN_STATE = { urls: [], ips: [], port: 0, lanExposed: false, selected: 0 };

  const $ = (s) => document.querySelector(s);

  /** Render a QR code as inline SVG. Vector output stays crisp on the desktop
   *  and in a screenshot a phone camera can focus on; a canvas would blur when
   *  scaled. Returns "" when the vendored generator failed to load so the
   *  caller can fall back to a copyable URL instead of rendering nothing. */
  function qrSvg(text, targetPx) {
    if (typeof window.qrcode !== "function") return "";
    try {
      // typeNumber 0 = auto-pick the smallest version that fits.
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      // Quiet zone of 4 modules is the spec minimum; scanners need it to lock on.
      const quiet = 4;
      const total = n + quiet * 2;
      const cell = targetPx / total;
      // Snap each module to a whole device pixel, else the 1-module gaps alias
      // into grey mush at small sizes.
      const step = Math.max(1, Math.floor(cell));
      const dim = step * total;
      let path = "";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) path += `M${(c + quiet) * step} ${(r + quiet) * step}h${step}v${step}h-${step}z`;
        }
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${window.SCOPE.escapeHtml(text)}"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
    } catch (err) {
      console.error("[phone] QR render failed:", err);
      return "";
    }
  }

  function setStatus(msg, isError) {
    const el = $("#phone-status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? "var(--danger, #e5534b)" : "var(--muted)";
  }

  async function copy(text, btn) {
    const label = btn ? btn.textContent : "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; http://<lan-ip> is not one on
      // some browsers, and it is also blocked in non-focused frames. Fall back
      // to the legacy path rather than silently doing nothing.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    if (btn) {
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = label; }, 1200);
    }
  }

  /** Phone URL: the Chat view, since that is what pairing is for. */
  function phoneUrl(i) {
    const base = LAN_STATE.urls[i] || "";
    return base ? base + (base.includes("?") ? "&" : "?") + "view=chat" : "";
  }

  function render() {
    const wrap = $("#phone-body");
    if (!wrap) return;

    if (LAN_STATE.urls.length === 0) {
      // Two distinct dead ends: loopback-bound (fixable) vs LAN-bound but no
      // routable IPv4 (needs a different network). Say which one it is rather
      // than rendering a QR that would scan and open nothing on the phone.
      const loopbackBound = !LAN_STATE.lanExposed;
      const target = LAN_STATE.ips.length
        ? `Once rebound, your phone will use <code>http://${window.SCOPE.escapeHtml(LAN_STATE.ips[0])}:${window.SCOPE.escapeHtml(LAN_STATE.port)}/</code>.`
        : "";
      wrap.innerHTML = `<div class="phone-note">
        <strong>${loopbackBound ? "This server is bound to 127.0.0.1." : "No routable LAN address found."}</strong>
        <p>${loopbackBound
          ? "Only this machine can reach it — a QR would scan on the desktop and then open nothing on the phone. Restart it on the LAN interface:"
          : "The server is LAN-bound, but no external IPv4 address is available to reach it from a phone. Check that this machine is on a network, then reload."}</p>
        ${loopbackBound ? '<pre class="phone-cmd">SCOPE_HOST=0.0.0.0 node apps/scope-server/server.ts</pre>' : ""}
        ${target ? `<p>${target}</p>` : ""}
        <p class="phone-hint">Only rebind on a Wi-Fi you trust: the phone gets the full UI, and the
        Terminal view is a real shell on this host.</p>
      </div>`;
      return;
    }

    const idx = Math.min(LAN_STATE.selected, LAN_STATE.urls.length - 1);
    const url = phoneUrl(idx);
    const svg = qrSvg(url, 248);

    // Multiple NICs (wifi + ethernet + docker) → let the user pick which one the
    // phone should use, since only one of them will actually be routable.
    const picker = LAN_STATE.urls.length > 1
      ? `<div class="phone-picker">${LAN_STATE.urls.map((u, i) => {
          const ip = u.match(/^https?:\/\/([^/:]+)/)?.[1] || u;
          return `<button class="phone-chip${i === idx ? " active" : ""}" data-idx="${i}" type="button">${window.SCOPE.escapeHtml(ip)}</button>`;
        }).join("")}</div>`
      : "";

    wrap.innerHTML = `
      <div class="phone-qr-wrap">${svg || `<div class="phone-qr-fallback">QR unavailable</div>`}</div>
      <div class="phone-url-row">
        <code id="phone-url" class="phone-url">${window.SCOPE.escapeHtml(url)}</code>
        <button id="phone-copy" class="btn-sm" type="button">Copy</button>
      </div>
      ${picker}
      <div class="phone-hint">
        Point your phone's camera at the code (or open the URL). The phone must be on the
        <strong>same Wi-Fi</strong>. The URL already carries this session's auth token —
        treat it like a password, and bookmark it rather than sharing it.
      </div>`;

    const copyBtn = $("#phone-copy");
    if (copyBtn) copyBtn.onclick = () => copy(url, copyBtn);
    wrap.querySelectorAll(".phone-chip").forEach((chip) => {
      chip.onclick = () => { LAN_STATE.selected = parseInt(chip.dataset.idx, 10) || 0; render(); };
    });
  }

  window.openPhonePanel = async function () {
    const modal = $("#phone-modal");
    if (!modal) return;
    modal.style.display = "flex";
    setStatus("Finding your LAN address…", false);
    const { res, data } = await window.SCOPE.api("/lan");
    if (!res.ok || !data || !Array.isArray(data.urls)) {
      setStatus(data?.error === "unauthorized" ? "Session expired — reload the page." : "Could not reach the server.", true);
      LAN_STATE.urls = [];
    } else {
      LAN_STATE.lanExposed = !!data.lan_exposed;
      LAN_STATE.urls = Array.isArray(data.urls) ? data.urls : [];
      LAN_STATE.ips = Array.isArray(data.ips) ? data.ips : [];
      LAN_STATE.port = data.port || location.port || "43190";
      LAN_STATE.selected = 0;
      setStatus(LAN_STATE.urls.length === 0
        ? (data.lan_exposed ? "LAN-bound, but no routable address." : "Loopback-only bind.")
        : "", false);
    }
    render();
  };

  window.closePhonePanel = function () {
    const modal = $("#phone-modal");
    if (modal) modal.style.display = "none";
  };

  document.addEventListener("DOMContentLoaded", () => {
    const openBtn = $("#btn-phone");
    if (openBtn) openBtn.onclick = window.openPhonePanel;
    const closeBtn = $("#phone-close");
    if (closeBtn) closeBtn.onclick = window.closePhonePanel;
    const modal = $("#phone-modal");
    if (modal) {
      // Click-outside-to-close, matching the checkpoint merge modal.
      modal.onclick = (e) => { if (e.target === modal) window.closePhonePanel(); };
    }
    // Escape closes it, so it behaves like the other overlays.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && modal.style.display !== "none") window.closePhonePanel();
    });
  });
})();
