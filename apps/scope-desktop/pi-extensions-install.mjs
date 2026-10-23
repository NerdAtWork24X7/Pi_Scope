#!/usr/bin/env node
/**
 * pi-extensions-install.mjs — install the npm dependencies of the extensions pi
 * has available.
 *
 * Pi discovers extensions in its agent dir: every TypeScript/JavaScript file and
 * every directory with an `index.*` entry under `<agentDir>/extensions/`, plus
 * whatever the agent's `settings.json` adds with `+path` or removes with `-path`
 * (see pi's docs/extensions.md). An extension that imports npm packages declares
 * them in a nearby `package.json` — pi's own convention — but pi only installs
 * those for the *packages it installed itself* (npm/git sources, which land in
 * `<agentDir>/npm`). For a local extension nobody does it, so Pi Scope does.
 *
 * Where they go: the agent dir's own npm project (`<agentDir>/pi`, i.e.
 * `~/.pi-scope/agent/pi`). pi loads extensions from the agent dir, so their
 * packages live with it — never buried in the app's bundled-pi project
 * (`~/.pi-scope/pi`, which Settings → Update owns) — and there are no
 * per-extension node_modules. Pi Scope pins `PI_BROWSER_MODULE_ROOT` to it so
 * extensions that resolve their packages at runtime (the `browser` extension)
 * find them.
 *
 * Every entry point uses this one script, like pi-bundle-install.mjs:
 *
 *   • `pi-scope.mjs` / `run.sh`        — the dev launcher, in the background
 *   • `scope-control.js`                — the packaged app, in the background
 *
 * Plain Node, no repo imports and no dependencies, so it runs under the
 * server's Node and under the portable Node inside a package.
 *
 *   node pi-extensions-install.mjs [options]
 *
 *     --agent <dir>   agent dir       [default: SCOPE_AGENT_DIR,
 *                                      PI_CODING_AGENT_DIR, ~/.pi-scope/agent]
 *     --bundle <dir>  install root    [default: <agent dir>/pi]
 *     --seed-manifest <file>
 *                     the shipped extensions manifest, used for an extension
 *                     that has none of its own (an agent dir seeded before the
 *                     manifest existed is never re-seeded)
 *     --pm <name>     npm | pnpm | bun
 *     --npm <bin>     package manager binary [default: SCOPE_NPM_BIN, else --pm]
 *     --json          machine-readable report on stdout
 *     -h, --help      this text
 *
 * Exit code 0 means every declared dependency is present (including "there was
 * nothing to do"); 1 means something is still missing, with the reason on
 * stderr. A missing extension dependency is never fatal to the app: the
 * extension that needs it reports that itself when it runs.
 *
 * The install itself is made to survive what a detached, often-concurrent
 * process runs into. Every entry point starts this script in the background and
 * nothing prevents two launches from overlapping, so a lock file serialises the
 * `npm install`s against the one shared tree; and because an interrupted npm run
 * can leave `node_modules` half-removed (the `ENOTEMPTY` a later run hits while
 * it re-links the tree), a transient failure is retried once from a clean tree.
 * This never hides a real failure: a genuine error is reported exactly as before
 * (exit 1 with the reason), it is just retried from a known-good state first.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Packages pi provides to extensions itself — never installed from here. */
const HOST_PACKAGES = [/^@earendil-works\/pi-/, /^@mariozechner\/pi-/, /^typebox$/];
/** A direct extension file, and a directory extension's entry point. */
const EXTENSION_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const INDEX_ENTRY = /^index\.(ts|mts|cts|js|mjs|cjs)$/;

/** Set by `--json`: the report on stdout must stay parseable on its own. */
let quiet = false;
const die = (msg) => { console.error(`pi-extensions-install: ${msg}`); process.exit(1); };
const info = (msg) => { if (!quiet) console.log(`==> ${msg}`); };
const isHostProvided = (spec) => HOST_PACKAGES.some((pattern) => pattern.test(spec));
const dedupe = (values) => [...new Set(values)];
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Package-manager argument sets — mirrors pi-bundle-install.mjs. */
const PM_ARGS = {
  npm: [["install", "--no-audit", "--no-fund"]],
  pnpm: [["install", "--no-ignore-scripts"]],
  bun: [["install"], ["pm", "trust", "--all"]],
};

