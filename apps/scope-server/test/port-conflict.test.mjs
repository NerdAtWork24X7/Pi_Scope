// Tests for the pre-launch port handling in apps/scope-desktop/scope-control.js
// plus the popup page it drives. The launcher checks its port before booting and,
// when something is already there, lets the user open the running instance, kill
// the holder, or run a second, independent instance on another port. These tests
// pin the decisions that logic makes: what is on a port, whose pid it is, how a
// port is freed, and where a second instance keeps its token and DB.
//
// scope-control.js is CommonJS written for Electron; it guards its `electron`
// require so it also loads under plain Node, which is what lets these run here.
//
//   node --test apps/scope-server/test/port-conflict.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import scopeControl from "../../scope-desktop/scope-control.js";

const {
  probePort, listPortHolders, stopPort, findFreePort, instancePaths, prepareInstance, resolvePort,
  discoverScopePorts, portsFromTokenFiles, tokenForPort, tokenDir,
} = scopeControl;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const POPUP = path.join(ROOT, "apps", "scope-server", "public", "port-conflict.html");

/** Start an HTTP server on an ephemeral loopback port, returning { server, port }. */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** A port nothing is listening on: bind then release it. */
function reservedClosedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

describe("probePort — what is on the port", () => {
  test("reports a Pi Scope server as 'scope' with its version", async () => {
    const { server, port } = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, version: "1.0.0", platform: "linux", sessions_total: 3 }));
    });
    try {
      const probe = await probePort("127.0.0.1", port);
      assert.equal(probe.state, "scope");
      assert.equal(probe.version, "1.0.0");
      assert.equal(probe.platform, "linux");
    } finally { await close(server); }
  });

  test("reports a non-Pi-Scope HTTP server as 'other'", async () => {
    const { server, port } = await listen((req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("hello, not scope");
    });
    try {
      assert.equal((await probePort("127.0.0.1", port)).state, "other");
    } finally { await close(server); }
  });

  test("reports a closed port as 'free'", async () => {
    const port = await reservedClosedPort();
    assert.equal((await probePort("127.0.0.1", port)).state, "free");
  });
});

