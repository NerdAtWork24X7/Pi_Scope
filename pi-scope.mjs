#!/usr/bin/env node
/**
 * pi-scope.mjs — start the Pi Scope app on Linux, macOS and Windows.
 *
 * This is the cross-platform launcher behind the `pi-scope` command. The tiny
 * platform wrappers only locate Node and hand off here — `pi-scope` (POSIX sh)
 * on Linux/macOS and `pi-scope.cmd` on Windows — so all the start-up logic
 * lives in one place instead of three scripts that drift apart.
 *
 *   pi-scope              desktop app (Electron window, default)
 *   pi-scope --web        headless server + open the WebUI in your browser
 *   pi-scope --server     headless server only, stays in the foreground
 *
 * Extra flags: --dev (adds --watch to a server; pair with --server/--web),
 * --keep-server, --no-install,
 * --port/--host/--db/--token. Node 24+ is required — the server runs its .ts
 * sources directly.
 *
 * The desktop path is just "launch Electron": the app's own main.js boots (or
 * reuses) the server via scope-control.js. The web/server paths spawn
 * `node apps/scope-server/server.ts` here and wait for /health.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Resolve paths from this file's real location, so a symlinked `pi-scope` on
// PATH still finds the project.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const SERVER_DIR = path.join(ROOT, "apps", "scope-server");
const DESKTOP_DIR = path.join(ROOT, "apps", "scope-desktop");
const RUN_DIR = path.join(ROOT, "tmp");                 // git-ignored: pid/log/token
const PID_FILE = path.join(RUN_DIR, "pi-scope.pid");
const ENV_FILE = path.join(DESKTOP_DIR, "scope.env");   // optional per-machine settings
const LOG_FILE = path.join(RUN_DIR, "pi-scope-server.log");
const ERR_FILE = path.join(RUN_DIR, "pi-scope-server.err.log");

const isWin = process.platform === "win32";
const die = (msg) => { console.error(`pi-scope: ${msg}`); process.exit(1); };
const info = (msg) => console.log(`\x1b[36m==>\x1b[0m ${msg}`);

function usage() {
  process.stdout.write(`pi-scope — start the Pi Scope app (Linux, macOS, Windows).

  pi-scope              desktop app (Electron window, default)
  pi-scope --web        headless server + open the WebUI in your browser
  pi-scope --server     headless server only, stays in the foreground

Flags:
  -d, --desktop         desktop app (default)
  -w, --web             headless server + open the browser
  -s, --server          headless server only
      --dev             add --watch (pair with --server/--web)
      --keep-server     leave a started server running when this exits
      --no-install      do not auto-install missing dependencies
  -p, --port <n>        server port            [SCOPE_PORT, default 43190]
  -H, --host <addr>     bind address           [SCOPE_HOST, default 127.0.0.1]
  -D, --db <path>       SQLite database path   [SCOPE_DB_PATH]
  -t, --token <value>   auth token             [SCOPE_AUTH_TOKEN]
  -h, --help            this text
`);
}

// ── Options ─────────────────────────────────────────────────────────────────

const opts = { mode: "desktop", dev: false, keepServer: false, noInstall: false, port: 0, host: "", db: "", token: "" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const need = (name) => { if (i + 1 >= argv.length) die(`${name} needs a value`); return argv[++i]; };
  switch (a) {
    case "-d": case "--desktop": opts.mode = "desktop"; break;
    case "-w": case "--web":     opts.mode = "web"; break;
    case "-s": case "--server":  opts.mode = "server"; break;
    case "--dev":                opts.dev = true; break;
    case "--keep-server":        opts.keepServer = true; break;
    case "--no-install":         opts.noInstall = true; break;
    case "-p": case "--port": {
      const value = need(a);
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) die(`--port needs a number 1-65535 (got '${value}')`);
      opts.port = n;
      break;
    }
    case "-H": case "--host":  opts.host = need(a); break;
    case "-D": case "--db":    opts.db = need(a); break;
    case "-t": case "--token": opts.token = need(a); break;
    case "-h": case "--help":  usage(); process.exit(0); break;
    default: die(`unknown option '${a}' (try --help)`);
  }
}

const NODE_MAJOR = parseInt(process.versions.node.split(".")[0], 10);
if (NODE_MAJOR < 24) {
  die(`Node.js 24+ required (running ${process.version}) — the server runs its .ts sources directly`);
}

// ── Config: real env > scope.env file > defaults ────────────────────────────

// Mirrors scope-control.js: plain KEY=VALUE lines, `#` comments and blanks
// ignored, real environment variables always win. This is how a desktop-icon
// launch (which inherits no shell env) still sees SCOPE_HOST=0.0.0.0 etc.
function readEnvFile() {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(ENV_FILE, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
const FILE_ENV = readEnvFile();

function readTokenFile() {
  const tf = process.env.SCOPE_TOKEN_FILE ?? path.join(RUN_DIR, "scope_token");
  try { return fs.readFileSync(tf, "utf8").trim(); } catch { return null; }
}

function config() {
  const pick = (key, override) => override || process.env[key] || FILE_ENV[key];
  const port = parseInt(pick("SCOPE_PORT", opts.port ? String(opts.port) : "") || "43190", 10);
  const host = pick("SCOPE_HOST", opts.host) || "127.0.0.1";
  const db = pick("SCOPE_DB_PATH", opts.db) || "";
  // Never fall back to a fixed token: it gates the /terminal WebSocket, i.e. a
  // full shell on this machine. A re-launch adopts the running server's token
  // from disk via readTokenFile().
  const token = pick("SCOPE_AUTH_TOKEN", opts.token) || readTokenFile() || crypto.randomUUID();
  // A wildcard bind is not a usable browser target — point the window at loopback.
  const displayHost = ["0.0.0.0", "::", "[::]"].includes(host) ? "127.0.0.1" : host;
  return { port, host, displayHost, db, token, healthUrl: `http://${displayHost}:${port}/health` };
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** 0 on a 2xx /health, without pulling in a dependency. */
async function healthOK(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ac.signal }); return r.ok; }
  catch { return false; }
  finally { clearTimeout(timer); }
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthOK(url)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Candidate dirs for the shared app install, most specific first (mirrors
 *  apps/scope-server/pi-bundle-paths.ts). */