function usage() {
  process.stdout.write(
    "Install the npm dependencies of the extensions pi has available into the\n" +
    "agent dir's own npm project (<agent dir>/pi).\n\n" +
    "  node pi-extensions-install.mjs [--agent <dir>] [--bundle <dir>]\n" +
    "                                 [--pm npm|pnpm|bun] [--npm <bin>] [--json]\n",
  );
}

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    agent: (process.env.SCOPE_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || "").trim()
      || path.join(os.homedir(), ".pi-scope", "agent"),
    bundle: "",
    bundleGiven: false,
    seedManifest: "",
    pm: "npm",
    npm: "",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const need = (name) => { if (i + 1 >= argv.length) die(`${name} needs a value`); return argv[++i]; };
    switch (argv[i]) {
      case "--agent": opts.agent = need("--agent"); break;
      case "--bundle": opts.bundle = need("--bundle"); opts.bundleGiven = true; break;
      case "--seed-manifest": opts.seedManifest = need("--seed-manifest"); break;
      case "--pm": opts.pm = need("--pm"); break;
      case "--npm": opts.npm = need("--npm"); break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default: die(`unknown option '${argv[i]}' (try --help)`);
    }
  }
  if (!PM_ARGS[opts.pm]) die(`--pm must be npm, pnpm or bun (got '${opts.pm}')`);
  opts.agent = path.resolve(opts.agent);
  // Default root is the agent dir's own npm project, so the extensions'
  // packages live with the agent rather than in the app's bundled-pi project.
  if (!opts.bundle) opts.bundle = path.join(opts.agent, "pi");
  opts.bundle = path.resolve(opts.bundle);
  opts.seedManifest = opts.seedManifest && isFile(opts.seedManifest) ? path.resolve(opts.seedManifest) : null;
  return opts;
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** Read a JSON file, or null when it is absent or malformed. */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Every extension the agent dir offers by convention, as absolute roots: a
 * direct `.ts`/`.js` file, or a directory holding an `index.*` entry. A
 * directory without one is not an extension, and neither is any other file.
 */
function discoveredExtensions(agentDir) {
  const root = path.join(agentDir, "extensions");
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (entry.isFile() && EXTENSION_FILE.test(entry.name)) out.push(path.join(root, entry.name));
    if (!entry.isDirectory()) continue;
    let inner;
    try { inner = fs.readdirSync(path.join(root, entry.name)); } catch { continue; }
    if (inner.some((name) => INDEX_ENTRY.test(name))) out.push(path.join(root, entry.name));
  }
  return out.sort();
}

/**
 * Canonicalise a configured extension path to how discovery names it: an
 * `index.*` file inside a directory extension stands for that directory, so
 * `+extensions/agent-team` and `+extensions/agent-team/index.ts` are the same
 * extension and never load (or install) twice.
 */
function canonicalExtension(value, discovered) {
  const resolved = path.resolve(value);
  if (discovered.includes(resolved)) return resolved;
  const dir = path.dirname(resolved);
  if (INDEX_ENTRY.test(path.basename(resolved)) && discovered.includes(dir)) return dir;
  return resolved;
}

/**
 * The extensions pi has available, from the agent dir plus the agent's
 * `settings.json`.
 *
 * `settings.extensions` uses pi's resource-filter syntax: `+path` includes one
 * exact path, `-path` excludes one, and a bare path is another extension
 * location (absolute, or relative to the agent dir). As soon as any `+` entry is
 * present that list *is* the enabled set — discovery is not consulted — which is
 * how a user turns individual extensions off. Without the key, everything found
 * by convention loads.
 */