describe("listPortHolders / stopPort — freeing a port", () => {
  test("finds the pid listening on a port", async () => {
    // A child owns the listener so the holder pid is not this test process.
    const child = spawn(process.execPath, ["-e", [
      "const http=require('http');",
      "const s=http.createServer((q,r)=>r.end('ok'));",
      "s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
    ].join("")], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const port = await new Promise((resolve) => {
        child.stdout.once("data", (d) => resolve(Number(d.toString().trim())));
      });
      // Wait for it to accept connections before probing.
      for (let i = 0; i < 50; i++) {
        if ((await probePort("127.0.0.1", port)).state !== "free") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const holders = listPortHolders(port);
      assert.ok(holders.length >= 1, `expected a holder for port ${port}`);
      assert.equal(holders[0].pid, child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("frees a Pi Scope server by asking it to shut down", async () => {
    // A stand-in scope server: answers /health, exits on POST /shutdown. This is
    // how a *different* app instance's server is taken down — gracefully, so it
    // tears its own agents/terminals down first.
    const child = spawn(process.execPath, ["-e", [
      "const http=require('http');",
      "const s=http.createServer((q,r)=>{",
      "  if(q.url==='/health'){r.setHeader('content-type','application/json');return r.end(JSON.stringify({ok:true,version:'9.9.9'}));}",
      "  if(q.url==='/shutdown'&&q.method==='POST'){r.end('{\"ok\":true}');return setTimeout(()=>process.exit(0),50);}",
      "  r.statusCode=404;r.end('no');});",
      "s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
    ].join("")], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const port = await new Promise((resolve) => {
        child.stdout.once("data", (d) => resolve(Number(d.toString().trim())));
      });
      for (let i = 0; i < 50; i++) {
        if ((await probePort("127.0.0.1", port)).state === "scope") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const res = await stopPort(port, { host: "127.0.0.1" });
      assert.equal(res.ok, true);
      assert.equal(res.method, "shutdown");
      assert.equal((await probePort("127.0.0.1", port)).state, "free");
    } finally { child.kill("SIGKILL"); }
  });

  test("a port that is already free is 'free', not an error", async () => {
    const port = await reservedClosedPort();
    const res = await stopPort(port, { host: "127.0.0.1" });
    assert.equal(res.ok, true);
    assert.equal(res.method, "free");
  });
});

describe("findFreePort", () => {
  test("skips a listening port and returns the next free one", async () => {
    const { server, port } = await listen((req, res) => res.end("x"));
    try {
      const found = await findFreePort("127.0.0.1", port, 5);
      assert.notEqual(found, port);
      assert.ok(found > port);
      assert.equal((await probePort("127.0.0.1", found)).state, "free");
    } finally { await close(server); }
  });
});

describe("discoverScopePorts — the active list", () => {
  /** A /health handler that looks like a Pi Scope server. */
  const scopeHealth = (version) => (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, version, platform: "linux" }));
  };

  test("finds a Pi Scope server in the scanned range", async () => {
    const { server, port } = await listen(scopeHealth("1.2.3"));
    try {
      const list = await discoverScopePorts("127.0.0.1", { port, span: 0, tokenDir: null });
      assert.equal(list.length, 1);
      assert.equal(list[0].port, port);
      assert.equal(list[0].version, "1.2.3");
      assert.equal(list[0].holders[0].pid, process.pid);
    } finally { await close(server); }
  });

  test("ignores ports that are not Pi Scope servers", async () => {
    const { server, port } = await listen((req, res) => res.end("not scope"));
    try {
      assert.deepEqual(await discoverScopePorts("127.0.0.1", { port, span: 0, tokenDir: null }), []);
    } finally { await close(server); }
  });

  test("picks up an instance named by a scope_token.<port> file", async () => {
    const { server, port } = await listen(scopeHealth("9.9.9"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scope-tokens-"));
    fs.writeFileSync(path.join(dir, `scope_token.${port}`), "secret\n");
    try {
      // The base port is elsewhere and span 0, so only the token file can find it.
      const list = await discoverScopePorts("127.0.0.1", { port: 1, span: 0, tokenDir: dir });
      assert.deepEqual(list.map((entry) => entry.port), [port]);
      assert.deepEqual(portsFromTokenFiles(dir), [port]);
      // The instance's own token is readable, so it can be shut down gracefully.
      assert.equal(tokenForPort(port, dir), "secret");
      assert.equal(tokenForPort(port + 1, dir), "");
    } finally { await close(server); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("tokenDir() reports the directory the token file lives in", () => {
    const before = process.env.SCOPE_TOKEN_FILE;
    try {
      process.env.SCOPE_TOKEN_FILE = "/tmp/somewhere/scope_token.43191";
      assert.equal(tokenDir(), "/tmp/somewhere");
    } finally {
      if (before === undefined) delete process.env.SCOPE_TOKEN_FILE; else process.env.SCOPE_TOKEN_FILE = before;
    }
  });
});

describe("instancePaths — where a second instance keeps its files", () => {
  test("the base port keeps the historic paths (dev default is null)", () => {
    assert.equal(instancePaths(43190, { basePort: 43190, packaged: false }), null);
    const pkg = instancePaths(43190, { basePort: 43190, packaged: true, dataDir: "/home/u/.pi-scope" });
    assert.equal(pkg.tokenFile, "/home/u/.pi-scope/scope_token");
    assert.equal(pkg.dbPath, "/home/u/.pi-scope/scope.db");
    assert.equal(pkg.isolated, false);
  });

  test("another port gets its own token and DB, so instances never collide", () => {
    const dev = instancePaths(43191, { basePort: 43190, packaged: false });
    assert.equal(dev.tokenFile, path.join(ROOT, "tmp", "scope_token.43191"));
    assert.equal(dev.dbPath, path.join(ROOT, "db", "scope-43191.db"));
    assert.equal(dev.isolated, true);

    const pkg = instancePaths(43191, { basePort: 43190, packaged: true, dataDir: "/home/u/.pi-scope" });
    assert.equal(pkg.tokenFile, "/home/u/.pi-scope/scope_token.43191");
    assert.equal(pkg.dbPath, "/home/u/.pi-scope/scope-43191.db");
    assert.equal(pkg.isolated, true);
  });

  test("prepareInstance points the env at those files without touching the default", () => {
    const before = { db: process.env.SCOPE_DB_PATH, token: process.env.SCOPE_TOKEN_FILE };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scope-instance-"));
    try {
      // The dev base port is a no-op (the server's own defaults already match).
      assert.equal(prepareInstance({ port: 43190, basePort: 43190, packaged: false }), null);

      const paths = prepareInstance({ port: 43191, basePort: 43190, packaged: true, dataDir });
      assert.equal(paths.tokenFile, path.join(dataDir, "scope_token.43191"));
      assert.equal(process.env.SCOPE_TOKEN_FILE, path.join(dataDir, "scope_token.43191"));
      assert.equal(process.env.SCOPE_DB_PATH, path.join(dataDir, "scope-43191.db"));
      assert.ok(fs.existsSync(dataDir));

      // Going back to the base port steps out of the isolated files again, so a
      // base-port run is never left pointing at the other instance's DB.
      assert.equal(prepareInstance({ port: 43190, basePort: 43190, packaged: false }), null);
      assert.equal(process.env.SCOPE_DB_PATH, before.db);
      assert.equal(process.env.SCOPE_TOKEN_FILE, before.token);
    } finally {
      if (before.db === undefined) delete process.env.SCOPE_DB_PATH; else process.env.SCOPE_DB_PATH = before.db;
      if (before.token === undefined) delete process.env.SCOPE_TOKEN_FILE; else process.env.SCOPE_TOKEN_FILE = before.token;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("resolvePort defaults to 43190", () => {
    assert.equal(resolvePort({ SCOPE_PORT: "5000" }), 5000);
  });
});

describe("port-conflict.html — the popup page", () => {
  test("is self-contained and wired to the launcher bridge", () => {
    const html = fs.readFileSync(POPUP, "utf8");
    // No network: every decision goes over the IPC bridge, so the popup works
    // with no server running.
    assert.match(html, /scopeNative\.portConflict/);
    assert.match(html, /fonts\/ClashGrotesk-Variable\.woff2/);
    // The active-server list and each of its per-port actions.
    assert.match(html, /id="pc-ports"/);
    assert.match(html, /id="pc-use"/);
    assert.match(html, /id="pc-reuse"/);
    assert.match(html, /id="pc-kill"/);
    assert.match(html, /id="pc-kill-only"/);
    assert.match(html, /id="pc-continue"/);
    assert.match(html, /id="newport"/);
  });
});

describe("the popup's bridge — preload, main, and page agree", () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const PRELOAD = read("apps/scope-desktop/preload.js");
  const MAIN = read("apps/scope-desktop/main.js");
  const HTML = fs.readFileSync(POPUP, "utf8");

  test("every channel the preload invokes is handled in main.js", () => {
    const invoked = [...PRELOAD.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    const handled = new Set([...MAIN.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]));
    assert.ok(new Set(invoked).size >= 6, "the bridge looks truncated");
    for (const channel of invoked) {
      assert.ok(handled.has(channel), `the preload invokes "${channel}" but main.js never handles it`);
    }
  });

  test("every bridge method the page calls is exposed, and none is dead", () => {
    const bridge = PRELOAD.slice(PRELOAD.indexOf("portConflict: {"));
    const exposed = new Set([...bridge.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]));
    const called = new Set([...HTML.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]));
    assert.deepEqual([...called].sort(), [...exposed].sort());
  });
});
