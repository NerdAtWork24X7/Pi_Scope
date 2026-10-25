// The server binds every interface by default, so the header's phone button can
// render a scannable QR with no setup. Every other e2e suite pins
// SCOPE_HOST=127.0.0.1 (to stay hermetic), which is exactly why the default is
// otherwise untested — this file boots the real server WITHOUT SCOPE_HOST and
// asserts GET /lan advertises the LAN.
//
// It is also the only suite that exercises the phone-facing HTTPS listener:
// other suites bind loopback, where that listener is deliberately absent, so the
// https:// URL, the generated certificate and the trust chain behind
// `/scope-ca.crt` are all checked here.
//
//   node --test apps/scope-server/test/default-bind.e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as https from "node:https";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "default-bind-token";

let child = null;
let tmpDir = null;
let base = "";
let tlsPort = 0;

/** One HTTPS request; by default it trusts a certificate the system does not
 *  know, which is exactly what a phone sees before it is told about the CA. */
function httpsGet(url, { rejectUnauthorized = false, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized, ...(ca ? { ca } : {}) }, (res) => {
      // Read the peer certificate while the response is live: by 'end' the
      // socket has been released and res.socket is null.
      const cert = res.socket?.getPeerCertificate?.() ?? null;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, cert }));
    });
    req.on("error", reject);
  });
}

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

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-default-bind-")));
  const port = await freePort();
  tlsPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Deliberately NO SCOPE_HOST: the default is what is under test. The cert is
  // minted into the temp dir so the suite never touches ~/.pi-scope/tls.
  const env = {
    ...process.env,
    SCOPE_PORT: String(port),
    SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
    SCOPE_AUTH_TOKEN: TOKEN,
    SCOPE_TLS_PORT: String(tlsPort),
    SCOPE_TLS_DIR: path.join(tmpDir, "tls"),
    SCOPE_PLUGINS_DIR: path.join(tmpDir, "plugins"),
  };
  delete env.SCOPE_HOST;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
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

test("GET /lan advertises the LAN by default (the QR can be scanned)", async () => {
  const res = await fetch(`${base}/lan?token=${TOKEN}`);
  assert.ok(res.ok, `expected 200, got ${res.status}`);
  const data = await res.json();
  assert.equal(data.bind_host, "0.0.0.0", "the default bind is every interface");
  assert.equal(data.lan_exposed, true, "a wildcard bind is treated as LAN-exposed");
  // A machine with at least one routable IPv4 (the common case, and CI runners
  // included) must get scannable URLs. When there is genuinely no interface the
  // panel says so instead; accept that environment rather than fail on it.
  if (data.ips.length > 0) {
    assert.ok(data.urls.length > 0, "a reachable address yields a QR URL");
    // The QR is an address, not a credential: the pairing code is printed beside
    // it and typed on the phone, so a photo of the QR does not pair anything.
    assert.match(data.urls[0], /^https:\/\/[^/]+\/m$/, "the URL is HTTPS and opens the mobile entry");
    assert.ok(data.urls[0].includes(`:${tlsPort}/`), "it points at the phone-facing HTTPS port");
    assert.doesNotMatch(data.urls[0], /pair=|token=/, "and carries neither the code nor the token");
    assert.doesNotMatch(JSON.stringify(data), new RegExp(TOKEN), "the payload never contains the token");
  }
  // The second listener is the point of the https:// URLs above; say plainly
  // whether it came up so a failure names the cause here.
  assert.equal(data.tls, true, "the phone-facing HTTPS listener is running");
  assert.equal(data.tls_port, tlsPort);
  assert.equal(data.tls_error, null);
});

test("the phone-facing listener serves HTTPS with a cert naming the LAN address", async () => {
  const health = await httpsGet(`https://127.0.0.1:${tlsPort}/health`);
  assert.equal(health.status, 200, "the same /health answers over TLS");
  assert.equal(JSON.parse(health.body).ok, true);

  // A phone reaches the desktop UI there too, not just the health probe.
  const page = await httpsGet(`https://127.0.0.1:${tlsPort}/m`);
  assert.equal(page.status, 200);
  assert.match(page.body, /mobile\.js/, "the mobile entry is served by the TLS listener");

  // Nothing trusts this chain yet: that failure is what the phone sees on its
  // first open, and what "Add to Home screen" cannot work without.
  await assert.rejects(
    () => httpsGet(`https://127.0.0.1:${tlsPort}/health`, { rejectUnauthorized: true }),
    /unable to verify|self[- ]signed|certificate/i,
    "an untrusted client refuses the certificate",
  );

  // The CA that signed it is offered for download on the plain-HTTP port, with
  // no credential: the phone has to fetch it *before* it can trust this server.
  const caRes = await fetch(`${base}/scope-ca.crt`);
  assert.equal(caRes.status, 200, "/scope-ca.crt is public");
  assert.equal(caRes.headers.get("content-type"), "application/x-x509-ca-cert");
  const caPem = await caRes.text();
  assert.match(caPem, /^-----BEGIN CERTIFICATE-----/);

  // With that CA installed — which is what the phone's one-time step does — the
  // very same connection verifies, and the service worker (hence the install)
  // becomes possible.
  const trusted = await httpsGet(`https://127.0.0.1:${tlsPort}/health`, { rejectUnauthorized: true, ca: caPem });
  assert.equal(trusted.status, 200, "the chain verifies against the downloaded CA");
  assert.equal(JSON.parse(trusted.body).ok, true);

  const lanIps = (await (await fetch(`${base}/lan?token=${TOKEN}`)).json()).ips;
  for (const ip of lanIps) {
    assert.match(health.cert.subjectaltname, new RegExp(`IP Address:${ip.replace(/\./g, "\\.")}`), `the cert names ${ip}`);
  }
  assert.match(health.cert.subjectaltname, /DNS:localhost/, "and localhost");
});

test("the plain-HTTP port still serves loopback (the desktop app's path)", async () => {
  const res = await fetch(`${base}/health`);
  assert.ok(res.ok, "http://127.0.0.1 keeps working; TLS is only for the LAN hop");
});