function availableExtensions(agentDir) {
  const settings = readJson(path.join(agentDir, "settings.json")) ?? {};
  const list = Array.isArray(settings.extensions)
    ? settings.extensions.filter((entry) => typeof entry === "string" && entry.trim())
    : null;

  const discovered = discoveredExtensions(agentDir);
  if (!list) return { extensions: discovered, disabled: [] };

  const includes = [], explicit = [];
  const disabled = new Set();
  for (const raw of list) {
    const value = raw.trim();
    if (value.startsWith("+")) includes.push(canonicalExtension(path.resolve(agentDir, value.slice(1)), discovered));
    else if (value.startsWith("-")) disabled.add(canonicalExtension(path.resolve(agentDir, value.slice(1)), discovered));
    else explicit.push(canonicalExtension(path.resolve(agentDir, value), discovered));
  }
  const base = includes.length ? includes : discovered;
  return {
    extensions: dedupe([...base, ...explicit]).filter((p) => !disabled.has(p)),
    disabled: [...disabled],
  };
}

/**
 * The nearest `package.json` at or above an extension — its own directory first,
 * then each parent up to the agent dir. Null when the extension declares nothing
 * (pi's convention leaves the dependency tree to the author; an extension that
 * imports no npm packages simply has no manifest).
 *
 * An extension outside the agent dir only ever gets its own directory checked:
 * walking further would let an unrelated package.json above it decide what the
 * agent installs.
 */
function manifestFor(agentDir, extension) {
  const start = isDir(extension) ? extension : path.dirname(extension);
  const root = path.resolve(agentDir);
  const inside = start === root || start.startsWith(root + path.sep);
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (isFile(candidate)) return candidate;
    if (!inside || dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A manifest's installable dependencies and install-script approvals. */
function manifestDeps(manifest) {
  const pkg = readJson(manifest) ?? {};
  const deps = {};
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!isHostProvided(name)) deps[name] = range;
  }
  return { deps, allowScripts: { ...(pkg.allowScripts ?? {}) } };
}

/** Whether `spec` is installed in the extensions project's node_modules. */
function installedIn(bundle, spec) {
  return isFile(path.join(bundle, "node_modules", ...spec.split("/"), "package.json"));
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Record the dependencies in the extensions project's own manifest, so a later
 * `npm install` keeps them and the tree stays reproducible. Existing entries win
 * — an extension's range must not rewrite the version the project already
 * resolved. The file is only written when a field actually changes.
 */
function mergeIntoBundle(bundle, deps, allowScripts) {
  const file = path.join(bundle, "package.json");
  const pkg = readJson(file);
  if (!pkg) return false;
  const merged = {
    ...pkg,
    dependencies: { ...deps, ...(pkg.dependencies ?? {}) },
  };
  if (Object.keys(allowScripts).length) {
    merged.allowScripts = { ...allowScripts, ...(pkg.allowScripts ?? {}) };
  }
  const added = (want = {}, have = {}) => Object.entries(want).some(([name, value]) => have[name] !== value);
  if (!added(merged.dependencies, pkg.dependencies) && !added(merged.allowScripts, pkg.allowScripts)) return true;
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return true;
}

/** npm's CLI as shipped with the Node running this script, or null. */
function npmCliBeside(nodeBin) {
  const dir = path.dirname(nodeBin);
  const candidates = [
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Quote a program path for the platform's shell (fallback path only). */
function shellQuote(value) {
  return process.platform === "win32"
    ? `"${value}"`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Concurrency and recovery ────────────────────────────────────────────────

/**
 * The lock that serialises installs against one bundled project, and how long a
 * wait for it may last. A stale lock (its owner died) is reclaimed rather than
 * waited on, and `SCOPE_EXTENSIONS_LOCK_WAIT_MS` shortens the wait in tests.
 */
const LOCK_NAME = ".installing.lock";
const LOCK_STALE_MS = 10 * 60_000;
const lockWaitMs = () => {
  const raw = Number(process.env.SCOPE_EXTENSIONS_LOCK_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
};

/**
 * Take the bundle's install lock, waiting for a live holder to finish and
 * reclaiming one whose owner is gone.
 *
 * Two launches of Pi Scope both start this installer in the background, and two
 * `npm install`s sharing one `node_modules` corrupt each other (npm removes a
 * directory another process is still reading). A waiting caller can make the
 * same finding as the holder once it is done — `missing` is a filesystem check —
 * so the holder owns the install and everyone else just waits for it. Returns
 * false when the lock is still held after the wait (or cannot be created at
 * all), which is not a failure: the caller verifies afterwards either way.
 */
async function acquireInstallLock(bundle) {
  const file = path.join(bundle, LOCK_NAME);
  const started = Date.now();
  for (let warned = false; ;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      // Nothing below can help when the lock is uncreatable for another reason
      // (a read-only directory, say): let the verification report the result.
      if (err.code !== "EEXIST") return false;
    }
    const age = (() => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; } })();
    const owner = (() => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return "?"; } })();
    const dead = age > LOCK_STALE_MS || (Number(owner) > 0 && !isAlive(Number(owner)));
    if (dead) {
      if (!warned) { info(`stale extension install lock (${file}) — reclaiming it`); warned = true; }
      try { fs.rmSync(file, { force: true }); } catch { /* the poll below waits it out */ }
      continue;
    }
    if (Date.now() - started >= lockWaitMs()) return false;
    await sleep(200);
  }
}

