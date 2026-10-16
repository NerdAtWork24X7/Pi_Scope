// End-to-end tests for the runtime "available models" merge into Settings.
//
// pi's `/modelcost` selector lists `modelRegistry.getAvailable()` — every
// provider with configured auth, including pi-ai's built-in static catalogues
// (cerebras, google, groq, mistral, zai, …). Those static providers declare no
// `refreshModels`, so `ModelRuntime.refresh()` never persists them to
// models-store.json, which is why Settings → Models → Model cost used to list
// fewer providers than the selector. The server now reads the bundled runtime
// (the same one the Authentication tab loads) and merges it in.
//
// These tests run the REAL server against the repo's pi bundle and a temp agent
// dir whose only credential is an API key for `cerebras` (a built-in provider
// that can never appear in models-store.json). One server has the enrichment on
// (the default), one off (`SCOPE_MODEL_CATALOG=off`), so the gate is proven too.
//
//   node --test apps/scope-server/test/runtime-models.e2e.test.mjs

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { PI_BUNDLE_ROOT, PI_BUNDLE_ENTRY } from "./bundle-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const PI_BUNDLE = PI_BUNDLE_ROOT;
const BUNDLE_ENTRY = PI_BUNDLE_ENTRY;
const TOKEN = "runtime-models-token";

const bundlePresent = fs.existsSync(BUNDLE_ENTRY);

let tmpDir;
let agentDir;
let on;  // enrichment on (default)
let off; // enrichment off (SCOPE_MODEL_CATALOG=off)

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

/** Boot the real server for a shared agent dir; `catalog` is the
 *  SCOPE_MODEL_CATALOG value (unset = the default, enrichment on). */
async function startServer(catalog) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    SCOPE_PORT: String(port),
    SCOPE_HOST: "127.0.0.1",
    SCOPE_DB_PATH: path.join(tmpDir, `scope-${catalog === "off" ? "off" : "on"}.db`),
    SCOPE_AUTH_TOKEN: TOKEN,
    SCOPE_AGENT_DIR: agentDir,
    SCOPE_AUTH_JSON: path.join(agentDir, "auth.json"),
    SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
    SCOPE_TOKEN_FILE: path.join(tmpDir, `scope_token-${catalog === "off" ? "off" : "on"}`),
    SCOPE_PI_BIN: "/bin/true",
    SCOPE_PI_BUNDLE_DIR: PI_BUNDLE,
    // Keep pi's own startup checks out of the way.
    PI_OFFLINE: "1",
  };
  if (catalog === "off") env.SCOPE_MODEL_CATALOG = "off";
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(base);
  return { child, base };
}

async function settings(base) {
  const res = await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.ok(res.ok, `GET /settings ${res.status}`);
  return res.json();
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-runtime-models-")));
  agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  // A built-in provider signed in with an API key: it has models in pi-ai's
  // static catalogue but never a line in models-store.json.
  fs.writeFileSync(path.join(agentDir, "auth.json"),
    JSON.stringify({ cerebras: { type: "api_key", key: "sk-cerebras-test" } }));
  // A store provider, to prove the merge keeps what the store already had.
  fs.writeFileSync(path.join(agentDir, "models-store.json"),
    JSON.stringify({ storeonly: { models: [{ id: "so-1", contextWindow: 4096, cost: { input: 1, output: 2 } }] } }));

  on = await startServer("on");
  off = await startServer("off");
});

after(async () => {
  for (const s of [on, off]) {
    if (s?.child) {
      s.child.kill("SIGKILL");
      await new Promise((r) => s.child.once("exit", r));
    }
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("settings → models → runtime providers", () => {
  test("the cost catalogue lists providers the store never names", { skip: !bundlePresent && "pi bundle not installed" }, async () => {
    const data = await settings(on.base);
    const meta = data.modelsMeta || {};

    // The store provider survives the merge.
    assert.equal(meta["storeonly/so-1"]?.provider, "storeonly", "the store's own provider is still listed");

    // A built-in provider reachable only through the runtime is now listed, with
    // usable pricing for the cost table.
    const cerebras = Object.keys(meta).filter((k) => k.startsWith("cerebras/"));
    assert.ok(cerebras.length > 0, "cerebras is listed (its credential lives in auth.json, not the store)");
    const sample = meta[cerebras[0]];
    assert.equal(sample.provider, "cerebras");
    assert.equal(typeof sample.cost?.input, "number", "the runtime model carries input pricing");
    assert.equal(typeof sample.cost?.output, "number", "the runtime model carries output pricing");
    assert.ok(sample.contextWindow > 0, "the runtime model carries a context window");
  });

  test("SCOPE_MODEL_CATALOG=off skips the runtime read", { skip: !bundlePresent && "pi bundle not installed" }, async () => {
    const data = await settings(off.base);
    const meta = data.modelsMeta || {};
    assert.equal(meta["storeonly/so-1"]?.provider, "storeonly", "the store still feeds the catalogue");
    assert.equal(
      Object.keys(meta).some((k) => k.startsWith("cerebras/")), false,
      "no runtime providers when the enrichment is disabled",
    );
  });
});
