#!/usr/bin/env node
/**
 * app-deps-install.mjs — install Pi Scope's *own* npm packages into the shared
 * project at `~/.pi-scope/pi`, next to the bundled `pi` agent.
 *
 * Historically a checkout kept a ~0.9 GB `node_modules` of its own (Electron,
 * electron-builder, esbuild, Playwright) and the bundled agent lived in a
 * separate `~/.pi-scope/pi`. That is now one tree: this script seeds/completes
 * the agent with `pi-bundle-install.mjs` (which owns the runtime packages the
 * server loads — see apps/scope-server/pi-deps.ts) and then merges the app's
 * build/dev tooling declared in the repo-root `package.json` into the same
 * manifest, so a single `npm install` in `~/.pi-scope/pi` covers the whole app
 * and the checkout stays free of `node_modules`.
 *
 * Why `devDependencies` for the tooling: `electron`/`esbuild`/`electron-builder`/
 * `playwright`/`ffmpeg-static` are only needed to run and build a *source*
 * checkout. The packaged app runs its own Electron and seeds a runtime-only
 * agent from `resources/pi` (scope-control.js → pi-bundle-install.mjs), so these
 * never travel to an end user.
 *
 * Plain Node, no repo imports and no dependencies: the dev launcher and the
 * release build call it, under whatever Node they already found.
 *
 *   node app-deps-install.mjs [options]
 *
 *     --pm <name>      npm | pnpm | bun         [default: npm]
 *     --npm <bin>      package manager binary   [SCOPE_NPM_BIN, else --pm]
 *     --target <dir>   the shared install       [default: ~/.pi-scope/pi]
 *     --manifest <p>   app manifest to merge     [default: <repo>/package.json]
 *     --no-runtime     skip the bundled-agent seed step
 *     -h, --help       this text
 *
 * Exit 0 means the app packages are installed (or already were); 1 means they
 * are not, with the reason on stderr.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root in a checkout (`apps/scope-desktop` → repo). */
const ROOT = path.resolve(HERE, "..", "..");
const RUNTIME_INSTALLER = path.join(HERE, "pi-bundle-install.mjs");

const die = (msg) => { console.error(`app-deps-install: ${msg}`); process.exit(1); };
const info = (msg) => console.log(`==> ${msg}`);

/** Package-manager argument sets — mirrors pi-bundle-install.mjs. */
const PM_ARGS = {
  npm: [["install", "--no-audit", "--no-fund"]],
  pnpm: [["install", "--no-ignore-scripts"]],
  bun: [["install"], ["pm", "trust", "--all"]],
};

function usage() {
  process.stdout.write(
    "Install Pi Scope's own npm packages into ~/.pi-scope/pi.\n\n" +
    "  node app-deps-install.mjs [--pm npm|pnpm|bun] [--npm <bin>]\n" +
    "                            [--target <dir>] [--manifest <path>] [--no-runtime]\n",
  );
}

function parseArgs(argv) {
  const opts = {
    pm: "npm",
    npm: "",
    target: path.join(os.homedir(), ".pi-scope", "pi"),
    manifest: path.join(ROOT, "package.json"),
    runtime: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const need = (name) => { if (i + 1 >= argv.length) die(`${name} needs a value`); return argv[++i]; };
    switch (argv[i]) {
      case "--pm": opts.pm = need("--pm"); break;
      case "--npm": opts.npm = need("--npm"); break;
      case "--target": opts.target = need("--target"); break;
      case "--manifest": opts.manifest = need("--manifest"); break;
      case "--no-runtime": opts.runtime = false; break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default: die(`unknown option '${argv[i]}' (try --help)`);
    }
  }
  if (!PM_ARGS[opts.pm]) die(`--pm must be npm, pnpm or bun (got '${opts.pm}')`);
  opts.target = path.resolve(opts.target);
  opts.manifest = path.resolve(opts.manifest);
  return opts;
}

/** A JSON file, or null when it cannot be read. */
function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

/** Whether `spec` is installed under `root`'s node_modules. */
function hasPackage(root, spec) {
  try {
    return fs.statSync(path.join(root, "node_modules", ...spec.split("/"), "package.json")).isFile();
  } catch { return false; }
}

/** npm's CLI as shipped with the Node that runs this script, or null. */
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

