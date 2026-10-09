// End-to-end tests for Settings → Auth: the GUI mirror of pi's /login.
//
// The server runs for real and loads the *bundled* pi coding agent's auth
// runtime (SCOPE_PI_BUNDLE_DIR points at the repo's pi-bundle). An API-key
// login for DeepSeek exercises the whole path — provider catalogue, the
// `secret` prompt, answering it, the credential landing in auth.json, the
// provider flipping to "configured", and logout — without any network call.
//
//   node --test apps/scope-server/test/pi-auth.e2e.test.mjs

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
const TOKEN = "pi-auth-token";
const SECRET = "sk-gui-secret-123";

let child;
let base;
let tmpDir;
let agentDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

const post = (pathname, body) => api(pathname, { method: "POST", body: JSON.stringify(body) });
const loginGet = (id) => api(`/auth/login?id=${encodeURIComponent(id)}`);

/** Poll a login session until `predicate(state)` or the timeout. */
async function waitForLogin(id, predicate, timeoutMs = 20_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const { res, data } = await loginGet(id);
    if (res.ok && data) {
      last = data;
      if (predicate(data)) return data;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`login did not settle; last=${JSON.stringify(last)}`);
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pi-auth-")));
  agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      SCOPE_TOKEN_FILE: path.join(tmpDir, "scope_token"),
      // No real pi launched, but the auth module still finds the bundle.
      SCOPE_PI_BIN: "/bin/true",
      SCOPE_PI_BUNDLE_DIR: PI_BUNDLE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pi auth (GUI /login)", () => {
  test("the provider catalogue lists login methods and no credentials yet", async () => {
    const { res, data } = await api("/auth/providers");
    assert.ok(res.ok, data?.error);
    assert.equal(data.ready, true);
    assert.ok(data.providers.length > 20, "many providers");

    const ds = data.providers.find((p) => p.id === "deepseek");
    assert.ok(ds, "deepseek listed");
    assert.equal(ds.configured, false);
    assert.deepEqual(ds.methods.map((m) => m.type), ["api_key"]);
    assert.equal(ds.methods[0].canLogin, true);

    // A provider offering both methods shows both.
    const anthropic = data.providers.find((p) => p.id === "anthropic");
    assert.ok(anthropic, "anthropic listed");
    assert.deepEqual(anthropic.methods.map((m) => m.type).sort(), ["api_key", "oauth"]);

    assert.deepEqual(data.credentials, []);
  });

  test("cancelling a login aborts it and stores nothing", async () => {
    const started = await post("/auth/login", { providerId: "deepseek", type: "api_key" });
    assert.ok(started.res.ok, started.data?.error);
    const id = started.data.id;
    await waitForLogin(id, (s) => !!s.prompt, 10_000);

    const cancelled = await post("/auth/login", { id, cancel: true });
    assert.ok(cancelled.res.ok);
    const final = await waitForLogin(id, (s) => s.status !== "running", 10_000);
    assert.equal(final.status, "cancelled");

    const snap = await api("/auth/providers");
    assert.deepEqual(snap.data.credentials, [], "nothing stored after cancel");
    assert.equal(snap.data.providers.find((p) => p.id === "deepseek").configured, false);
  });

  test("an API-key login prompts, stores the credential and reports it configured", async () => {
    const started = await post("/auth/login", { providerId: "deepseek", type: "api_key" });
    assert.ok(started.res.ok, started.data?.error);
    assert.equal(started.data.status, "running");
    const id = started.data.id;

    // pi asks for the key through a `secret` prompt.
    const prompted = await waitForLogin(id, (s) => !!s.prompt, 10_000);
    assert.equal(prompted.prompt.type, "secret");
    assert.match(prompted.prompt.message, /DeepSeek API key/i);

    const answered = await post("/auth/login", { id, promptId: prompted.prompt.id, value: SECRET });
    assert.ok(answered.res.ok, answered.data?.error);

    const done = await waitForLogin(id, (s) => s.status !== "running", 20_000);
    assert.equal(done.status, "ok", done.error);
    assert.equal(done.prompt, null);

    // The credential landed in the agent dir's auth.json.
    const authJson = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(authJson.deepseek?.key, SECRET);

    // The catalogue now reports it configured and lists the credential — and
    // never leaks the secret back to the client.
    const snap = await api("/auth/providers");
    const ds = snap.data.providers.find((p) => p.id === "deepseek");
    assert.equal(ds.configured, true);
    assert.equal(ds.usingOAuth, false);
    assert.ok(ds.statusLabel, "a status label is reported");
    assert.deepEqual(snap.data.credentials.map((c) => c.providerId), ["deepseek"]);
    assert.ok(!JSON.stringify(snap.data).includes(SECRET), "secret never travels to the browser");

    // Answering a stale prompt is refused rather than silently accepted.
    const stale = await post("/auth/login", { id, promptId: prompted.prompt.id, value: "x" });
    assert.equal(stale.res.status, 409);
  });

  test("signing out removes the stored credential", async () => {
    const out = await post("/auth/logout", { providerId: "deepseek" });
    assert.ok(out.res.ok, out.data?.error);
    assert.deepEqual(out.data.credentials, []);
    const authJson = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal("deepseek" in authJson, false);
  });

  test("unknown providers and sessions are refused", async () => {
    assert.equal((await post("/auth/login", { providerId: "nope", type: "api_key" })).res.status, 400);
    assert.equal((await post("/auth/login", { providerId: "deepseek", type: "carrier-pigeon" })).res.status, 400);
    assert.equal((await loginGet("does-not-exist")).res.status, 404);
  });
});
