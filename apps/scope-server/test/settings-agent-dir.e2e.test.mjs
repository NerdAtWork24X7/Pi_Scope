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
    // A definition with no `skills:` key gets no skills: the file is the only
    // source, so there is no "inherit" state left to report (and no flag for it).
    assert.deepEqual(data.agentDefs[0].skills, []);
    assert.equal("skillsAll" in data.agentDefs[0], false, "the retired inherit flag is gone");
    // `tools:` is the other per-subagent allowlist the agent-team extension
    // reads at spawn. Absent again means "inherit" — here the built-in default
    // tool list, which the snapshot spells out so the UI can show it.
    assert.deepEqual(data.agentDefs[0].tools, ["bash", "read"], "the frontmatter tools list is parsed");
    assert.equal(data.agentDefs[0].toolsAll, false, "the key is present");
    assert.deepEqual(data.agentDefaultTools, ["read", "grep", "find", "ls"], "the inherited default tool list rides along");

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

  test("taking a subagent off duty is scoped to one team only", async () => {
    // The same member sits on two teams: each keeps its own duty, and only the
    // RUNNING team's off-list (`disabledAgents`) speaks for it.
    const teamsPath = path.join(tmpDir, ".pi", "settings", "agents", "teams.yaml");
    fs.mkdirSync(path.dirname(teamsPath), { recursive: true });
    fs.writeFileSync(teamsPath, ["alpha:", "  - name: coder", "beta:", "  - name: coder", ""].join("\n"));

    const post = (body) => api("/agent-team", { method: "POST", body: JSON.stringify({ ...body, cwd: tmpDir }) });
    const row = async (team) => {
      const { data } = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
      return (data.teams[team] || []).find((m) => m.name === "coder");
    };
    const offList = async () => (await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`)).data.disabledAgents || [];

    // `alpha` is the team that runs.
    assert.ok((await post({ action: "setTeam", team: "alpha" })).res.ok);

    // Off duty on the inactive team: only that row flips.
    assert.ok((await post({ action: "toggleAgent", agent: "coder", team: "beta", disabled: true })).res.ok);
    assert.equal((await row("beta")).active, false, "beta's row goes off duty");
    assert.equal((await row("alpha")).active, undefined, "alpha's row keeps its own duty");
    assert.ok(!(await offList()).includes("coder"), "the running team's off-list is untouched");

    // Off duty on the ACTIVE team: the row flips and the session's off-list names it.
    assert.ok((await post({ action: "toggleAgent", agent: "coder", team: "alpha", disabled: true })).res.ok);
    assert.equal((await row("alpha")).active, false, "alpha's row goes off duty");
    assert.ok((await offList()).includes("coder"), "the active team's off-list names the member");

    // Back on duty in beta: alpha's row and the off-list stay off.
    assert.ok((await post({ action: "toggleAgent", agent: "coder", team: "beta", disabled: false })).res.ok);
    assert.notEqual((await row("beta")).active, false, "beta is back on duty");
    assert.equal((await row("alpha")).active, false, "alpha's row is untouched");
    assert.ok((await offList()).includes("coder"), "and the active team's off-list is untouched");

    // Switching the running team must not carry duty across: a member left off
    // duty on the team we leave cannot silence the same-named member of the
    // team we switch to, which was never touched.
    assert.ok((await post({ action: "setTeam", team: "beta" })).res.ok);
    assert.notEqual((await row("beta")).active, false, "beta's coder is still on duty");
    assert.ok(!(await offList()).includes("coder"), "the running team's off-list follows its own rows");
    // …and coming back restores the team we left from its own roster row.
    assert.ok((await post({ action: "setTeam", team: "alpha" })).res.ok);
    assert.equal((await row("alpha")).active, false, "alpha's coder is still off duty");
    assert.ok((await offList()).includes("coder"), "alpha's off-list names it again");

    // An unknown team is refused rather than silently fanning out to everyone.
    assert.equal((await post({ action: "toggleAgent", agent: "coder", team: "nope", disabled: true })).res.status, 400);
  });

  // The Office view edits the roster from a desk's **settings** popup: **name**
  // (a display name), **fire** (drop the member) and **hire** (add one, with a
  // model and a fresh agents/<name>.md). These are the writes behind them.
  test("the office's roster edits (name / fire / hire) write through to teams.yaml", async () => {
    const teamsPath = path.join(tmpDir, ".pi", "settings", "agents", "teams.yaml");
    fs.mkdirSync(path.dirname(teamsPath), { recursive: true });
    fs.writeFileSync(teamsPath, [
      "night:",
      "  - name: orchestrator",
      "  - name: file_reader",
      "    model: p/one",
      "other:",
      "  - name: file_reader",
      "",
    ].join("\n"));

    const post = (body) => api("/agent-team", { method: "POST", body: JSON.stringify({ ...body, cwd: tmpDir }) });
    const members = async (team) => {
      const { data } = await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`);
      return data.teams[team] || [];
    };

    // A display name is stored per team, beside the model, and read back.
    assert.ok((await post({ action: "setMemberDisplayName", team: "night", agent: "file_reader", displayName: "Bob" })).res.ok);
    assert.equal((await members("night")).find((m) => m.name === "file_reader").displayName, "Bob");
    assert.equal(
      (await members("other")).find((m) => m.name === "file_reader").displayName,
      undefined,
      "the same-named member in another team keeps its own label",
    );
    assert.match(fs.readFileSync(teamsPath, "utf8"), /display_name: Bob/);
    // One line, at most 64 characters.
    assert.equal((await post({ action: "setMemberDisplayName", team: "night", agent: "file_reader", displayName: "x".repeat(65) })).res.status, 400);

    // Fire: the member leaves the named team only.
    assert.ok((await post({ action: "removeMember", team: "night", name: "file_reader" })).res.ok);
    assert.equal((await members("night")).some((m) => m.name === "file_reader"), false, "fired from night");
    assert.equal((await members("other")).some((m) => m.name === "file_reader"), true, "still a member of other");

    // Hire: back on the roster with a model, plus a fresh agents/<name>.md.
    assert.ok((await post({ action: "addMember", team: "night", name: "builder", model: "p/two" })).res.ok);
    assert.equal((await members("night")).find((m) => m.name === "builder").model, "p/two");

    const md = "---\nname: builder\ndescription: Bob\n---\n\nBuild the thing.\n";
    assert.ok((await postSettings("createAgentDefFile", { file: "builder.md", content: md })).res.ok);
    assert.equal(fs.readFileSync(path.join(agentDir, "agents", "builder.md"), "utf8"), md);
    // Hiring over an existing definition is refused — that file is edited, not clobbered.
    assert.equal((await postSettings("createAgentDefFile", { file: "coder.md", content: md })).res.status, 409);
  });
});