function shellQuote(value) {
  return process.platform === "win32" ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Run the package manager's install in `dir`. Returns true on success. */
function runInstall(pm, explicitBin, dir) {
  const npmCli = !explicitBin && pm === "npm" ? npmCliBeside(process.execPath) : null;
  for (const args of PM_ARGS[pm]) {
    const res = npmCli
      ? spawnSync(process.execPath, [npmCli, ...args], { cwd: dir, stdio: "inherit" })
      : spawnSync(`${shellQuote(explicitBin || pm)} ${args.join(" ")}`, { cwd: dir, stdio: "inherit", shell: true });
    const who = npmCli ? `node ${npmCli}` : (explicitBin || pm);
    if (res.error) { console.error(`app-deps-install: could not run ${who}: ${res.error.message}`); return false; }
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
 * Merge the app manifest's dependencies into the target's, without disturbing
 * what is already declared. The target wins each key: Settings → Update may have
 * pinned a newer agent than the seed, and the app's own entries must not be
 * downgraded or dropped on a re-launch.
 *
 * Returns the merged package.json object, or null when the target has none.
 */
function mergeManifest(target, manifest) {
  const pkg = readJson(path.join(target, "package.json"));
  if (!pkg) return null;
  const merged = {
    ...pkg,
    dependencies: { ...(manifest.dependencies || {}), ...(pkg.dependencies || {}) },
    devDependencies: { ...(manifest.devDependencies || {}), ...(pkg.devDependencies || {}) },
  };
  const allowScripts = { ...(manifest.allowScripts || {}), ...(pkg.allowScripts || {}) };
  if (Object.keys(allowScripts).length) merged.allowScripts = allowScripts;
  else delete merged.allowScripts;
  // Only rewrite a field that actually changes, so an up-to-date install keeps
  // its mtime (and the "already installed" path stays a true no-op).
  const before = fs.readFileSync(path.join(target, "package.json"), "utf8");
  const after = JSON.stringify(merged, null, 2) + "\n";
  if (after !== before) fs.writeFileSync(path.join(target, "package.json"), after);
  return merged;
}

// ── Run ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));

// 1. The bundled agent, plus the server's runtime packages (node-pty, ws). This
//    is what pi-bundle-install.mjs owns; it is also what the packaged app seeds,
//    so a bundle seeded there is completed here rather than re-fetched.
if (opts.runtime) {
  if (!fs.existsSync(RUNTIME_INSTALLER)) die(`missing ${RUNTIME_INSTALLER}`);
  const args = [RUNTIME_INSTALLER, "--pm", opts.pm, "--target", opts.target, "--move"];
  if (opts.npm) args.push("--npm", opts.npm);
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (res.error) die(`could not run the bundled-agent installer: ${res.error.message}`);
  if (res.status !== 0) {
    info("the bundled Pi agent could not be installed — Chat will fall back to a pi on PATH.");
  }
}

// 2. The app's own packages, declared in the repo-root manifest.
const manifest = readJson(opts.manifest);
if (!manifest) die(`cannot read the app manifest ${opts.manifest}`);
if (!fs.existsSync(path.join(opts.target, "package.json"))) {
  die(`no package.json in ${opts.target} — run pi-bundle-install.mjs first (or drop --no-runtime)`);
}

const merged = mergeManifest(opts.target, manifest);
if (!merged) die(`could not read ${path.join(opts.target, "package.json")}`);

const specs = [
  ...Object.keys(merged.dependencies || {}),
  ...Object.keys(merged.devDependencies || {}),
];
const missing = specs.filter((spec) => !hasPackage(opts.target, spec));

if (missing.length) {
  const explicit = (opts.npm || process.env.SCOPE_NPM_BIN || "").trim();
  info(`installing ${missing.join(", ")} with ${pmLabel(opts.pm, explicit)} in ${opts.target} (this can take a minute)…`);
  if (!runInstall(opts.pm, explicit, opts.target)) {
    die(`${pmLabel(opts.pm, explicit)} install failed in ${opts.target}`);
  }
  const stillMissing = specs.filter((spec) => !hasPackage(opts.target, spec));
  if (stillMissing.length) die(`${stillMissing.join(", ")} still missing from ${opts.target} after installing`);
} else {
  info(`app packages already installed in ${opts.target}`);
}