function bundleDirs() {
  const out = [];
  const configured = (process.env.SCOPE_PI_BUNDLE_DIR || "").trim();
  if (configured) out.push(configured);
  out.push(path.join(os.homedir(), ".pi-scope", "pi"));
  out.push(path.join(DESKTOP_DIR, "pi-bundle"));
  return [...new Set(out)];
}

/** Whether the shared install provides `spec`. */
function hasBundlePackage(spec) {
  for (const dir of bundleDirs()) {
    try { if (fs.statSync(path.join(dir, "node_modules", ...spec.split("/"))).isDirectory()) return true; }
    catch { /* not in this bundle — try the next */ }
  }
  return false;
}

/** Load a package from the shared install. `electron`'s module exports its
 *  binary path, so returning the module's value is exactly what we want. */
function loadBundleDep(spec) {
  const requireFromHere = createRequire(import.meta.url);
  for (const dir of bundleDirs()) {
    try { return requireFromHere(requireFromHere.resolve(spec, { paths: [dir] })); }
    catch { /* not in this bundle — try the next */ }
  }
  try { return requireFromHere(spec); } catch { return null; }
}

/**
 * Install the shared app project (`~/.pi-scope/pi`) on first run: the bundled pi
 * agent, the server's runtime packages (node-pty, ws) and the desktop tooling
 * (electron, …). One tree, outside the checkout — apps/scope-desktop/
 * app-deps-install.mjs owns the install, so this only decides whether to run it.
 */
function ensureDeps(needElectron) {
  const required = ["@earendil-works/pi-coding-agent", "node-pty", "ws"];
  if (needElectron) required.push("electron");
  const missing = required.filter((spec) => !hasBundlePackage(spec));
  if (missing.length) {
    const installer = path.join(DESKTOP_DIR, "app-deps-install.mjs");
    if (opts.noInstall) {
      die(`dependencies are missing (${missing.join(", ")}) — run \`node ${path.relative(ROOT, installer)}\` first`);
    }
    if (!fs.existsSync(installer)) die(`missing installer: ${installer}`);
    info("installing dependencies into ~/.pi-scope/pi (first run only)…");
    const res = spawnSync(process.execPath, [installer], { cwd: ROOT, stdio: "inherit" });
    if (res.status !== 0) die(`the dependency install failed — run it manually: node ${installer}`);
  }
  // Give a fresh agent dir a working starting point before the extensions'
  // dependencies are resolved (the template carries the extensions manifest).
  seedAgentTemplate();
  runExtensionDeps();
}

