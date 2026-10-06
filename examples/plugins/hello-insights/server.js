/**
 * Example Pi Scope server plugin.
 *
 * `activate(api)` is the only required export. The host calls it once when the
 * plugin is enabled (at boot, or when it is switched on in Settings → Plugins).
 * It gets a tiny API:
 *
 *   api.log(...)                       → namespaced console.log
 *   api.route(method, path, handler)   → register an HTTP route (":name" params)
 *   api.onEvent(handler)               → observe every event POSTed to /events
 *   api.store.get/set/all              → JSON storage, persisted per plugin
 *   api.id / api.dir / api.source      → identity + on-disk location
 *
 * A route handler receives { url, method, params, req, readBody, json, cwd } and
 * may return a value (serialized as JSON) or a Response.
 */
export function activate(api) {
  api.log("activated — counting events");

  api.onEvent((evt) => {
    const counts = api.store.get("eventCounts", {});
    counts[evt.type] = (counts[evt.type] || 0) + 1;
    counts.__total = (counts.__total || 0) + 1;
    api.store.set("eventCounts", counts);
  });

  api.route("GET", "/hello-insights/summary", () => {
    const counts = api.store.get("eventCounts", {});
    const byType = Object.entries(counts)
      .filter(([k]) => k !== "__total")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([type, n]) => ({ type, count: n }));
    return { ok: true, total: counts.__total || 0, byType };
  });
}