/** Whether a pid names a process that still exists (signal 0 probes without sending). */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== "ESRCH"; }
}

/** Release the bundle's install lock (best effort — a leftover is reclaimed). */
function releaseInstallLock(bundle) {
  try { fs.rmSync(path.join(bundle, LOCK_NAME), { force: true }); } catch { /* nothing to do */ }
}

/**
 * Run a package manager once, streaming its output to this process and
 * returning the exit status (`null` when a signal killed it).
 *
 * Streaming rather than buffering matters here: this installer is detached and
 * its log is the only sign of progress on a first-run download. The captured
 * text is only used to recognise a retryable failure.
 */
function streamInstall(pm, explicitBin, dir, args = PM_ARGS[pm][0]) {
  const npmCli = !explicitBin && pm === "npm" ? npmCliBeside(process.execPath) : null;
  return new Promise((resolve) => {
    const child = npmCli
      ? spawn(process.execPath, [npmCli, ...args], { cwd: dir })
      : spawn(`${shellQuote(explicitBin || pm)} ${args.join(" ")}`, { cwd: dir, shell: true });
    let tail = "";
    const decoder = new StringDecoder("utf8");
    const sink = (stream) => (chunk) => {
      stream.write(chunk);
      tail = (tail + decoder.write(chunk)).slice(-8192);
    };
    child.stdout?.on("data", sink(process.stdout));
    child.stderr?.on("data", sink(process.stderr));
    child.on("error", (err) => {
      const who = npmCli ? `node ${npmCli}` : (explicitBin || pm);
      console.error(`pi-extensions-install: could not run ${who}: ${err.message}`);
      resolve({ status: null, output: tail, spawnError: true });
    });
    child.on("close", (status) => { tail += decoder.end(); resolve({ status, output: tail }); });
  });
}

/**
 * Exit statuses npm returns for problems a retry from a clean tree can clear.
 * The tree below is reached only after a run *failed* and only for npm, and a
 * real error reproduces on the retry — so this recovers an interrupted install
 * without ever turning a genuine failure into a success.
 */
const TRANSIENT_STATUSES = new Set([1, 2, 3, 4, 5]);
const TRANSIENT_PATTERN = /ENOTEMPTY|ENOTDIR|EBUSY|ENOENT|EACCES|EPERM|EEXIST|reify|tarball|TAR_ENTRY|must be empty|not empty/i;

/** Whether a failed npm run looks like a half-removed tree rather than a real error. */
function isTransientFailure(pm, result) {
  if (pm !== "npm" || result.spawnError) return false;
  if (result.status !== null && !TRANSIENT_STATUSES.has(result.status)) return false;
  return TRANSIENT_PATTERN.test(result.output);
}

/** Remove the bundle's package tree so the next install re-links it from scratch. */
function cleanInstallTree(bundle) {
  try { fs.rmSync(path.join(bundle, "node_modules"), { recursive: true, force: true }); }
  catch { /* a locked file: the retry attempts the install anyway */ }
}

