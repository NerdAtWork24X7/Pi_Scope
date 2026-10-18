// scope-control.js — engine-agnostic control of the Pi Scope server.
// Boots `node apps/scope-server/server.ts` on demand and waits for /health.
// Safe to reuse an already-running server. Kills only what it spawned.
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
// Only used to tell a packaged app from a checkout. Guarded because this module
// is also imported by the test suite under plain Node, where `require("electron")`
// resolves to a binary path (or nothing) and `app` is simply absent.
let app = null;
try { ({ app } = require("electron")); } catch { /* plain Node (tests) */ }

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SCOPE_DIR = path.join(PROJECT_ROOT, "apps", "scope-server");
// The server persists its per-run token here (0600) so the launcher UI and the
// pi extension can discover it without a hardcoded constant like "devtoken".
const TOKEN_FILE = path.join(PROJECT_ROOT, "tmp", "scope_token");
function readTokenFile() {
  const tf = process.env.SCOPE_TOKEN_FILE ?? TOKEN_FILE;
  try { return fs.readFileSync(tf, "utf8").trim(); } catch { return null; }
}

// Optional `apps/scope-desktop/scope.env` for settings that must survive a
// desktop-icon launch (which inherits no shell env). Plain KEY=VALUE lines;
// `#` comments and blank lines ignored. This is how the server is pinned to
// 0.0.0.0 so a phone on the same Wi-Fi can reach it — see README. Real
// environment variables always win, so this never overrides an explicit
// `SCOPE_HOST=... ./run.sh`.
function readEnvFile() {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(path.join(__dirname, "scope.env"), "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Strip matching surrounding quotes so values may contain spaces.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
const FILE_ENV = readEnvFile();
// Precedence: explicit override > real process env > scope.env file.
const setting = (key, overrides, envVal) => overrides?.[key] ?? envVal ?? FILE_ENV[key];

/** The port to listen on, before any per-instance override. */
function resolvePort(overrides = {}) {
  return parseInt(setting("SCOPE_PORT", overrides, process.env.SCOPE_PORT) ?? "43190", 10);
}

function config(overrides = {}) {
  const port = resolvePort(overrides);
  // Bind every interface by default so the phone button in the header can show a
  // scannable QR without editing scope.env: the QR must point at a LAN-reachable
  // address, which a loopback bind cannot provide. Access stays token-gated. Set
  // SCOPE_HOST=127.0.0.1 to keep this machine the only one that can connect.
  const host = setting("SCOPE_HOST", overrides, process.env.SCOPE_HOST) ?? "0.0.0.0";
  // Never fall back to a hardcoded token: it gates the /terminal WebSocket,
  // i.e. a full shell on this machine. When the server is LAN-bound that is
  // reachable by anything on the Wi-Fi, so mint a random one per run instead.
  // readTokenFile() still wins so a re-launched app adopts the already-running
  // server's token; server.ts persists whatever we hand it to 0600.
  const token =
    setting("SCOPE_AUTH_TOKEN", overrides, process.env.SCOPE_AUTH_TOKEN) ??
    readTokenFile() ??
    crypto.randomUUID();
  // A wildcard bind is not a usable browser target — point the in-app window at
  // loopback. The LAN URL is printed by the server's own boot banner.
  const displayHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  return { port, host, displayHost, token, healthUrl: `http://${displayHost}:${port}/health` };
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

// ── Port probing, conflict resolution, and per-instance files ──────────────
//
// The desktop launcher checks its port before booting a server. A port can be
// held by another Pi Scope server (its /health answers with our JSON) or by
// anything else. probePort() tells the two apart so the launcher can offer
// "open the running instance", "kill it and take the port", or "use a different
// port" — the last is how a second, independent app instance runs.

/** One GET /health. Resolves with { status, body } (status 0 on a network error). */
function httpGetHealth(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health", timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 64_000) { req.destroy(); resolve({ status: res.statusCode, body: null }); }
      });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(data); } catch { /* not ours */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null, reason: "no response" }); });
    req.on("error", (err) => resolve({ status: 0, body: null, code: err && err.code }));
  });
}

/**
 * What is on `host:port`?
 *   { state: "free" }                                nothing is listening
 *   { state: "scope", version, platform }            a Pi Scope server
 *   { state: "other", reason }                       something else holds it
 */