/**
 * Install the npm dependencies of the extensions pi has available, in the
 * background (see apps/scope-desktop/pi-extensions-install.mjs).
 *
 * Detached on purpose: on a first run this can be a real download — the
 * `browser` extension's playwright — and the window must not wait minutes for
 * it. Nothing is blocked by it being late either: an extension whose packages
 * are still missing reports exactly that when it runs, and the next launch
 * finds them installed. Output lands in tmp/pi-extensions-install.log.
 */
function runExtensionDeps() {
  const installer = path.join(DESKTOP_DIR, "pi-extensions-install.mjs");
  if (!fs.existsSync(installer)) return;
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const log = fs.openSync(path.join(RUN_DIR, "pi-extensions-install.log"), "a");
    // The shipped manifest is the declaration for an agent dir that predates it
    // (those dirs are seeded once and never re-seeded); the installer ignores
    // the path when it is not there.
    const seed = path.join(ROOT, "examples", "pi_local", "agent", "extensions", "package.json");
    spawn(process.execPath, [installer, "--seed-manifest", seed], { detached: true, stdio: ["ignore", log, log] }).unref();
  } catch (err) {
    info(`the extension dependency install could not be started: ${err.message}`);
  }
}

/**
 * Seed the agent template on first run.
 *
 * Pi Scope's bundled `pi` runs in its own agent dir (`~/.pi-scope/agent`, or
 * SCOPE_AGENT_DIR). The server creates that dir on first boot but seeds nothing,
 * so an **empty `extensions/` is the tell** that nobody has set it up yet: copy
 * the shipped starter config (`examples/pi_local/agent`) in. Nothing is
 * overwritten (an existing file wins), and a dir that already has any extension
 * is left completely alone — so this is a no-op after the first run, and it
 * never disturbs a dir the user or the installer already populated. The skills'
 * large, platform-bound `.venv` and the obscura `*.tar.gz` bundles are skipped,
 * as are session logs and `__pycache__`.
 *
 * install/install.sh and install/install.ps1 seed the same template under the
 * same "extensions empty" rule, so every entry point ends up the same.
 */
function seedAgentTemplate() {
  const agentDir = process.env.SCOPE_AGENT_DIR || path.join(os.homedir(), ".pi-scope", "agent");
  const template = path.join(ROOT, "examples", "pi_local", "agent");
  const extensions = path.join(agentDir, "extensions");

  // A non-empty extensions dir means it is already set up (by the installer, by
  // the user, or by a previous run). Missing or empty → seed.
  try { if (fs.readdirSync(extensions).length > 0) return; } catch { /* missing → seed */ }
  try { if (!fs.statSync(template).isDirectory()) return; } catch { return; }

  const skipDirs = new Set([".venv", "sessions", "__pycache__"]);
  const skipFile = (name) => name.endsWith(".tar.gz") || name.endsWith(".pyc");
  try {
    fs.cpSync(template, agentDir, {
      recursive: true,
      force: false,          // an existing file always wins
      errorOnExist: false,   // ...and is skipped rather than raising
      filter: (src) => {
        const name = path.basename(src);
        if (skipDirs.has(name)) return false;
        try { if (fs.statSync(src).isDirectory()) return true; } catch { return false; }
        return !skipFile(name);
      },
    });
    info(`seeded the agent template into ${agentDir}`);
  } catch (err) {
    info(`could not seed the agent template into ${agentDir}: ${err.message}`);
  }
}

/** Path to the Electron binary the desktop app should run under, or null. */
function resolveElectron() {
  return loadBundleDep("electron");
}

function openBrowser(url) {
  try {
    if (isWin) spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch { /* no opener — the URL is printed above */ }
}

function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (isWin) {
    // Windows has no process-group signals: take the tree down (its agents and
    // terminals are children of the server).
    try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-proc.pid, "SIGTERM"); }          // detached ⇒ its own group
  catch { try { proc.kill("SIGTERM"); } catch { /* gone */ } }
}

function tailLog(n = 20) {
  try { return fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-n).join("\n"); }
  catch { return ""; }
}

// ── Desktop: hand off to Electron (its main.js owns the server) ─────────────

