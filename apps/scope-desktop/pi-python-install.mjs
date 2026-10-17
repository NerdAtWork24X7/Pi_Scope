#!/usr/bin/env node
/**
 * pi-python-install.mjs — create and refresh Pi Scope's shared Python venv.
 *
 * Pi Scope ships Python-dependent elements (the `web_fetch` extension, the
 * `video-creator` skill). Instead of each one bootstrapping its own `.venv`,
 * they all share one environment beside the `pi` agent dir — `~/.pi-scope/.venv`
 * under Pi Scope, `~/.pi/.venv` under a global `pi` — built with `uv` from the
 * single requirements file this script owns
 * (apps/scope-desktop/pi-venv/requirements.txt). When the set includes
 * playwright, its Chromium build is installed beside it in the same base dir's
 * `playwright-browsers` — the one dir the Node `browser` extension and the
 * Python elements share — instead of Playwright's default `~/.cache/ms-playwright`.
 *
 * The base dir is derived from the agent dir (`SCOPE_AGENT_DIR` /
 * `PI_CODING_AGENT_DIR`, falling back to Pi Scope's `~/.pi-scope/agent`), so the
 * same defaults serve both Pi Scope and a global `pi`. Elements find the venv
 * through `SCOPE_PYTHON_VENV` (pinned by agent-dir.ts, the `pi` shim and the chat
 * child env) or by the well-known default path; the browsers dir is advertised
 * through `PLAYWRIGHT_BROWSERS_PATH` the same way.
 *
 * Cheapest path first: a stamp beside the venv records the requirements file's
 * content hash; when it matches and the interpreter exists, the install is
 * skipped entirely — no uv run, no network. Otherwise `uv venv` + `uv pip
 * install` (+ `playwright install chromium` when playwright is part of the set)
 * run, and the stamp is rewritten.
 *
 * Every entry point uses this one script, like pi-extensions-install.mjs:
 *
 *   • `pi-scope.mjs` / `run.sh`        — the dev launcher, in the background
 *   • `scope-control.js`                — the packaged app, in the background
 *
 * Plain Node, no repo imports and no dependencies, so it runs under the
 * server's Node and under the portable Node inside a package.
 *
 *   node pi-python-install.mjs [options]
 *
 *     --venv <dir>          venv to build   [default: SCOPE_PYTHON_VENV, else
 *                                            <agentDir>/../.venv]
 *     --requirements <file> what to install  [default: pi-venv/requirements.txt
 *                                            beside this script]
 *     --uv <bin>            uv launcher      [default: PATH, then well-known
 *                                            install dirs]
 *     --python <version>    interpreter for `uv venv` [default: 3.12]
 *     --browsers <dir>      Playwright browsers [default: PLAYWRIGHT_BROWSERS_PATH,
 *                                            else <agentDir>/../playwright-browsers]
 *     --json                machine-readable report on stdout
 *     -h, --help            this text
 *
 * Exit code 0 means the venv exists and holds the requirements (including
 * "there was nothing to do"); 1 means something is still missing, with the
 * reason on stderr. A missing Python env is never fatal to the app: an element
 * that needs it reports the missing piece itself when it runs.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REQUIREMENTS = path.join(HERE, "pi-venv", "requirements.txt");
/** Records the requirements hash next to the venv so a satisfied venv is a
 *  pure filesystem check on the next launch. */
const STAMP_NAME = ".pi-scope-venv.json";

/** Set by `--json`: the report on stdout must stay parseable on its own. */
let quiet = false;
const die = (msg) => { console.error(`pi-python-install: ${msg}`); process.exit(1); };
const info = (msg) => { if (!quiet) console.log(`==> ${msg}`); };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const IS_WINDOWS = process.platform === "win32";
const venvBinDir = (venv) => path.join(venv, IS_WINDOWS ? "Scripts" : "bin");
const venvPython = (venv) => path.join(venvBinDir(venv), IS_WINDOWS ? "python.exe" : "python3");