/** Run the package manager's install in `dir`. Returns true on success. */
async function runInstall(pm, explicitBin, dir) {
  const first = await streamInstall(pm, explicitBin, dir, PM_ARGS[pm][0]);
  if (first.status === 0) {
    // `bun` blocks a package's build scripts until it is trusted; that second
    // pass is not a reinstall, and the tree is verified from disk afterwards.
    if (pm !== "bun" || PM_ARGS[pm].length < 2) return true;
    const trust = await streamInstall(pm, explicitBin, dir, PM_ARGS[pm][1]);
    // `bun pm trust` exits 1 when nothing is left to trust — not a failure.
    return trust.status === 0 || trust.status === 1;
  }

  // An interrupted npm run leaves the tree half-removed. Re-running on top of it
  // only reproduces ENOTEMPTY, so the second attempt starts from a clean tree.
  // Other package managers (and non-npm failures) are reported as before.
  if (!isTransientFailure(pm, first)) return false;
  info(`${pm} install hit a transient error — retrying from a clean node_modules…`);
  cleanInstallTree(dir);
  return (await streamInstall(pm, explicitBin, dir, PM_ARGS[pm][0])).status === 0;
}

/** Human label for how the install will run (mirrors runInstall's choice). */
function pmLabel(pm, explicitBin) {
  if (explicitBin) return explicitBin;
  if (pm === "npm" && npmCliBeside(process.execPath)) return "the npm shipped with Node";
  return pm;
}

// ── Go ──────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
quiet = opts.json;

// No agent dir yet is a normal state: Pi Scope creates it on first run and the
// launcher seeds it. Nothing to inspect, nothing to install.
if (!isDir(opts.agent)) {
  const empty = {
    agent: opts.agent, bundle: opts.bundle, extensions: [], piPackages: [], disabled: [],
    missing: [], installed: [], ok: true, note: "no agent dir",
  };
  if (opts.json) process.stdout.write(JSON.stringify(empty, null, 2) + "\n");
  else info(`no agent dir at ${opts.agent} — no extensions to install for.`);
  process.exit(0);
}

const settings = readJson(path.join(opts.agent, "settings.json")) ?? {};
const { extensions, disabled } = availableExtensions(opts.agent);
/** Packages pi installed itself (npm/git sources); their dependencies are pi's. */
const piPackages = (Array.isArray(settings.packages) ? settings.packages : [])
  .map((entry) => (typeof entry === "string" ? entry : entry?.source))
  .filter((source) => typeof source === "string");

// The manifest is the unit, not the extension: a package.json in the extensions
// directory declares its packages for every extension under it (exactly like a
// repo's own package.json), and an extension that imports none of them simply
// does not use them. One extension with a manifest of its own gets its own entry.
/** manifest path → { manifest, shipped, extensions, dependencies } */
const manifests = new Map();
/** spec → { range, allowScripts } */
const wanted = new Map();
let undeclared = 0;

for (const extension of extensions) {
  // An extension with no manifest of its own falls back to the shipped one: an
  // agent dir seeded by an older release is never re-seeded, so it declares
  // nothing while still shipping the extensions that need these packages.
  const own = manifestFor(opts.agent, extension);
  const manifest = own ?? opts.seedManifest;
  if (!manifest) { undeclared += 1; continue; }

  let entry = manifests.get(manifest);
  if (!entry) {
    const { deps, allowScripts } = manifestDeps(manifest);
    entry = { manifest, shipped: manifest === opts.seedManifest, extensions: [], dependencies: deps };
    manifests.set(manifest, entry);
    for (const [spec, range] of Object.entries(deps)) {
      const known = wanted.get(spec);
      if (known) { known.allowScripts = { ...allowScripts, ...known.allowScripts }; continue; }
      wanted.set(spec, { range, allowScripts });
    }
  }
  entry.extensions.push(extension);
}

const declared = [...wanted.keys()];
const missing = declared.filter((spec) => !installedIn(opts.bundle, spec));
const report = {
  agent: opts.agent,
  bundle: opts.bundle,
  seedManifest: opts.seedManifest,
  extensions,
  manifests: [...manifests.values()],
  piPackages,
  disabled,
  missing,
  installed: declared.filter((spec) => !missing.includes(spec)),
  ok: missing.length === 0,
};

/** Print the report (`--json`) and hand it back for further use. */
function emit(extra = {}) {
  const final = { ...report, ...extra };
  if (opts.json) process.stdout.write(JSON.stringify(final, null, 2) + "\n");
  return final;
}