// Each subagent definition carries its OWN skills and tools (agents/<file>.md
// `skills:` / `tools:`) — the single source of truth for that subagent, distinct
// from the ORCHESTRATOR's set in agent-team-config.json. `skills:` is the whole
// story: no key and an empty key both mean "no skills". `tools:` keeps an absent
// state that means something, because the agent-team extension then falls back
// to its built-in default tool list.
describe("per-subagent skills", () => {
  const alphaPath = () => path.join(agentDir, "agents", "alpha.md");
  const readAlpha = () => fs.readFileSync(alphaPath(), "utf8");
  const snapshot = async () => (await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`)).data;
  const defByFile = (data, file) => data.agentDefs.find((d) => d.file === file);

  test("the snapshot reports each definition's own allowlist", async () => {
    fs.writeFileSync(alphaPath(), "---\nname: alpha\ntools: read\nskills: flet, graphify\n---\n\nAlpha prompt.\n");
    const data = await snapshot();
    const alpha = defByFile(data, "alpha.md");
    assert.deepEqual(alpha.skills, ["flet", "graphify"], "the comma-separated frontmatter list is parsed");

    const coder = defByFile(data, "coder.md");
    assert.deepEqual(coder.skills, [], "no skills: key means no skills");
    fs.rmSync(alphaPath());
  });

  test("a definition's skills are pinned, replaced, emptied and dropped in place", async () => {
    fs.writeFileSync(alphaPath(), "---\nname: alpha\ntools: read\n---\n\nAlpha prompt.\n");

    // Pin two skills: they arrive as one comma-separated line, and nothing else
    // in the file moves.
    assert.ok((await postSettings("setAgentDefSkills", { file: "alpha.md", skills: ["flet", "graphify"] })).res.ok);
    assert.equal(readAlpha(), "---\nname: alpha\ntools: read\nskills: flet, graphify\n---\n\nAlpha prompt.\n");

    // Replace, de-duplicating: still exactly one skills: line.
    assert.ok((await postSettings("setAgentDefSkills", { file: "alpha.md", skills: ["graphify", "graphify", "flet"] })).res.ok);
    assert.match(readAlpha(), /^skills: graphify, flet$/m);
    assert.equal((readAlpha().match(/^skills:/gm) || []).length, 1);

    // An empty list is an EMPTY key (pi: no skills).
    assert.ok((await postSettings("setAgentDefSkills", { file: "alpha.md", skills: [] })).res.ok);
    assert.match(readAlpha(), /^skills:$/m);
    assert.deepEqual(defByFile(await snapshot(), "alpha.md").skills, []);

    // null removes the key — the same outcome, since a definition has no skills
    // without its own list either way.
    assert.ok((await postSettings("setAgentDefSkills", { file: "alpha.md", skills: null })).res.ok);
    assert.equal(/^skills:/m.test(readAlpha()), false, "the key is gone");
    assert.deepEqual(defByFile(await snapshot(), "alpha.md").skills, []);
    assert.equal(readAlpha(), "---\nname: alpha\ntools: read\n---\n\nAlpha prompt.\n", "only the skills line ever changed");
    fs.rmSync(alphaPath());
  });

  test("malformed input is refused without touching the file", async () => {
    fs.writeFileSync(alphaPath(), "---\nname: alpha\n---\n\nbody\n");
    const before = readAlpha();
    const bad = [
      { file: "alpha.md", skills: "flet" },                    // not an array
      { file: "alpha.md", skills: ["ok", "bad name"] },        // shape
      { file: "alpha.md", skills: ["ok", "sneaky\nx: 1"] },    // frontmatter injection
      { file: "alpha.md", skills: ["../../etc/passwd"] },      // path-ish
      { file: "alpha.md", skills: Array.from({ length: 101 }, (_, i) => `s${i}`) },
      { file: "../evil.md", skills: ["flet"] },                // traversal in the file name
    ];
    for (const v of bad) {
      assert.equal((await postSettings("setAgentDefSkills", v)).res.status, 400, JSON.stringify(v));
    }
    assert.equal(readAlpha(), before, "a rejected request never writes");
    assert.equal((await postSettings("setAgentDefSkills", { file: "nope.md", skills: [] })).res.status, 404);

    // A well-formed name that is not installed is accepted — pi logs it as an
    // unknown skill, and refusing it would make a hand-written definition
    // impossible to edit from the UI.
    assert.ok((await postSettings("setAgentDefSkills", { file: "alpha.md", skills: ["not-installed"] })).res.ok);
    assert.match(readAlpha(), /^skills: not-installed$/m);
    fs.rmSync(alphaPath());
  });
});

// The other half of a definition's own allowlist: agents/<file>.md `tools:`,
// which the agent-team extension passes to the spawned child as `--tools`. It
// is written like `skills:` — one comma-separated line, everything else left
// byte-for-byte — but there is no "empty key" state to preserve, because an
// absent OR empty key both mean the built-in default tool list. So the UI only
// offers Default (drop the key) or a pinned list.
describe("per-subagent tools", () => {
  const betaPath = () => path.join(agentDir, "agents", "beta.md");
  const readBeta = () => fs.readFileSync(betaPath(), "utf8");
  const snapshot = async () => (await api(`/settings?cwd=${encodeURIComponent(tmpDir)}`)).data;
  const defByFile = (data, file) => data.agentDefs.find((d) => d.file === file);

  test("a definition's tools are pinned, replaced and dropped in place", async () => {
    fs.writeFileSync(betaPath(), "---\nname: beta\nskills: flet\n---\n\nBeta prompt.\n");

    assert.ok((await postSettings("setAgentDefTools", { file: "beta.md", tools: ["bash", "grep"] })).res.ok);
    assert.equal(readBeta(), "---\nname: beta\nskills: flet\ntools: bash, grep\n---\n\nBeta prompt.\n", "only a tools: line is added");
    assert.deepEqual(defByFile(await snapshot(), "beta.md").tools, ["bash", "grep"]);

    // Replace, de-duplicating: still exactly one tools: line.
    assert.ok((await postSettings("setAgentDefTools", { file: "beta.md", tools: ["grep", "grep", "read"] })).res.ok);
    assert.match(readBeta(), /^tools: grep, read$/m);
    assert.equal((readBeta().match(/^tools:/gm) || []).length, 1);

    // null drops the key → the subagent is launched with the default tool list.
    assert.ok((await postSettings("setAgentDefTools", { file: "beta.md", tools: null })).res.ok);
    assert.equal(/^tools:/m.test(readBeta()), false, "the key is gone");
    assert.equal(defByFile(await snapshot(), "beta.md").toolsAll, true);
    assert.equal(readBeta(), "---\nname: beta\nskills: flet\n---\n\nBeta prompt.\n", "only the tools line ever changed");
    fs.rmSync(betaPath());
  });

  test("malformed input is refused without touching the file", async () => {
    fs.writeFileSync(betaPath(), "---\nname: beta\n---\n\nbody\n");
    const before = readBeta();
    const bad = [
      { file: "beta.md", tools: "bash" },                     // not an array
      { file: "beta.md", tools: ["ok", "bad name"] },          // shape
      { file: "beta.md", tools: ["ok", "sneaky\nx: 1"] },     // frontmatter injection
      { file: "beta.md", tools: ["../../etc/passwd"] },       // path-ish
      { file: "beta.md", tools: Array.from({ length: 101 }, (_, i) => `t${i}`) },
      { file: "../evil.md", tools: ["bash"] },                // traversal in the file name
    ];
    for (const v of bad) {
      assert.equal((await postSettings("setAgentDefTools", v)).res.status, 400, JSON.stringify(v));
    }
    assert.equal(readBeta(), before, "a rejected request never writes");
    assert.equal((await postSettings("setAgentDefTools", { file: "nope.md", tools: [] })).res.status, 404);
    fs.rmSync(betaPath());
  });
});
