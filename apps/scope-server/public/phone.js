// phone.js — "open Pi Scope on your phone" pairing panel.
//
// The server can be LAN-bound (SCOPE_HOST=0.0.0.0); this renders a QR of the
// phone URL so the desktop screen can be scanned instead of hand-typing a
// URL that carries a UUID auth token.
//
// Data comes from GET /lan (token-gated — the response carries the short-lived
// pairing code, the https:// URL, and why HTTPS is off when it could not start).
(function () {
  const LAN_STATE = { urls: [], ips: [], addresses: [], port: 0, platform: "", lanExposed: false, selected: 0, pairCode: "", pairExpiresAt: 0, pairTimer: 0, pairPoll: 0, tls: false, tlsPort: 0, tlsError: "" };

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
      // Clipboard API needs a secure context and a focused document. The phone's
      // page now qualifies (it is served over HTTPS) but this panel is also
      // rendered in a desktop frame, where the API can still refuse. Fall back
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

  /**
   * The mobile entry URL for a LAN base URL: the mobile layout (`/m`). No
   * credential rides in it — the phone pairs with a code instead.
   *
   * `/m` is the explicit mobile entry, so the phone never has to be detected:
   * the layout is chosen by where the QR points, not by sniffing a User-Agent.
   * `ui=mobile` is belt-and-braces for a hand-edited URL (and for the case where
   * the phone follows a redirect), and the mobile page's own "desktop" button
   * flips back with `ui=desktop`.
   *
   * Pure, and exported on window.SCOPE, so the pairing test can assert the URL
   * the QR actually encodes without scanning it.
   */
  function mobileUrlFor(base) {
    if (!base) return "";
    try {
      const url = new URL(base, location.origin);
      url.pathname = "/m";
      url.searchParams.set("ui", "mobile");
      return url.toString();
    } catch {
      return base + (base.includes("?") ? "&" : "?") + "view=chat";
    }
  }
  window.SCOPE.mobileUrlFor = mobileUrlFor;

  function phoneUrl(i) {
    return mobileUrlFor(LAN_STATE.urls[i] || "");
  }

  /** The /lan metadata for the selected address, when the server sent any. */
  function selectedAddress(i) {
    return Array.isArray(LAN_STATE.addresses) ? LAN_STATE.addresses[i] : undefined;
  }

  /**
   * The code's remaining life, ticking under it. When it runs out the QR would
   * silently stop working, so the panel fetches a fresh one instead — the code
   * is meant to be short-lived, not to leave a dead QR on screen.
   */
  function renderCodeExpiry() {
    const label = $("#phone-code-expiry");
    const modal = $("#phone-modal");
    if (!label || !LAN_STATE.pairExpiresAt) return;
    // The modal's markup survives being hidden; stop ticking once it is closed.
    if (modal && modal.style.display === "none") return;
    const left = LAN_STATE.pairExpiresAt - Date.now();
    if (left <= 0) {
      label.textContent = "expired — refreshing…";
      window.openPhonePanel();
      return;
    }
    const secs = Math.ceil(left / 1000);
    label.textContent = `expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    clearTimeout(LAN_STATE.pairTimer);
    LAN_STATE.pairTimer = setTimeout(renderCodeExpiry, 1000);
  }

  /**
   * The code is single-use, so it is re-read while the panel is open: once a
   * phone spends it the server mints the next one, and this swaps it in with a
   * fresh countdown. Polling cannot invalidate a live code — /lan only mints when
   * there is none — so a code being typed is never pulled out from under the
   * phone.
   */
  function startPairPoll() {
    stopPairPoll();
    LAN_STATE.pairPoll = setInterval(async () => {
      const modal = $("#phone-modal");
      if (!modal || modal.style.display === "none") { stopPairPoll(); return; }
      const { res, data } = await window.SCOPE.api("/lan");
      if (!res.ok || !data || typeof data.pair_code !== "string") return;
      if (data.pair_code === LAN_STATE.pairCode) {
        // Same code: keep the countdown honest against the server's clock.
        LAN_STATE.pairExpiresAt = Number(data.pair_expires_at) || LAN_STATE.pairExpiresAt;
        return;
      }
      LAN_STATE.pairCode = data.pair_code;
      LAN_STATE.pairExpiresAt = Number(data.pair_expires_at) || 0;
      const codeEl = $("#phone-code");
      if (codeEl) codeEl.textContent = data.pair_code;
      renderCodeExpiry();
      setStatus("New code — the previous one was used or expired.", false);
    }, 4000);
  }

  function stopPairPoll() {
    if (LAN_STATE.pairPoll) clearInterval(LAN_STATE.pairPoll);
    LAN_STATE.pairPoll = 0;
  }

  /**
   * The checks that actually fix "the phone says the site is temporarily down".
   * That message is Chrome's page for a refused/timed-out TCP connection: the
   * page never loaded, so nothing in here can be a Pi Scope bug — it is the
   * network path. Name the host's own firewall rather than a generic list, and
   * keep the commands copy-pasteable.
   */
  function troubleshootHtml(selected) {
    // The firewall has to let through the port the QR actually points at, which
    // is the HTTPS one whenever that listener is up.
    const port = window.SCOPE.escapeHtml(String((LAN_STATE.tls && LAN_STATE.tlsPort) || LAN_STATE.port || location.port || "43190"));
    let firewall;
    switch (LAN_STATE.platform) {
      case "win32":
        firewall = `<li><strong>Allow it through Windows Firewall.</strong> Settings → Network &amp;
          Internet → Windows Firewall → Allow an app through firewall → tick <em>Node.js</em> (or
          <em>Pi Scope</em>) for <em>Private</em> networks. In an admin PowerShell the same rule is:
          <pre class="phone-cmd">New-NetFirewallRule -DisplayName "Pi Scope" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow</pre></li>`;
        break;
      case "darwin":
        firewall = `<li><strong>Allow incoming connections.</strong> System Settings → Network →
          Firewall → Options → allow incoming connections for <em>Node</em> or <em>Pi Scope</em>.</li>`;
        break;
      case "linux":
        firewall = `<li><strong>Open the port in the host firewall.</strong> With ufw:
          <pre class="phone-cmd">sudo ufw allow ${port}/tcp</pre>
          with firewalld:
          <pre class="phone-cmd">sudo firewall-cmd --add-port=${port}/tcp</pre></li>`;
        break;
      default:
        firewall = `<li><strong>Allow inbound TCP ${port}</strong> through this machine's firewall
          (private networks).</li>`;
    }
    const vpn = selected && selected.virtual
      ? `<li><strong>This address is a VPN or virtual adapter</strong> (${window.SCOPE.escapeHtml(selected.iface)}).
          A phone cannot reach it — pick the Wi-Fi address above.</li>`
      : `<li><strong>A VPN on this machine or the phone</strong> puts it on another network. Turn it
          off, then reopen this panel.</li>`;
    // The certificate interstitial looks like a dead end but is not: it is the
    // expected first visit to a self-signed HTTPS address, and it is the thing
    // most likely to be mistaken for the connection failure above.
    const certificate = LAN_STATE.tls
      ? `<li><strong>“Your connection is not private” is expected once.</strong> The certificate is
          self-signed — no authority issues one for a LAN address — so Chrome asks before it loads
          the page: tap <strong>Advanced → Proceed</strong> (Safari: <em>Show Details → visit this
          website</em>). Reloading later in the same browser does not ask again.</li>`
      : "";
    return `<details class="phone-trouble"${selected && selected.virtual ? " open" : ""}>
      <summary>Phone can’t reach it, or warns about the certificate?</summary>
      <ul>
        ${certificate}
        <li><strong>Same Wi-Fi.</strong> Mobile data, a guest network, or two different routers all
          put the phone somewhere this address is not reachable.</li>
        ${vpn}
        ${firewall}
        <li><strong>This URL only works while the server runs</strong>, and the credentials it issues
          are signed per run — a bookmarked link asks for a fresh code after a restart unless
          <code>SCOPE_AUTH_TOKEN</code> is pinned.</li>
      </ul>
      <button id="phone-recheck" class="btn-sm" type="button">Check again</button>
    </details>`;
  }

  function render() {
    const wrap = $("#phone-body");
    if (!wrap) return;

    if (LAN_STATE.urls.length === 0) {
      // Two distinct dead ends: loopback-bound (fixable) vs LAN-bound but no
      // routable IPv4 (needs a different network). Say which one it is rather
      // than rendering a QR that would scan and open nothing on the phone.
      const loopbackBound = !LAN_STATE.lanExposed;
      // Once the bind is LAN-facing, the QR is https:// on its own port — but
      // that listener only exists in that mode, so this panel cannot name the
      // exact URL yet. Point at the panel rather than guessing a port.
      const target = LAN_STATE.ips.length
        ? `Once rebound, reopen this panel: it will show an <code>https://</code> link (the plain port plus one) and the pairing code.`
        : "";
      wrap.innerHTML = `<div class="phone-note">
        <strong>${loopbackBound ? "This server is bound to 127.0.0.1." : "No routable LAN address found."}</strong>
        <p>${loopbackBound
          ? "Only this machine can reach it — a QR would scan on the desktop and then open nothing on the phone. Restart it on the LAN interface:"
          : "The server is LAN-bound, but no external IPv4 address is available to reach it from a phone. Check that this machine is on a network, then reload."}</p>
        ${loopbackBound ? '<pre class="phone-cmd">SCOPE_HOST=0.0.0.0 node apps/scope-server/server.ts</pre>' : ""}
        ${target ? `<p>${target}</p>` : ""}
        <p class="phone-hint">Only rebind on a Wi-Fi you trust: the phone gets the mobile layout
        (the Chat view and live activity for this run), which can still run code on this host.</p>
      </div>`;
      return;
    }

    const idx = Math.min(LAN_STATE.selected, LAN_STATE.urls.length - 1);
    const url = phoneUrl(idx);
    const svg = qrSvg(url, 248);
    const selected = selectedAddress(idx);
    const code = LAN_STATE.pairCode;

    // The code is the only credential the panel hands over, and it is typed on
    // the phone rather than encoded in the QR — so it is on screen, large, with
    // a copy button and a countdown.
    const codeRow = code
      ? `<div class="phone-code-row">
          <span class="phone-code-label">Type on phone</span>
          <code id="phone-code" class="phone-code">${window.SCOPE.escapeHtml(code)}</code>
          <button id="phone-code-copy" class="btn-sm" type="button">Copy</button>
          <span id="phone-code-expiry" class="phone-code-expiry"></span>
        </div>`
      : "";

    // Multiple NICs (wifi + ethernet + docker) → let the user pick which one the
    // phone should use, since only one of them will actually be routable. The
    // server ranks the default route first; VPN/bridge addresses stay pickable
    // but are marked, because picking one is exactly how the QR ends up opening
    // nothing on the phone.
    const picker = LAN_STATE.urls.length > 1
      ? `<div class="phone-picker">${LAN_STATE.urls.map((u, i) => {
          const ip = u.match(/^https?:\/\/([^/:]+)/)?.[1] || u;
          const info = selectedAddress(i);
          const label = info && info.virtual ? `${ip} · ${info.iface}` : ip;
          const title = info && info.virtual
            ? `VPN / virtual adapter (${info.iface}) — a phone on the Wi-Fi usually cannot reach this`
            : info ? `Network interface ${info.iface}` : "";
          return `<button class="phone-chip${i === idx ? " active" : ""}${info && info.virtual ? " virtual" : ""}" data-idx="${i}" type="button" title="${window.SCOPE.escapeHtml(title)}">${window.SCOPE.escapeHtml(label)}</button>`;
        }).join("")}</div>`
      : "";

    // HTTPS is the point of the second listener: it is what keeps the code in
    // the code (and the tokens it is traded for) off the Wi-Fi in clear text.
    // When it is not up, say so plainly instead of handing over an http link
    // that looks equally fine.
    const tlsNote = LAN_STATE.tls
      ? `<div class="phone-tls">
          <span class="phone-tls-badge">HTTPS</span>
          <span>Encrypted. The first open shows a certificate warning — this machine signs its own,
          since no authority issues certificates for a LAN address. Tap <strong>Advanced → Proceed</strong>,
          or trust <code>/scope-ca.crt</code> once to drop it — and to allow the app install.</span>
        </div>`
      : `<div class="phone-tls plain">
          <span class="phone-tls-badge">HTTP</span>
          <span>Not encrypted: the pairing code, and the tokens it buys, are readable by anything on
          this network.${LAN_STATE.tlsError
            ? ` HTTPS could not start — ${window.SCOPE.escapeHtml(LAN_STATE.tlsError)}.`
            : ""}</span>
        </div>`;

    wrap.innerHTML = `
      <div class="phone-qr-wrap">${svg || `<div class="phone-qr-fallback">QR unavailable</div>`}</div>
      <div class="phone-url-row">
        <code id="phone-url" class="phone-url">${window.SCOPE.escapeHtml(url)}</code>
        <button id="phone-copy" class="btn-sm" type="button">Copy</button>
      </div>
      ${tlsNote}
      ${codeRow}
      ${picker}
      <div class="phone-hint">
        Point your phone's camera at the QR, then type the code above on the pairing screen it
        opens. The QR is only the address — the code is not in it, so a photo of the QR alone gets
        nobody in. It works like a one-time password: six digits, two minutes, and spent by the
        first phone that uses it (this panel then shows the next one). The phone must be on the
        <strong>same Wi-Fi</strong>. It opens a <strong>mobile layout</strong> — a sessions list,
        the live transcript, a composer, and a new-session sheet (workspace, model, team, mode) —
        not the desktop app; once paired, the phone's 🖥 button opens the full desktop layout. What
        the phone keeps is a short-lived access token, never this server's master token.
      </div>
      ${troubleshootHtml(selected)}`;

    const copyBtn = $("#phone-copy");
    if (copyBtn) copyBtn.onclick = () => copy(url, copyBtn);
    const codeBtn = $("#phone-code-copy");
    // Read the code at click time: the poll above swaps in a new one when the
    // previous is spent, so a captured value would copy a dead code.
    if (codeBtn) codeBtn.onclick = () => copy($("#phone-code")?.textContent || code, codeBtn);
    const recheck = $("#phone-recheck");
    if (recheck) recheck.onclick = () => window.openPhonePanel();
    renderCodeExpiry();
    wrap.querySelectorAll(".phone-chip").forEach((chip) => {
      chip.onclick = () => { LAN_STATE.selected = parseInt(chip.dataset.idx, 10) || 0; render(); };
    });
    startPairPoll();
  }

  window.openPhonePanel = async function () {
    const modal = $("#phone-modal");
    if (!modal) return;
    modal.style.display = "flex";
    clearTimeout(LAN_STATE.pairTimer);
    setStatus("Finding your LAN address…", false);
    const { res, data } = await window.SCOPE.api("/lan");
    if (!res.ok || !data || !Array.isArray(data.urls)) {
      setStatus(data?.error === "unauthorized" ? "Session expired — reload the page." : "Could not reach the server.", true);
      LAN_STATE.urls = [];
    } else {
      LAN_STATE.lanExposed = !!data.lan_exposed;
      LAN_STATE.urls = Array.isArray(data.urls) ? data.urls : [];
      LAN_STATE.ips = Array.isArray(data.ips) ? data.ips : [];
      LAN_STATE.addresses = Array.isArray(data.addresses) ? data.addresses : [];
      LAN_STATE.platform = typeof data.platform === "string" ? data.platform : "";
      LAN_STATE.pairCode = typeof data.pair_code === "string" ? data.pair_code : "";
      LAN_STATE.pairExpiresAt = Number(data.pair_expires_at) || 0;
      LAN_STATE.port = data.port || location.port || "43190";
      LAN_STATE.tls = !!data.tls;
      LAN_STATE.tlsPort = Number(data.tls_port) || 0;
      LAN_STATE.tlsError = typeof data.tls_error === "string" ? data.tls_error : "";
      LAN_STATE.selected = 0;
      setStatus(LAN_STATE.urls.length === 0
        ? (data.lan_exposed ? "LAN-bound, but no routable address." : "Loopback-only bind.")
        : "", false);
    }
    render();
    // Only worth polling when there is a panel with a code on it.
    if (LAN_STATE.urls.length > 0) startPairPoll();
    else stopPairPoll();
  };

  window.closePhonePanel = function () {
    const modal = $("#phone-modal");
    if (modal) modal.style.display = "none";
    clearTimeout(LAN_STATE.pairTimer);
    stopPairPoll();
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
