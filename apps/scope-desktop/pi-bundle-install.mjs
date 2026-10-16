#!/usr/bin/env node
/**
 * pi-bundle-install.mjs — install Pi Scope's bundled `pi` coding agent into the
 * user's data directory (`~/.pi-scope/pi`).
 *
 * The agent is an npm package (`@earendil-works/pi-coding-agent`) inside a small
 * npm project. Pi Scope installs that project per user instead of inside the app
 * or the checkout, so Settings → Update can replace the agent in place, the tree
 * survives a re-install of the app, and a checkout never carries a 150 MB
 * `node_modules`.
 *
 * Every entry point uses this one script, which is why the Windows path is the
 * same code path as Linux/macOS:
 *
 *   • `pi-scope.mjs` / `run.sh`   — first run of a dev checkout
 *   • `install/install.sh` / `.ps1` — the one-line installers
 *   • `scope-control.js`          — the packaged app seeds itself from the
 *                                   read-only `resources/pi` it ships
 *
 * Plain Node, no repo imports and no dependencies: it runs under the server's
 * Node, under the portable Node inside a package, and under whatever Node the
 * installers found.
 *
 *   node pi-bundle-install.mjs [options]
 *
 *     --from <dir>    template/seed project  [default: <script dir>/pi-bundle]
 *     --target <dir>  where to install       [default: ~/.pi-scope/pi]
 *     --pm <name>     npm | pnpm | bun        [default: npm]
 *     --npm <bin>     package manager binary [default: SCOPE_NPM_BIN, else --pm]
 *     --move          migrate node_modules out of --from instead of copying it
 *     -h, --help      this text
 *
 * Exit code 0 means the agent is installed (or already was); 1 means it is not,
 * with the reason on stderr. A missing bundle is never fatal to the app: Chat
 * falls back to a `pi` on PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = "@earendil-works/pi-coding-agent";
/** The installed package dir, and the CLI entry the server launches. */
const pkgDirIn = (root) => path.join(root, "node_modules", ...PKG.split("/"));
const cliIn = (root) => path.join(pkgDirIn(root), "dist", "bundle", "cli.js");

const die = (msg) => { console.error(`pi-bundle-install: ${msg}`); process.exit(1); };
const info = (msg) => console.log(`==> ${msg}`);

/** Package-manager argument sets — mirrors install/install.sh & install.ps1. */
const PM_ARGS = {
  npm: [["install", "--no-audit", "--no-fund"]],
  pnpm: [["install", "--no-ignore-scripts"]],
  // Bun blocks dependency build scripts until a package is trusted; trusting may
  // exit 1 when there is nothing left to run, so its result is not a failure.
  bun: [["install"], ["pm", "trust", "--all"]],
};

function usage() {
  process.stdout.write(
    "Install the Pi coding agent bundled with Pi Scope into ~/.pi-scope/pi.\n\n" +
    "  node pi-bundle-install.mjs [--from <dir>] [--target <dir>]\n" +
    "                             [--pm npm|pnpm|bun] [--npm <bin>] [--move]\n",
  );
}

function parseArgs(argv) {
  const opts = { from: path.join(HERE, "pi-bundle"), target: path.join(os.homedir(), ".pi-scope", "pi"), pm: "npm", npm: "", move: false };
  for (let i = 0; i < argv.length; i++) {
    const need = (name) => { if (i + 1 >= argv.length) die(`${name} needs a value`); return argv[++i]; };
    switch (argv[i]) {
      case "--from": opts.from = need("--from"); break;
      case "--target": opts.target = need("--target"); break;
      case "--pm": opts.pm = need("--pm"); break;
      case "--npm": opts.npm = need("--npm"); break;
      case "--move": opts.move = true; break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default: die(`unknown option '${argv[i]}' (try --help)`);
    }
  }
  if (!PM_ARGS[opts.pm]) die(`--pm must be npm, pnpm or bun (got '${opts.pm}')`);
  opts.from = path.resolve(opts.from);
  opts.target = path.resolve(opts.target);
  return opts;
}

/** Installed version of the bundled agent, or null when it is not there. */
function installedVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDirIn(root), "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch { return null; }
}

/**
 * Copy a tree verbatim (`verbatimSymlinks`: an npm tree's `node_modules/.bin`
 * links are relative and must survive the move to the new location untouched).
 */
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true, force: true, errorOnExist: false,
    dereference: false, verbatimSymlinks: true,
  });
}