async function runDesktop() {
  ensureDeps(true);
  const electron = resolveElectron();
  if (!electron) die(`the Electron binary is missing — run \`node apps/scope-desktop/app-deps-install.mjs\``);

  const env = { ...process.env };
  // Chromium's SUID sandbox is broken in a few environments and hard-crashes
  // Electron before app code runs; the app sets its own no-sandbox/GPU switches.
  if (!isWin) env.ELECTRON_DISABLE_SANDBOX = env.ELECTRON_DISABLE_SANDBOX ?? "1";

  const once = (extra) => new Promise((resolve) => {
    const child = spawn(electron, [...extra, "."], { cwd: DESKTOP_DIR, stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });

  info("opening the Pi Scope desktop app…");
  const startedAt = Date.now();
  let code = await once([]);
  // "GPU process isn't usable." kills Chromium during startup on machines with a
  // broken GPU stack (VMs, containers). Retry once with software rendering —
  // only for a crash this early, never a window the user later closed.
  if (code !== 0 && Date.now() - startedAt < 30000) {
    info("desktop app died during startup — retrying with software rendering…");
    code = await once(["--disable-gpu", "--disable-gpu-sandbox", "--disable-software-rasterizer", "--in-process-gpu"]);
  }
  process.exit(code);
}

// ── Web / server: run the server here and adopt (or start) it ───────────────

async function runServer() {
  ensureDeps(false);
  const cfg = config();
  fs.mkdirSync(RUN_DIR, { recursive: true });

  // Reuse a healthy server rather than start a second one.
  if (await healthOK(cfg.healthUrl)) {
    info(`reusing the Pi Scope server already listening on ${cfg.host}:${cfg.port}.`);
    return finish(cfg, readTokenFile() ?? cfg.token, null);
  }

  const env = {
    ...process.env,
    SCOPE_PORT: String(cfg.port),
    SCOPE_HOST: cfg.host,
    SCOPE_AUTH_TOKEN: cfg.token,
  };
  if (cfg.db) env.SCOPE_DB_PATH = cfg.db;              // otherwise the server's own default

  const args = opts.dev ? ["--watch", "server.ts"] : ["server.ts"];
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(ERR_FILE, "a");
  info(`starting the Pi Scope server on ${cfg.host}:${cfg.port}…`);
  // Detached on POSIX so Ctrl-C here can still shut the server down gracefully
  // (we signal its process group); Windows uses taskkill /T instead.
  const proc = spawn(process.execPath, args, { cwd: SERVER_DIR, env, detached: !isWin, stdio: ["ignore", out, err] });
  proc.on("error", (e) => die(`failed to start the server: ${e.message}`));
  try { fs.writeFileSync(PID_FILE, String(proc.pid)); } catch { /* tmp not writable */ }

  if (!(await waitForHealth(cfg.healthUrl, opts.dev ? 45000 : 30000))) {
    stopServer(proc);
    try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
    const tail = tailLog();
    die(`server did not become healthy in time (see ${LOG_FILE})${tail ? `\n${tail}` : ""}`);
  }
  info("server healthy.");
  return finish(cfg, cfg.token, proc);
}

async function finish(cfg, token, proc) {
  const url = `http://${cfg.displayHost}:${cfg.port}/?token=${encodeURIComponent(token)}`;
  info(`Pi Scope is ready → ${url}`);
  if (opts.mode === "web") openBrowser(url);
  info(proc ? `Press Ctrl-C to stop it. Log: ${LOG_FILE}` : "Press Ctrl-C to stop watching.");

  // A server this launcher started is torn down on exit; an adopted one is left
  // alone. --keep-server deliberately leaves a started server running.
  const cleanup = () => {
    if (proc && !opts.keepServer) {
      info(`stopping server (pid ${proc.pid})…`);
      stopServer(proc);
    }
    if (proc) try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (proc && opts.keepServer) {
    info(`leaving the server running (pid ${proc.pid}, log: ${LOG_FILE}).`);
    process.exit(0);
  }

  // Stay in the foreground so this script owns the server's lifetime. Exit once
  // the process is gone, or after three consecutive failed health probes so a
  // single busy moment is not mistaken for a dead server.
  let misses = 0;
  for (;;) {
    if (proc && proc.exitCode !== null) break;
    if (await healthOK(cfg.healthUrl)) misses = 0;
    else { misses += 1; if (misses >= 3) break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (proc) try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
  info("server stopped.");
  process.exit(0);
}

// ── Go ──────────────────────────────────────────────────────────────────────

if (opts.mode === "desktop") await runDesktop();
else await runServer();
