/**
 * Example Pi Scope client plugin.
 *
 * The server serves this file at /plugins/file/<id>/client.js and the plugin
 * host loads it (with the auth token) for every enabled plugin that declares a
 * `client` entry. All it has to do is call `SCOPE.Plugins.register(spec)`.
 *
 * A spec's `view.pane` selector does not have to exist in index.html — the host
 * creates a <section> for it inside <main>, then calls `view.render(pane)` once
 * so the plugin can build its own DOM.
 */
(function () {
  const P = window.SCOPE.Plugins;

  P.register({
    id: "hello-insights",
    name: "Insights",
    description: "Example plugin: counts ingested events by type.",
    source: "user",
    nav: { label: "Insights", order: 75, group: "timeline", title: "Example plugin view" },
    view: {
      pane: "#hello-insights-pane",
      display: "flex",
      session: "none",
      render(pane) {
        pane.innerHTML =
          '<div class="pane-header">' +
          '<span style="font-weight:500">Insights</span>' +
          '<span id="hi-status" style="color:var(--muted);font-size:13.5px"></span>' +
          '<button class="btn-sm" id="hi-refresh" type="button" style="margin-left:auto">↻ refresh</button>' +
          '</div>' +
          '<div id="hi-body" style="padding:14px;overflow:auto"></div>';

        async function refresh() {
          const status = pane.querySelector("#hi-status");
          const body = pane.querySelector("#hi-body");
          if (status) status.textContent = "loading…";
          try {
            const { res, data } = await window.SCOPE.api("/hello-insights/summary");
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            if (status) status.textContent = `${data.total} events ingested`;
            body.innerHTML = data.byType.length
              ? '<table style="border-collapse:collapse;font-size:13px">' +
                data.byType.map((r) =>
                  `<tr><td style="padding:2px 14px 2px 0">${window.SCOPE.escapeHtml(r.type)}</td>` +
                  `<td style="padding:2px 0;color:var(--muted)">${r.count}</td></tr>`).join("") +
                "</table>"
              : '<div style="color:var(--muted)">No events yet — feed the server with POST /events.</div>';
          } catch (err) {
            if (status) status.textContent = "";
            body.innerHTML = `<div style="color:var(--red)">${window.SCOPE.escapeHtml(String(err.message || err))}</div>`;
          }
        }

        pane.querySelector("#hi-refresh").addEventListener("click", refresh);
        pane.__refresh = refresh;
      },
      onShow: () => document.getElementById("hello-insights-pane")?.__refresh?.(),
    },
  });
})();