if (!opts.json) {
  info(`extensions available to pi: ${extensions.length}`);
  for (const entry of manifests.values()) {
    const deps = Object.keys(entry.dependencies);
    if (!deps.length) continue;
    // Where the declaration lives: the extension's own package.json, or the one
    // the release ships (for a dir seeded before that manifest existed, which
    // lives outside the agent dir — name it in full then).
    const relative = path.relative(opts.agent, entry.manifest);
    const label = relative && !relative.startsWith("..") ? relative : entry.manifest;
    info(`  npm dependencies in ${label}${entry.shipped ? " (shipped)" : ""}: ${deps.join(", ")}`);
  }
  if (undeclared) info(`  ${undeclared} extension(s) declare no npm dependencies`);
  if (disabled.length) info(`  disabled in settings.json: ${disabled.map((p) => path.relative(opts.agent, p)).join(", ")}`);
  if (piPackages.length) info(`pi manages its own package dependencies for: ${piPackages.join(", ")}`);
}

if (!extensions.length) {
  emit();
  info(`no extensions in ${path.join(opts.agent, "extensions")} — nothing to install.`);
  process.exit(0);
}

if (!missing.length) {
  emit();
  if (declared.length) info(`every extension dependency is already installed in ${opts.bundle}.`);
  process.exit(0);
}

// The default root is the agent dir's own project, so create it on first use. An
// explicit --bundle is the caller's project and must already exist.
if (!isFile(path.join(opts.bundle, "package.json"))) {
  if (opts.bundleGiven) {
    die(`no bundled pi project at ${opts.bundle} to install ${missing.join(", ")} into`);
  }
  try {
    fs.mkdirSync(opts.bundle, { recursive: true });
    fs.writeFileSync(
      path.join(opts.bundle, "package.json"),
      JSON.stringify({ name: "pi-scope-agent-extensions", version: "1.0.0", private: true }, null, 2) + "\n",
    );
  } catch (err) {
    die(`could not create the extensions project at ${opts.bundle}: ${err.message}`);
  }
}
const ranges = Object.fromEntries([...wanted].map(([spec, entry]) => [spec, entry.range]));
const allowScripts = Object.assign({}, ...[...wanted.values()].map((entry) => entry.allowScripts));

if (!mergeIntoBundle(opts.bundle, ranges, allowScripts)) {
  die(`could not record ${missing.join(", ")} in ${path.join(opts.bundle, "package.json")}`);
}

// Serialise against another launch's installer sharing this tree (see
// acquireInstallLock). Losing the race is not a failure: the holder installs and
// this call simply verifies the result.
const locked = await acquireInstallLock(opts.bundle);
const explicit = (opts.npm || process.env.SCOPE_NPM_BIN || "").trim();
try {
  if (locked) {
    // The installer tells the truth about the tree, not about `missing` above:
    // the wait for the lock may have been satisfied by the holder.
    const stillToInstall = declared.filter((spec) => !installedIn(opts.bundle, spec));
    if (stillToInstall.length) {
      info(`installing ${stillToInstall.join(", ")} with ${pmLabel(opts.pm, explicit)} in ${opts.bundle} (this can take a minute)…`);
      if (!(await runInstall(opts.pm, explicit, opts.bundle))) {
        die(`${pmLabel(opts.pm, explicit)} install failed — ${declared.join(", ")} missing from ${opts.bundle}`);
      }
    }
  } else {
    info(`another extension install is running in ${opts.bundle}; waiting for it was not possible — verifying instead.`);
  }
} finally {
  if (locked) releaseInstallLock(opts.bundle);
}

const stillMissing = declared.filter((spec) => !installedIn(opts.bundle, spec));
emit({ missing: stillMissing, installed: declared.filter((spec) => !stillMissing.includes(spec)), ok: stillMissing.length === 0 });
if (stillMissing.length) {
  die(`${stillMissing.join(", ")} still missing from ${opts.bundle}${locked ? " after installing" : " — another install is in progress"}`);
}
info(`installed ${declared.join(", ")} into ${opts.bundle}`);