/**
 * Materialize a tree with hardlinks, falling back to a real copy per file when
 * the target cannot link to the source (a different filesystem — an AppImage's
 * squashfs mount, say — or an FS without hardlinks).
 *
 * This is the packaged app's first launch: it seeds `~/.pi-scope/pi` from the
 * ~155 MB / 15k-file `resources/pi` it ships, and a real copy takes ~15 s — long
 * enough to look like the app failed to start. Linking is ~0.5 s. Sharing inodes
 * with the source is safe here by construction: the source is a read-only
 * package, and `npm install` (Settings → Update) *replaces* files rather than
 * writing into them, so the seed is never mutated through the link. The dev
 * launcher deliberately uses `--move` (a rename) instead, so the only linked
 * source is ever a package's own read-only copy.
 */
function linkTree(from, to) {
  let linked = 0;
  let copied = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) { walk(s, d); continue; }
      try {
        if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
        else { fs.linkSync(s, d); linked += 1; }
      } catch {
        // EXDEV/EACCES/EPERM (or a symlink Windows refuses): take a real copy.
        copyTree(s, d);
        copied += 1;
      }
    }
  };
  walk(from, to);
  return { linked, copied };
}

/** Move `node_modules` out of the source; fall back to copy+delete when a rename
 *  cannot work (different volume, or Windows holding a file open). */
function takeNodeModules(from, to) {
  try {
    fs.renameSync(from, to);
    return "moved";
  } catch {
    copyTree(from, to);
    fs.rmSync(from, { recursive: true, force: true });
    return "copied";
  }
}

/** Quote a program path for the platform's shell (used only for the fallback
 *  path below — the arguments are constants and need no escaping). */