/** Platform-specific `uv` install dirs, probed only when PATH lookup misses
 *  (mirrors the web_fetch runner). The standalone installer lands `uv` in
 *  `~/.local/bin` (`XDG_BIN_HOME` when set) and `cargo install` in
 *  `~/.cargo/bin`; a macOS Homebrew `uv` lives in a brew prefix. */
function uvFallbackDirs() {
  const home = os.homedir();
  if (IS_WINDOWS) {
    const profile = process.env.USERPROFILE || home;
    return [path.join(profile, ".local", "bin"), path.join(profile, ".cargo", "bin")];
  }
  const dirs = [process.env.XDG_BIN_HOME || path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
  if (process.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  return dirs;
}

/** Locate the `uv` launcher: PATH first, then the well-known dirs — never a
 *  hardcoded interpreter path. `--uv` overrides; the bare name is the last
 *  resort, so a spawn surfaces a clear ENOENT when uv is genuinely absent. */
function resolveUv(explicit) {
  if (explicit) return explicit;
  const exe = IS_WINDOWS ? "uv.exe" : "uv";
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const dirs = [...new Set([...pathDirs, ...uvFallbackDirs()])];
  return dirs.map((d) => path.join(d, exe)).find(isFile) ?? exe;
}

function usage() {
  process.stdout.write(
    "Create and refresh the shared Python venv (~/.pi-scope/.venv under Pi Scope,\n" +
    "~/.pi/.venv under a global pi) from pi-venv/requirements.txt, using uv, plus\n" +
    "its Playwright browsers.\n\n" +
    "  node pi-python-install.mjs [--venv <dir>] [--requirements <file>]\n" +
    "                             [--uv <bin>] [--python <version>]\n" +
    "                             [--browsers <dir>] [--json]\n",
  );
}

/** Pi Scope's data dir — the parent of the `pi` agent dir. Under Pi Scope that
 *  is ~/.pi-scope; under a global `pi` the agent dir defaults to ~/.pi/agent, so
 *  deriving here lets one set of defaults serve both. Resolves like agent-dir.ts
 *  (SCOPE_AGENT_DIR, Pi Scope's own override, wins so the built venv always
 *  matches what the server pins), then PI_CODING_AGENT_DIR (what pi itself
 *  reads; point the installer at a global pi with it), then Pi Scope's own
 *  default. */
function scopeBaseDir() {
  const agentDir = (process.env.SCOPE_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || "").trim()
    || path.join(os.homedir(), ".pi-scope", "agent");
  return path.dirname(agentDir);
}

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const base = scopeBaseDir();
  const opts = {
    venv: (process.env.SCOPE_PYTHON_VENV || "").trim() || path.join(base, ".venv"),
    requirements: DEFAULT_REQUIREMENTS,
    // One Playwright browsers dir shared by the Node and Python elements,
    // beside the agent dir (agent-dir.ts computes the same default).
    browsers: (process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim()
      || path.join(base, "playwright-browsers"),
    uv: "",
    python: "3.12",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const need = (name) => { if (i + 1 >= argv.length) die(`${name} needs a value`); return argv[++i]; };
    switch (argv[i]) {
      case "--venv": opts.venv = need("--venv"); break;
      case "--requirements": opts.requirements = need("--requirements"); break;
      case "--browsers": opts.browsers = need("--browsers"); break;
      case "--uv": opts.uv = need("--uv"); break;
      case "--python": opts.python = need("--python"); break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default: die(`unknown option '${argv[i]}' (try --help)`);
    }
  }
  opts.venv = path.resolve(opts.venv);
  opts.requirements = path.resolve(opts.requirements);
  opts.browsers = path.resolve(opts.browsers);
  return opts;
}

// ── Install ─────────────────────────────────────────────────────────────────

/** Run a command. `--json` captures output so the report on stdout stays
 *  parseable; otherwise the child writes straight to the log. `extraEnv` layers
 *  on top of the inherited environment (the Playwright browsers dir). */
function run(opts, cmd, args, extraEnv = null) {
  const res = spawnSync(cmd, args, {
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: opts.json ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (res.error) return { ok: false, note: `could not run ${cmd}: ${res.error.message}` };
  const tail = (buf) => String(buf ?? "").trim().split("\n").slice(-3).join(" ") || "(no output)";
  if (res.status !== 0) return { ok: false, note: `${cmd} exited ${res.status}: ${tail(opts.json ? res.stderr : "")}` };
  return { ok: true, note: "" };
}

const opts = parseArgs(process.argv.slice(2));
quiet = opts.json;

if (!isFile(opts.requirements)) die(`requirements file not found: ${opts.requirements}`);

const py = venvPython(opts.venv);
const reqHash = crypto.createHash("sha256").update(fs.readFileSync(opts.requirements)).digest("hex");
const stampFile = path.join(opts.venv, STAMP_NAME);
let stamp = null;
try { stamp = JSON.parse(fs.readFileSync(stampFile, "utf8")); } catch { /* no/!json stamp */ }

const report = {
  venv: opts.venv,
  python: py,
  requirements: opts.requirements,
  requirementsHash: reqHash,
  browsers: opts.browsers,
  installed: [],
  upToDate: false,
};
const emit = (extra = {}) => {
  const final = { ...report, ...extra };
  if (opts.json) process.stdout.write(JSON.stringify(final, null, 2) + "\n");
  return final;
};

// Fast path: interpreter present, the requirements are unchanged since the last
// successful install, and — when the set needs it — Chromium is already in
// `opts.browsers`. A failed download leaves the stamp's `chromium` false (and a
// relocated browsers dir changes `browsers`), so the next launch retries the
// browser without re-resolving the Python packages.
const requirementsMatch = stamp?.requirementsHash === reqHash;
const needsPlaywright = /^\s*playwright\b/m.test(fs.readFileSync(opts.requirements, "utf8"));
const chromiumReady = !needsPlaywright || (stamp?.chromium === true && stamp?.browsers === opts.browsers);
if (isFile(py) && requirementsMatch && chromiumReady) {
  emit({ upToDate: true });
  info(`the shared Python venv is up to date: ${opts.venv}`);
  process.exit(0);
}

const uv = resolveUv(opts.uv);
const venvExisted = isFile(py);
if (!venvExisted || !requirementsMatch) {
  info(`building the shared Python venv at ${opts.venv} with ${uv} (this can take a minute)…`);
}

if (!venvExisted) {
  try { fs.mkdirSync(opts.venv, { recursive: true }); }
  catch (err) { die(`could not create ${opts.venv}: ${err.message}`); }
  const venv = run(opts, uv, ["venv", "--python", opts.python, opts.venv]);
  if (!venv.ok) die(`uv venv failed — ${venv.note}`);
  report.installed.push("venv");
}
if (!isFile(py)) die(`no interpreter produced at ${py}`);

if (!venvExisted || !requirementsMatch) {
  const pip = run(opts, uv, ["pip", "install", "--python", py, "-r", opts.requirements]);
  if (!pip.ok) die(`uv pip install failed — ${pip.note}`);
  report.installed.push("requirements");
}

// Chromium for Playwright, only when playwright is part of the set. It lands in
// Pi Scope's own browsers dir so the Node `browser` extension and the Python
// elements share one build. A failure here is not fatal: a browser build may
// already be cached elsewhere.
let chromium = !needsPlaywright;
if (needsPlaywright) {
  const res = run(opts, py, ["-m", "playwright", "install", "chromium"], {
    PLAYWRIGHT_BROWSERS_PATH: opts.browsers,
  });
  chromium = res.ok;
  if (res.ok) report.installed.push("chromium");
  else info(`Chromium could not be installed (a cached build may still work) — ${res.note}`);
}

try {
  fs.writeFileSync(
    stampFile,
    JSON.stringify({ requirementsHash: reqHash, python: py, browsers: opts.browsers, chromium }, null, 2) + "\n",
  );
} catch (err) {
  info(`could not write ${stampFile} (the venv still works): ${err.message}`);
}

emit();
if (report.installed.length) info(`updated ${opts.venv} (${report.installed.join(", ")})`);
else info(`the shared Python venv is up to date: ${opts.venv}`);
