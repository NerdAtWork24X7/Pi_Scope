// End-to-end tests for the Settings surface backed by the agent dir: pi
// packages, per-extension enablement, project trust, global instruction files,
// provider sign-in status, subagent definitions and stored API keys.
//
// The server is run for real against a temporary SCOPE_AGENT_DIR seeded with
// representative config, so the discovery + writer paths are exercised exactly
// as the Settings page drives them. SCOPE_PI_BIN points at /bin/true so no real
// pi bundle is resolved or launched.
//
//   node --test apps/scope-server/test/settings-agent-dir.e2e.test.mjs

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
const TOKEN = "settings-agent-dir-token";

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

const postSettings = (action, value) =>
  api("/settings", { method: "POST", body: JSON.stringify({ action, value, cwd: tmpDir }) });

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-settings-agent-")));
  agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(path.join(agentDir, "extensions", "web_fetch"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "skills", "foo"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "themes"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "plugins"), { recursive: true });

  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:@scope/a", { source: "npm:@scope/b", extensions: ["-index.ts"] }],
    extensions: ["+extensions/pi-scope.ts", "+extensions/web_fetch/index.ts"],
    skills: ["-skills/foo/SKILL.md"],
    theme: "cyberpunk",
    defaultModel: "p/m",
  }, null, 2));
  fs.writeFileSync(path.join(agentDir, "extensions", "extensions.json"), JSON.stringify({
    _doc: ["meta"],
    web_fetch: { orchestrator: true, subagent: false },
  }, null, 2));
  fs.writeFileSync(path.join(agentDir, "extensions", "pi-scope.ts"), "");
  fs.writeFileSync(path.join(agentDir, "extensions", "web_fetch", "index.ts"), "");
  fs.writeFileSync(path.join(agentDir, "trust.json"), JSON.stringify({ "/trusted/one": true, "/trusted/off": false }));
  fs.writeFileSync(path.join(agentDir, "themes", "cyberpunk.json"), JSON.stringify({ name: "cyberpunk", colors: {} }));
  fs.writeFileSync(path.join(agentDir, "agents", "coder.md"),
    "---\nname: coder\ndescription: Writes code.\nmodel: opencode-go/deepseek-v4.1-flash\ntools: bash, read\n---\n\nYou are a coder.\n");
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    openrouter: { type: "api_key", key: "SECRET-VALUE" },
    kilo: { type: "oauth", access: "SECRET-VALUE" },
  }));
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "Be careful.\n");
  fs.writeFileSync(path.join(agentDir, "skills", "foo", "SKILL.md"), "---\nname: Foo\n---\nbody\n");

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
      SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
      // Isolate the agent dir so the test never reads or writes the real one.
      SCOPE_AGENT_DIR: agentDir,
      SCOPE_PI_BIN: "/bin/true",
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