function shellQuote(value) {
  return process.platform === "win32"
    ? `"${value}"`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * npm's CLI as shipped with the Node that runs this script, or null.
 *
 * Running it through `node` is the one form that works everywhere: no PATH
 * lookup, no `.cmd` for CreateProcess to choke on, and the packaged app's
 * portable Node bundles its own npm. Positions checked: a POSIX install
 * (`<prefix>/bin/node` → `<prefix>/lib/node_modules/npm`) and a Windows one
 * (`<dir>\node.exe` → `<dir>\node_modules\npm`).
 */
function npmCliBeside(nodeBin) {
  const dir = path.dirname(nodeBin);
  const candidates = [
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  return null;
}

/**
 * Run the package manager's install in `dir`. Returns true on success.
 *
 * `--npm` / `SCOPE_NPM_BIN` name a program the caller chose (a global npm, or a
 * test stub), so those go through a shell — which is also the only way Windows
 * can start a `.cmd`. Everything else uses npm's own CLI through the running
 * Node (see `npmCliBeside`).
 */
function runInstall(pm, explicitBin, dir) {
  const npmCli = !explicitBin && pm === "npm" ? npmCliBeside(process.execPath) : null;
  for (const args of PM_ARGS[pm]) {
    const res = npmCli
      ? spawnSync(process.execPath, [npmCli, ...args], { cwd: dir, stdio: "inherit" })
      : spawnSync(`${shellQuote(explicitBin || pm)} ${args.join(" ")}`, { cwd: dir, stdio: "inherit", shell: true });
    const who = npmCli ? `node ${npmCli}` : (explicitBin || pm);
    if (res.error) { console.error(`pi-bundle-install: could not run ${who}: ${res.error.message}`); return false; }
    // `bun pm trust` exits 1 when nothing is left to trust — not a failure.
    if (res.status !== 0 && !(pm === "bun" && args[0] === "pm")) return false;
  }
  return true;
}

/** Human label for how the install will run (mirrors runInstall's choice). */
function pmLabel(pm, explicitBin) {
  if (explicitBin) return explicitBin;
  if (pm === "npm" && npmCliBeside(process.execPath)) return "the npm shipped with Node";
  return pm;
}

/**
 * Remove staging dirs an earlier run left behind (a SIGKILL or power loss skips
 * the catch below), so a crash cannot silently accumulate ~150 MB trees in the
 * user's data dir. A concurrent run's dir is left alone: only ones untouched for
 * over an hour are swept.
 */
function sweepStaleStaging(parent, prefix) {
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - 60 * 60_000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const dir = path.join(parent, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* someone else is already gone / removing it */ }
  }
}

const opts = parseArgs(process.argv.slice(2));
const TARGET_PARENT = path.dirname(opts.target);
const STAGING_PREFIX = `.${path.basename(opts.target)}.tmp-`;

// Already installed? Then there is nothing to do — the CLI is the readiness
// marker, so a partially copied tree simply gets seeded again below.
const existing = installedVersion(opts.target);
if (existing) {
  info(`pi bundle: v${existing} already installed in ${opts.target}`);
  process.exit(0);
}

if (!fs.existsSync(path.join(opts.from, "package.json"))) {
  die(`nothing to install from ${opts.from} (no package.json) — the app will fall back to a pi on PATH`);
}

const sourceModules = path.join(opts.from, "node_modules");
const hasModules = fs.existsSync(sourceModules);

// Stage the whole tree next to the target, then swap it in with a rename that is
// destructive only once the replacement is in hand (see step 4): a failure
// part-way through can never leave a half-installed bundle — nor destroy the one
// already there.
const staging = path.join(TARGET_PARENT, `${STAGING_PREFIX}${process.pid}`);
sweepStaleStaging(TARGET_PARENT, STAGING_PREFIX);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

try {
  // 1. The agent itself: migrate the source's node_modules (a checkout that
  //    predates this layout) or seed it (a package's read-only copy — linked,
  //    not copied; see linkTree).
  let modulesHow = "none";
  if (hasModules) {
    const dest = path.join(staging, "node_modules");
    modulesHow = opts.move ? takeNodeModules(sourceModules, dest) : (linkTree(sourceModules, dest), "copied");
  }

  // 2. The npm project's manifest, so a later `npm install` in the target
  //    resolves the same versions.
  for (const name of ["package.json", "package-lock.json"]) {
    const file = path.join(opts.from, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(staging, name));
  }

  // 3. The telemetry extension the shim force-loads. A release seed carries its
  //    own copy; a dev checkout's template does not, so take the repo's source.
  const extension = [
    path.join(opts.from, "pi-scope.ts"),
    path.join(HERE, "..", "..", "extension", "pi-scope.ts"),
  ].find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (extension) fs.copyFileSync(extension, path.join(staging, "pi-scope.ts"));

  // 4. Swap the staged tree in. The existing install is moved aside *first* (a
  //    rename, not a delete) so the new tree is only ever committed once it is
  //    complete: if that final rename fails, the previous install is put back.
  //    Deleting the target first would leave nothing at all when the rename
  //    cannot proceed — on Windows a running `pi` (or an indexer/AV) can hold a
  //    file under it — and the packaged seed has no network to rebuild from.
  fs.mkdirSync(TARGET_PARENT, { recursive: true });
  const aside = path.join(TARGET_PARENT, `${STAGING_PREFIX}old-${process.pid}`);
  let movedAside = false;
  try {
    if (fs.existsSync(opts.target)) { fs.renameSync(opts.target, aside); movedAside = true; }
  } catch { /* locked: the rename below will report it, and the target stays */ }
  try {
    fs.renameSync(staging, opts.target);
  } catch (err) {
    if (movedAside) { try { fs.renameSync(aside, opts.target); } catch { /* restoring failed too — reported below */ } }
    throw err;
  }
  if (movedAside) fs.rmSync(aside, { recursive: true, force: true });
  info(`pi bundle: ${opts.target} seeded (${modulesHow === "moved" ? "migrated" : modulesHow === "copied" ? "linked" : "manifest only"}) from ${opts.from}`);
} catch (err) {
  fs.rmSync(staging, { recursive: true, force: true });
  die(`could not seed ${opts.target}: ${err?.message || err}`);
}

// 5. Dependencies: only needed when the source shipped no node_modules (a fresh
//    download's template). Needs npm and network.
if (!hasModules) {
  const explicit = (opts.npm || process.env.SCOPE_NPM_BIN || "").trim();
  info(`pi bundle: installing the agent with ${pmLabel(opts.pm, explicit)} in ${opts.target} (this can take a minute)…`);
  if (!runInstall(opts.pm, explicit, opts.target)) {
    die(`${pmLabel(opts.pm, explicit)} install failed — the app will fall back to a pi on PATH until this succeeds`);
  }
}

const version = installedVersion(opts.target);
if (!version) die(`the agent's package is missing from ${opts.target} after installing`);
info(`pi bundle: v${version} installed in ${opts.target}`);
