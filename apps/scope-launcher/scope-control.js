// scope-control.js — engine-agnostic control of the Pi Scope server.
// Boots `node apps/scope/server.ts` on demand and waits for /health.
// Safe to reuse an already-running server. Kills only what it spawned.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { app } = require("electron");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SCOPE_DIR = path.join(PROJECT_ROOT, "apps", "scope");
// The server persists its per-run token here (0600) so the launcher UI and the
// pi extension can discover it without a hardcoded constant like "devtoken".
const TOKEN_FILE = path.join(PROJECT_ROOT, "tmp", "scope_token");
function readTokenFile() {
  const tf = process.env.SCOPE_TOKEN_FILE ?? TOKEN_FILE;
  try { return fs.readFileSync(tf, "utf8").trim(); } catch { return null; }
}

function config(overrides = {}) {
  const port = parseInt(overrides.SCOPE_PORT ?? process.env.SCOPE_PORT ?? "43190", 10);
  const host = overrides.SCOPE_HOST ?? process.env.SCOPE_HOST ?? "127.0.0.1";
  const DEFAULT_AUTH_TOKEN = "dev_token";
  const token = overrides.SCOPE_AUTH_TOKEN ?? process.env.SCOPE_AUTH_TOKEN ?? readTokenFile() ?? DEFAULT_AUTH_TOKEN;
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

  // Resolve how to launch the SCOPE server.
  // Dev: `node apps/scope/server.ts`. Packaged: the bundled portable Node runs the
  // compiled server bundle (node-pty/ws resolve from the app's node_modules).
  function serverLaunch() {
    if (app && app.isPackaged) {
      const nodeBin = path.join(process.resourcesPath, "node", "bin", "node");
      const serverPath = path.join(__dirname, "server-bundle", "server.js");
      return { bin: nodeBin, args: [serverPath], cwd: __dirname };
    }
    return { bin: "node", args: ["server.ts"], cwd: SCOPE_DIR };
  }

// Ensure the SCOPE server is up. Reuses an existing one if already listening.
// Returns { proc, spawned, cfg }. proc is null when an existing server was reused.
async function ensureServer({ timeoutMs = 20000 } = {}) {
  // Route DB + token to a writable location when packaged (resources/ is a
  // read-only AppImage/squashfs mount). Must be set on process.env BEFORE config()
  // and readTokenFile() run so the "reuse already-running server" path reads the
  // right token, and the spawned server inherits it via the env snapshot below.
  if (app && app.isPackaged) {
    const dataDir = path.join(os.homedir(), ".local", "share", "pi-scope");
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.SCOPE_DB_PATH = path.join(dataDir, "scope.db");
    process.env.SCOPE_TOKEN_FILE = path.join(dataDir, "scope_token");
    process.env.SCOPE_PACKAGED = "1";
  }
  const cfg = config();
  try {
    await waitForHealth(cfg.healthUrl, { timeoutMs: 3000 }); // already up?
    // Adopt the running server's token (written to the data dir) so the UI
    // auth matches the already-listening instance.
    const runningToken = readTokenFile() ?? cfg.token;
    return { proc: null, spawned: false, cfg: { ...cfg, token: runningToken } };
  } catch {
    const env = {
      ...process.env,
      SCOPE_PORT: String(cfg.port),
      SCOPE_HOST: cfg.host,
      SCOPE_AUTH_TOKEN: cfg.token,
      // Make sure the packaged server sees the user's real environment even when
      // launched from a desktop session that may not inherit shell env vars.
      HOME: process.env.HOME || os.homedir(),
      USER: process.env.USER || (() => { try { return os.userInfo().username; } catch { return ""; } })(),
      SHELL: process.env.SHELL || "/bin/bash",
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    };
    const launch = serverLaunch();
    const proc = spawn(launch.bin, launch.args, { cwd: launch.cwd, env, detached: true, stdio: "inherit" });
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