describe("agent-dir settings", () => {
  test("the snapshot exposes packages, extension flags, trust, themes, providers and agent defs", async () => {
    const { res, data } = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
    assert.ok(res.ok);

    assert.deepEqual(data.packages.map((p) => p.source), ["npm:@scope/a", "npm:@scope/b"]);
    assert.deepEqual(data.extensionFlags.web_fetch, { orchestrator: true, subagent: false });

    // Built-in themes plus the discovered custom one.
    for (const t of ["system", "dark", "light", "cyberpunk"]) assert.ok(data.themes.includes(t), `missing theme ${t}`);

    // Only truthy trust entries are listed.
    assert.deepEqual(data.trustedProjects, ["/trusted/one"]);

    // Provider names + credential type only — never the secret material.
    assert.deepEqual(data.providers, [
      { name: "kilo", type: "oauth" },
      { name: "openrouter", type: "api_key" },
    ]);
    assert.ok(!JSON.stringify(data.providers).includes("SECRET"));

    assert.equal(data.agentDefs.length, 1);
    assert.equal(data.agentDefs[0].name, "coder");
    assert.equal(data.agentDefs[0].model, "opencode-go/deepseek-v4.1-flash");
    // The whole file text travels with the snapshot so the Settings editor can
    // open agents/<file>.md without a second round trip.
    assert.match(data.agentDefs[0].content, /^---\nname: coder\n/);
    assert.ok(data.agentDefs[0].content.includes("You are a coder."));

    const agents = data.instructions.find((i) => i.file === "AGENTS.md");
    assert.equal(agents.exists, true);
    assert.equal(agents.content, "Be careful.\n");

    // The skills list carries the settings.json load state independently of the
    // orchestrator/subagent membership.
    assert.equal(data.skills[0].settingsEnabled, false);
  });

  test("packages can be added and removed", async () => {
    await postSettings("addPiPackage", "npm:@scope/c");
    await postSettings("removePiPackage", "npm:@scope/a");
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.packages.map((p) => (typeof p === "string" ? p : p.source)), ["npm:@scope/b", "npm:@scope/c"]);
  });

  test("an extension flag write preserves the file's other keys", async () => {
    const { res } = await postSettings("setExtensionFlag", { name: "web_fetch", flag: "subagent", enabled: true });
    assert.ok(res.ok);
    const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, "extensions", "extensions.json"), "utf8"));
    assert.deepEqual(cfg._doc, ["meta"]);
    assert.deepEqual(cfg.web_fetch, { orchestrator: true, subagent: true });
  });

  test("trust can be revoked", async () => {
    await postSettings("revokeTrust", "/trusted/one");
    const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, "trust.json"), "utf8"));
    assert.equal("/trusted/one" in cfg, false);
  });

  test("instruction files are written and arbitrary paths are refused", async () => {
    const ok = await postSettings("setInstructionFile", { file: "SYSTEM.md", content: "You are scope.\n" });
    assert.ok(ok.res.ok);
    assert.equal(fs.readFileSync(path.join(agentDir, "SYSTEM.md"), "utf8"), "You are scope.\n");

    // Removing all content deletes the file.
    const clear = await postSettings("setInstructionFile", { file: "SYSTEM.md", content: "" });
    assert.ok(clear.res.ok);
    assert.equal(fs.existsSync(path.join(agentDir, "SYSTEM.md")), false);

    const bad = await postSettings("setInstructionFile", { file: "../../evil", content: "x" });
    assert.equal(bad.res.status, 400);
  });

  test("a subagent's model is editable without touching its prompt body", async () => {
    const { res } = await postSettings("setAgentDefField", { file: "coder.md", field: "model", value: "kilo/x" });
    assert.ok(res.ok);
    const raw = fs.readFileSync(path.join(agentDir, "agents", "coder.md"), "utf8");
    assert.match(raw, /^---\nname: coder\n/);
    assert.match(raw, /model: kilo\/x/);
    assert.ok(raw.endsWith("You are a coder.\n"), "body preserved");

    const bad = await postSettings("setAgentDefField", { file: "../x.md", field: "model", value: "y" });
    assert.equal(bad.res.status, 400);
  });

  test("the whole subagent markdown is saved, with path/size guards", async () => {
    const next = "---\nname: coder\ndescription: Edited.\n---\n\nNew body.\n";
    const ok = await postSettings("saveAgentDefFile", { file: "coder.md", content: next });
    assert.ok(ok.res.ok);
    assert.equal(fs.readFileSync(path.join(agentDir, "agents", "coder.md"), "utf8"), next);

    // A traversal-ish name is refused, and an unknown file is a 404.
    assert.equal((await postSettings("saveAgentDefFile", { file: "../evil.md", content: "x" })).res.status, 400);
    assert.equal((await postSettings("saveAgentDefFile", { file: "nope.md", content: "x" })).res.status, 404);
  });

  test("the settings.json skill load toggle flips", async () => {
    const { res } = await api("/agent-team", {
      method: "POST",
      body: JSON.stringify({ action: "toggleSkillSetting", dir: "foo", cwd: tmpDir }),
    });
    assert.ok(res.ok);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.skills, ["+skills/foo/SKILL.md"]);
  });

  test("default API keys are not seeded — only keys with a value are listed", async () => {
    let snap = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
    // The core guarantee: no row is a bare, valueless default. A key appears
    // only when Settings, the environment, the shell profile or an extension
    // config actually provides a value.
    assert.ok(snap.data.apiKeys.every((k) => !!k.source), "no key is listed without a source");
    for (const name of ["KILO_API_KEY", "OMNI_ROUTER_API_KEY"]) {
      if (!process.env[name]) {
        assert.ok(!snap.data.apiKeys.some((k) => k.name === name), `${name} not seeded when unset`);
      }
    }
    // The names stay discoverable for the Add field even though the rows are gone.
    assert.deepEqual([...snap.data.knownApiKeys].sort(), ["GROQ_API_KEY", "KILO_API_KEY", "OMNI_ROUTER_API_KEY"]);

    // A stored custom key appears; the secret never leaves the server.
    await postSettings("setApiKey", { name: "MY_CUSTOM_KEY", value: "secret-value" });
    snap = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
    const custom = snap.data.apiKeys.find((k) => k.name === "MY_CUSTOM_KEY");
    assert.equal(custom.source, "settings");
    assert.equal(custom.known, false);
    assert.ok(!JSON.stringify(snap.data.apiKeys).includes("secret-value"), "only a masked preview travels");

    // A known key appears once it has a value, keeping its label.
    await postSettings("setApiKey", { name: "KILO_API_KEY", value: "kilo-secret" });
    snap = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
    const kilo = snap.data.apiKeys.find((k) => k.name === "KILO_API_KEY");
    assert.equal(kilo.label, "Kilo");
    assert.equal(kilo.known, true);
    assert.equal(kilo.source, "settings");
  });

  test("editing a member's model is scoped to one team only", async () => {
    // Two teams that both contain a member named `coder` — the exact case where
    // a team-agnostic write used to bleed one team's edit into the other.
    const teamsPath = path.join(tmpDir, ".pi", "settings", "agents", "teams.yaml");
    fs.mkdirSync(path.dirname(teamsPath), { recursive: true });
    fs.writeFileSync(teamsPath, [
      "alpha:",
      "  - name: coder",
      "    model: p/one",
      "  - name: reader",
      "beta:",
      "  - name: coder",
      "    model: p/two",
      "",
    ].join("\n"));

    const ok = await api("/agent-team", {
      method: "POST",
      body: JSON.stringify({ action: "setMemberModel", agent: "coder", team: "alpha", model: "p/three", cwd: tmpDir }),
    });
    assert.ok(ok.res.ok);

    const snap = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
    const model = (team) => (snap.data.teams[team] || []).find((m) => m.name === "coder")?.model;
    assert.equal(model("alpha"), "p/three", "named team updated");
    assert.equal(model("beta"), "p/two", "same-named member in the other team untouched");

    // The team is required, and it must exist.
    assert.equal((await api("/agent-team", {
      method: "POST",
      body: JSON.stringify({ action: "setMemberModel", agent: "coder", model: "p/x", cwd: tmpDir }),
    })).res.status, 400);
    assert.equal((await api("/agent-team", {
      method: "POST",
      body: JSON.stringify({ action: "setMemberModel", agent: "coder", team: "nope", model: "p/x", cwd: tmpDir }),
    })).res.status, 400);
  });
});
