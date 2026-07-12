// scope-control.js — engine-agnostic control of the Pi Scope server.
// Boots `node apps/scope/server.ts` on demand and waits for /health.
// Safe to reuse an already-running server. Kills only what it spawned.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SCOPE_DIR = path.join(PROJECT_ROOT, "apps", "scope");

function config(overrides = {}) {
  const port = parseInt(overrides.SCOPE_PORT ?? process.env.SCOPE_PORT ?? "43190", 10);
  const host = overrides.SCOPE_HOST ?? process.env.SCOPE_HOST ?? "127.0.0.1";
  const token = overrides.SCOPE_AUTH_TOKEN ?? process.env.SCOPE_AUTH_TOKEN ?? "devtoken";
  return { port, host, token, healthUrl: `http://${host}:${port}/health` };
}

function waitForHealth(healthUrl, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(healthUrl, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.setTimeout(intervalMs + 200, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start >= timeoutMs) return reject(new Error(`timed out waiting for ${healthUrl}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Ensure the SCOPE server is up. Reuses an existing one if already listening.
// Returns { proc, spawned, cfg }. proc is null when an existing server was reused.
async function ensureServer({ timeoutMs = 20000 } = {}) {
  const cfg = config();
  try {
    await waitForHealth(cfg.healthUrl, { timeoutMs: 3000 }); // already up?
    return { proc: null, spawned: false, cfg };
  } catch {
    const env = {
      ...process.env,
      SCOPE_PORT: String(cfg.port),
      SCOPE_HOST: cfg.host,
      SCOPE_AUTH_TOKEN: cfg.token,
    };
    const proc = spawn("node", ["server.ts"], { cwd: SCOPE_DIR, env, detached: true, stdio: "inherit" });
    proc.on("error", (err) => console.error("[scope-control] failed to spawn server:", err.message));
    await waitForHealth(cfg.healthUrl, { timeoutMs });
    return { proc, spawned: true, cfg };
  }
}

function stopServer(proc) {
  if (proc && !proc.killed) {
    try { process.kill(-proc.pid, "SIGTERM"); } catch (_) { /* already gone */ }
  }
}

module.exports = { config, waitForHealth, ensureServer, stopServer, SCOPE_DIR, PROJECT_ROOT };