async function probePort(host, port, { timeoutMs = 1000 } = {}) {
  const res = await httpGetHealth(host, port, timeoutMs);
  if (res.code === "ECONNREFUSED") return { state: "free" };
  if (res.body && res.body.ok === true && typeof res.body.version === "string") {
    return { state: "scope", version: res.body.version, platform: res.body.platform, status: res.status };
  }
  if (res.status) return { state: "other", reason: `HTTP ${res.status}`, status: res.status };
  return { state: "other", reason: res.code || res.reason || "no response" };
}

/** Run a helper command, returning stdout ("" when it is missing or fails). */
function runCapture(cmd, args, timeoutMs = 4000) {
  try {
    const res = require("node:child_process").spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
    return res.error || res.status !== 0 ? "" : (res.stdout || "");
  } catch { return ""; }
}

/** The name behind a pid, best effort ("" when it cannot be resolved). */
function holderName(pid) {
  try {
    if (process.platform === "win32") {
      const csv = runCapture("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      const first = (csv.split(/\r?\n/)[0] || "").match(/"([^"]+)"/);
      return first ? first[1] : "";
    }
    // Node renames its main thread, so `ps -o comm=` can read "MainThread";
    // /proc/<pid>/cmdline carries the real argv[0] on Linux.
    try {
      const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
      if (argv0) return path.basename(argv0);
    } catch { /* not Linux */ }
    return runCapture("ps", ["-o", "comm=", "-p", String(pid)]).trim().split(/\r?\n/)[0] || "";
  } catch { return ""; }
}

/** PIDs listening on `port` (best effort), each as { pid, name }. */
function listPortHolders(port) {
  const pids = new Set();
  if (process.platform === "win32") {
    for (const line of runCapture("netstat", ["-ano", "-p", "tcp"]).split(/\r?\n/)) {
      if (!/\bLISTENING\b/.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const pid = cols[4] || "";
      const match = (cols[1] || "").match(/:(\d+)$/);
      if (match && Number(match[1]) === Number(port) && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
  } else {
    const lsof = runCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    for (const token of lsof.split(/\s+/)) if (/^\d+$/.test(token)) pids.add(token);
    if (!pids.size) {
      // lsof is often absent (minimal containers); `ss -p` still prints the pid.
      const ss = runCapture("ss", ["-ltnpH", `sport = :${port}`]);
      for (const match of ss.matchAll(/pid=(\d+)/g)) pids.add(match[1]);
    }
  }
  return [...pids].map((pid) => ({ pid: Number(pid), name: holderName(pid) }));
}

/** POST /shutdown — the graceful stop a Pi Scope server performs on itself. */
function requestShutdown(host, port, token) {
  return new Promise((resolve) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = http.request({ host, port, path: "/shutdown", method: "POST", headers, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Poll until nothing is listening on `host:port`. */
async function waitPortFree(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await probePort(host, port, { timeoutMs: 500 })).state === "free") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Free `host:port` so this launcher can take it. A Pi Scope server is asked to
 * shut down first (it tears its own agents/terminals down); anything else is
 * signalled, escalating SIGTERM → SIGKILL (taskkill /T /F on Windows).
 *
 * Returns { ok, method, holders }. `ok:false` means the port is still busy.
 */
async function stopPort(port, { host = "127.0.0.1", token = "" } = {}) {
  const initial = await probePort(host, port);
  if (initial.state === "free") return { ok: true, method: "free", holders: [] };
  const holders = listPortHolders(port);
  if (initial.state === "scope" && await requestShutdown(host, port, token)) {
    if (await waitPortFree(host, port, 5000)) return { ok: true, method: "shutdown", holders };
  }
  for (const { pid } of holders) {
    if (process.platform === "win32") {
      require("node:child_process").spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }
  if (await waitPortFree(host, port, 3000)) return { ok: true, method: "terminate", holders };
  for (const { pid } of holders) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  if (await waitPortFree(host, port, 2000)) return { ok: true, method: "kill", holders };
  return { ok: false, method: "failed", holders };
}

/** The first free port at or after `from` (null when none in range). */
async function findFreePort(host, from, count = 20) {
  for (let port = from; port < from + count && port <= 65535; port++) {
    if ((await probePort(host, port, { timeoutMs: 400 })).state === "free") return port;
  }
  return null;
}

/** The directory instance token files live in (`scope_token`, `scope_token.<port>`). */
function tokenDir() {
  return path.dirname(process.env.SCOPE_TOKEN_FILE || TOKEN_FILE);
}

/** Ports named by `scope_token.<port>` files left behind by isolated instances. */
function portsFromTokenFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .map((name) => /^scope_token\.(\d+)$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
  } catch { return []; }
}

/**
 * The token an isolated instance on `port` wrote beside its DB
 * (`scope_token.<port>`), or "" when there is none. Letting the launcher read it
 * means every instance we list can be shut down through `/shutdown` instead of a
 * signal — only a LAN-bound server ever demands one.
 */
function tokenForPort(port, dir = tokenDir()) {
  try { return fs.readFileSync(path.join(dir, `scope_token.${port}`), "utf8").trim(); }
  catch { return ""; }
}

/**
 * Every Pi Scope server currently listening on `host`, as
 * [{ port, host, version, platform, holders }], sorted by port.
 *
 * Candidates are the configured port and the next `span` ports above it (where a
 * second instance usually lands, and where `findFreePort` looks), plus every port
 * named by a `scope_token.<port>` file — so an instance started well away from
 * the default is still found. A closed port refuses instantly, so the scan is
 * cheap even across a couple of dozen ports.
 */
async function discoverScopePorts(host, { port, span = 12, tokenDir: dir = tokenDir() } = {}) {
  const candidates = new Set(portsFromTokenFiles(dir));
  if (Number.isInteger(port)) for (let p = port; p <= port + span && p <= 65535; p++) candidates.add(p);
  const found = [];
  await Promise.all([...candidates].map(async (p) => {
    const probe = await probePort(host, p, { timeoutMs: 600 });
    if (probe.state === "scope") {
      found.push({ port: p, host, version: probe.version, platform: probe.platform, holders: listPortHolders(p) });
    }
  }));
  return found.sort((a, b) => a.port - b.port);
}

/**
 * Where this instance keeps its token and database.
 *
 * The configured (base) port keeps the historic paths, so existing installs and
 * tooling (tmp/scope_token, db/scope.db; ~/.pi-scope/* when packaged) are
 * untouched. Any *other* port gets `.<port>`-suffixed files, so a second app
 * instance never clobbers the first one's token or contends for its SQLite file.
 *
 * Returns null for the dev default (the server's own defaults already match).
 */
function instancePaths(port, { basePort, packaged, dataDir } = {}) {
  const isolated = Number.isInteger(basePort) && Number(port) !== Number(basePort);
  if (packaged) {
    const dir = dataDir || path.join(os.homedir(), ".pi-scope");
    return {
      tokenFile: path.join(dir, `scope_token${isolated ? `.${port}` : ""}`),
      dbPath: path.join(dir, `scope${isolated ? `-${port}` : ""}.db`),
      isolated,
    };
  }
  if (!isolated) return null;
  return {
    tokenFile: path.join(PROJECT_ROOT, "tmp", `scope_token.${port}`),
    dbPath: path.join(PROJECT_ROOT, "db", `scope-${port}.db`),
    isolated,
  };
}

  // Resolve how to launch the SCOPE server.
  // Dev: `node apps/scope-server/server.ts`. Packaged: the bundled portable Node runs the
  // compiled server bundle (its node-pty/ws resolve from the seeded
  // ~/.pi-scope/pi bundle — see apps/scope-server/pi-deps.ts).
  // The portable Node that ships inside the package: `bin/node` on Linux/macOS,
  // a bare `node.exe` at the root on Windows.
  function portableNodeBin() {
    return process.platform === "win32"
      ? path.join(process.resourcesPath, "node", "node.exe")
      : path.join(process.resourcesPath, "node", "bin", "node");
  }

  function serverLaunch() {
    if (app && app.isPackaged) {
      const serverPath = path.join(__dirname, "server-bundle", "server.js");
      return { bin: portableNodeBin(), args: [serverPath], cwd: __dirname };
    }
    return { bin: "node", args: ["server.ts"], cwd: SCOPE_DIR };
  }

/**
 * Install the npm dependencies of the extensions pi has available (see
 * apps/scope-desktop/pi-extensions-install.mjs), detached so the window opens
 * immediately.
 *
 * Detached on purpose: on a first run this can be a real download — the
 * `browser` extension's playwright — and nobody waits on it. An extension whose
 * packages are still missing reports exactly that when it runs, and the next
 * launch finds them installed. Output lands in ~/.pi-scope/pi-extensions-install.log.
 */
function installExtensionDeps() {
  const installer = path.join(__dirname, "pi-extensions-install.mjs");
  if (!fs.existsSync(installer)) return;
  // The shipped extensions manifest is the declaration for an agent dir that
  // predates it: those dirs are seeded once and never re-seeded, so their
  // extensions would otherwise declare nothing. A package has the copy
  // build-release.sh placed beside the app; a checkout has the source (the same
  // dev fallback main.js uses for its icon).
  const seedManifest = [
    path.join(__dirname, "agent-extensions.json"),
    path.join(PROJECT_ROOT, "examples", "pi_local", "agent", "extensions", "package.json"),
  ].find((file) => fs.existsSync(file));
  const args = [installer, ...(seedManifest ? ["--seed-manifest", seedManifest] : [])];
  const bin = app && app.isPackaged ? portableNodeBin() : process.execPath;
  const dataDir = path.join(os.homedir(), ".pi-scope");
  let out = "ignore";
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    out = fs.openSync(path.join(dataDir, "pi-extensions-install.log"), "a");
  } catch { /* read-only home: the install still runs, just unlogged */ }
  try {
    const child = require("node:child_process").spawn(bin, args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, HOME: process.env.HOME || os.homedir() },
    });
    child.unref();
  } catch (err) {
    console.error("[scope-control] could not start the extension dependency install:", err.message);
  }
}

/**
 * Create or refresh the shared Python venv (~/.pi-scope/.venv) detached (see
 * apps/scope-desktop/pi-python-install.mjs), for the same reason as
 * installExtensionDeps: the first build is a real download and nothing waits
 * on it. Once satisfied it is a filesystem-only no-op. Output lands in
 * ~/.pi-scope/pi-python-install.log.
 */
function installPythonDeps() {
  const installer = path.join(__dirname, "pi-python-install.mjs");
  if (!fs.existsSync(installer)) return;
  const bin = app && app.isPackaged ? portableNodeBin() : process.execPath;
  const dataDir = path.join(os.homedir(), ".pi-scope");
  let out = "ignore";
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    out = fs.openSync(path.join(dataDir, "pi-python-install.log"), "a");
  } catch { /* read-only home: the install still runs, just unlogged */ }
  try {
    const child = require("node:child_process").spawn(bin, [installer], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, HOME: process.env.HOME || os.homedir() },
    });
    child.unref();
  } catch (err) {
    console.error("[scope-control] could not start the Python environment install:", err.message);
  }
}

/**
 * Seed the user's own copy of the bundled Pi coding agent (~/.pi-scope/pi) from
 * the read-only `resources/pi` this package ships.
   *
   * Pi Scope runs `pi` from the user's data dir rather than from the package, so
   * Settings → Update can install a newer agent (a file inside an AppImage/NSIS
   * install is read-only) and the agent survives an app update. The seed is a
   * one-time copy done by the same installer the dev launcher uses; it needs no
   * network and no system npm.
   *
   * Returns true when a usable install is in place. On failure the caller points
   * SCOPE_PI_BUNDLE_DIR at `resources/pi` so the app still works, read-only.
   */
  function seedPiBundle() {
    const bundled = path.join(process.resourcesPath, "pi");
    const installer = path.join(__dirname, "pi-bundle-install.mjs");
    if (!fs.existsSync(installer) || !fs.existsSync(bundled)) return false;
    try {
      const res = require("node:child_process").spawnSync(
        portableNodeBin(), [installer, "--from", bundled],
        // stdout is the installer's status chatter ("already installed");
        // stderr keeps a failure reason visible in the launcher.
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      return res.status === 0;
    } catch (err) {
      console.error("[scope-control] could not install the bundled pi agent:", err.message);
      return false;
    }
  }

/**
 * Point process.env at this instance's DB + token files (creating the DB dir).
 * Call before config()/readTokenFile() so the "already running" token read is
 * the right one and the spawned server inherits the same paths.
 *
 * Returns the paths, or null for the dev default (the server's own defaults
 * already point at tmp/scope_token and db/scope.db). Calling it again steps back
 * out of whatever it set last, so a base-port run after an isolated one is not
 * left pointing at the other instance's files.
 */
let preparedKeys = null; // the env vars this call last set, so it can undo them
function prepareInstance({ port, basePort = resolvePort(), packaged = !!(app && app.isPackaged), dataDir } = {}) {
  if (preparedKeys) for (const key of preparedKeys) delete process.env[key];
  preparedKeys = null;
  const paths = instancePaths(port ?? basePort, { basePort, packaged, dataDir });
  if (!paths) return null;
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
  process.env.SCOPE_DB_PATH = paths.dbPath;
  process.env.SCOPE_TOKEN_FILE = paths.tokenFile;
  preparedKeys = ["SCOPE_DB_PATH", "SCOPE_TOKEN_FILE"];
  return paths;
}

// Ensure the SCOPE server is up. Reuses an existing one if already listening,
// unless `reuse:false` was asked for (the caller just freed the port). `port`
// overrides SCOPE_PORT for a second, independent instance.
// Returns { proc, spawned, cfg }. proc is null when an existing server was reused.
async function ensureServer({ timeoutMs = 20000, port, reuse = true } = {}) {
  const overrides = port ? { SCOPE_PORT: String(port) } : {};
  // Route DB + token to this instance's files before config() reads them: a
  // non-base port gets its own copy so two instances never share a token or
  // contend for one SQLite file (see instancePaths).
  prepareInstance({ port });
  if (app && app.isPackaged) {
    process.env.SCOPE_PACKAGED = "1";
    // The Pi coding agent bundled with the app travels as read-only
    // `resources/pi`; the server runs it from the user's own `~/.pi-scope/pi`
    // so Settings → Update can replace it. Seed it once, then fall back to the
    // shipped copy when that is impossible (a full disk, a read-only home).
    // An explicitly configured SCOPE_PI_BUNDLE_DIR always wins.
    const configured = process.env.SCOPE_PI_BUNDLE_DIR || FILE_ENV.SCOPE_PI_BUNDLE_DIR;
    if (!configured && !seedPiBundle()) {
      console.error("[scope-control] running the bundled pi agent read-only from resources/pi");
      process.env.SCOPE_PI_BUNDLE_DIR = path.join(process.resourcesPath, "pi");
    }
  }
  installExtensionDeps();
  installPythonDeps();
  const cfg = config(overrides);
  if (reuse) {
    try {
      await waitForHealth(cfg.healthUrl, { timeoutMs: 3000 }); // already up?
      // Adopt the running server's token (written to the data dir) so the UI
      // auth matches the already-listening instance.
      const runningToken = readTokenFile() ?? cfg.token;
      return { proc: null, spawned: false, cfg: { ...cfg, token: runningToken } };
    } catch { /* nothing there — start one */ }
  }
  return spawnServer(cfg, timeoutMs);
}

/** Launch the SCOPE server and wait for /health. Returns { proc, spawned:true, cfg }. */
async function spawnServer(cfg, timeoutMs) {
  const env = {
    ...process.env,
    SCOPE_PORT: String(cfg.port),
    SCOPE_HOST: cfg.host,
    SCOPE_AUTH_TOKEN: cfg.token,
    // Make sure the packaged server sees the user's real environment even when
    // launched from a desktop session that may not inherit shell env vars.
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || (() => { try { return os.userInfo().username; } catch { return ""; } })(),
    // Prefer the user's real login shell; never hardcode /bin/bash (absent on
    // some systems). The server itself falls back to bash/zsh when SHELL is
    // empty, so an unresolved shell is safe to pass through as "".
    SHELL: process.env.SHELL || (() => { try { return os.userInfo().shell || ""; } catch { return ""; } })(),
    // Only synthesise a PATH when the launcher truly has none (Windows resolves
    // against its own PATH variable, so the POSIX defaults don't apply there).
    PATH: process.env.PATH || (process.platform === "win32"
      ? String(process.env.Path || "")
      : "/usr/local/bin:/usr/bin:/bin"),
  };
  const launch = serverLaunch();
  // Detach only on POSIX: that gives the server its own process group so
  // stopServer can SIGTERM the whole tree. On Windows a detached child runs in
  // its own console while `stdio: "inherit"` still hands it the parent's
  // console handles — Node then dies on its first write (server.ts logs during
  // import), so the server never reaches listen() and /health never answers.
  // Windows teardown uses taskkill /T instead, which needs no detachment.
  const proc = spawn(launch.bin, launch.args, {
    cwd: launch.cwd,
    env,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  proc.on("error", (err) => console.error("[scope-control] failed to spawn server:", err.message));
  await waitForHealth(cfg.healthUrl, { timeoutMs });
  return { proc, spawned: true, cfg };
}

function stopServer(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === "win32") {
    // Windows has no process-group signals: take the tree down with taskkill
    // (the server's spawned agents/terminals are children of it).
    try {
      require("node:child_process").spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch (_) { /* already gone */ }
    return;
  }
  try { process.kill(-proc.pid, "SIGTERM"); } catch (_) { /* already gone */ }
}

module.exports = {
  config, resolvePort, waitForHealth, ensureServer, stopServer,
  probePort, listPortHolders, stopPort, findFreePort, instancePaths, prepareInstance,
  tokenDir, portsFromTokenFiles, tokenForPort, discoverScopePorts,
  SCOPE_DIR, PROJECT_ROOT,
};
