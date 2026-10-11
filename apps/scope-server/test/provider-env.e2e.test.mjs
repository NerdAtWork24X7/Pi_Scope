// End-to-end test for the shell-rc provider-key seeding.
//
// A GUI launch never sources the user's shell rc, so an API key exported only
// there is invisible to the server — and the model store / Settings cost table
// then miss the providers it authenticates. The server now seeds `process.env`
// from the shell rc at boot (provider-env.ts). This drives the REAL server with
// a fake $HOME: one whose .bashrc exports CEREBRAS_API_KEY / GEMINI_API_KEY and
// no such key in the process env (so only the rc can supply it), and one whose
// $HOME has no rc (so the provider must be absent).
//
//   node --test apps/scope-server/test/provider-env.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const PI_BUNDLE = path.join(ROOT, "apps", "scope-desktop", "pi-bundle");
const BUNDLE_ENTRY = path.join(
  PI_BUNDLE, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js",
);
const TOKEN = "provider-env-token";
const bundlePresent = fs.existsSync(BUNDLE_ENTRY);

let tmpDir;
let agentDir;
let homeWithRc;
let homeEmpty;
let rc;    // server whose $HOME exports the provider keys
let noRc;  // server whose $HOME has no rc files

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForHealth(base, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become healthy");
}

/** Boot the real server with `home` as its $HOME. The two provider keys are
 *  stripped from the environment, so only the rc file can supply them. */
async function startServer(home, tag) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    SCOPE_PORT: String(port),
    SCOPE_HOST: "127.0.0.1",
    SCOPE_DB_PATH: path.join(tmpDir, `scope-${tag}.db`),
    SCOPE_AUTH_TOKEN: TOKEN,
    SCOPE_AGENT_DIR: agentDir,
    SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
    SCOPE_TOKEN_FILE: path.join(tmpDir, `scope_token-${tag}`),
    SCOPE_PI_BIN: "/bin/true",
    SCOPE_PI_BUNDLE_DIR: PI_BUNDLE,
    PI_OFFLINE: "1",
    HOME: home,
    USERPROFILE: home,
  };
  // No provider key in the process env: the rc file (or nothing) is the only source.
  delete env.CEREBRAS_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[server:${tag}] ${d}`));
  await waitForHealth(base);
  return { child, base };
}

async function settings(base) {
  const res = await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.ok(res.ok, `GET /settings ${res.status}`);
  return res.json();
}

const providersOf = (meta) => new Set(Object.values(meta || {}).map((m) => m.provider));

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-provider-env-")));
  agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  // Deliberately NO auth.json: the only credential source is the shell rc.
  homeWithRc = path.join(tmpDir, "home-rc");
  homeEmpty = path.join(tmpDir, "home-empty");
  fs.mkdirSync(homeWithRc, { recursive: true });
  fs.mkdirSync(homeEmpty, { recursive: true });
  // Mirror the reported setup: the keys live in a file the rc *sources*, not in
  // the rc itself (~/.free-coding-models.env sourced by ~/.zshrc).
  fs.writeFileSync(path.join(homeWithRc, "provider-env.sh"), [
    "# provider keys a GUI launch would otherwise miss",
    'export CEREBRAS_API_KEY="sk-cerebras-from-rc"',
    "export GEMINI_API_KEY=sk-gemini-from-rc",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(homeWithRc, ".zshrc"), [
    "# an unrelated source that must be skipped (unexpandable variable)",
    "source $ZSH/oh-my-zsh.sh",
    '[ -f "$HOME/provider-env.sh" ] && . "$HOME/provider-env.sh"',
    "",
  ].join("\n"));

  rc = await startServer(homeWithRc, "rc");
  noRc = await startServer(homeEmpty, "norc");
});

after(async () => {
  for (const s of [rc, noRc]) {
    if (s?.child) {
      s.child.kill("SIGKILL");
      await new Promise((r) => s.child.once("exit", r));
    }
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("shell-rc provider keys", () => {
  test("a provider key exported only in the rc reaches the cost catalogue", { skip: !bundlePresent && "pi bundle not installed" }, async () => {
    const data = await settings(rc.base);
    const providers = providersOf(data.modelsMeta);
    assert.ok(providers.has("cerebras"), "cerebras is available via the rc-exported CEREBRAS_API_KEY");
    assert.ok(providers.has("google"), "google is available via the rc-exported GEMINI_API_KEY");
  });

  test("without the rc key the provider is absent (proves the source)", { skip: !bundlePresent && "pi bundle not installed" }, async () => {
    const data = await settings(noRc.base);
    const providers = providersOf(data.modelsMeta);
    assert.equal(providers.has("cerebras"), false, "no rc and no env key → cerebras is not listed");
    assert.equal(providers.has("google"), false, "no rc and no env key → google is not listed");
  });
});
