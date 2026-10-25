// The phone pairs with a short-lived code instead of the auth token: the QR and
// the desktop panel show a two-minute, six-digit code, and GET /lan never publishes the
// token. POST /pair is the one route above the auth wall that turns a code into
// a credential (a JWT access token + a refresh token — see auth-jwt.ts), so its
// own gate (format, constant-time compare, same-origin, failure budget) is what
// these tests exercise.
//
//   node --import ./test/register-bundle.mjs --test test/pair.e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const SERVER = path.join(ROOT, "apps", "scope-server", "server.ts");
const TOKEN = "pair-test-token";

let child = null;
let tmpDir = null;
let base = "";
let origin = "";

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

/** POST /pair, optionally with a browser Origin (which the route requires to
 *  match this server). */
function pair(body, headers = {}) {
  return fetch(`${base}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function lan() {
  const res = await fetch(`${base}/lan?token=${TOKEN}`);
  assert.ok(res.ok, `GET /lan answered ${res.status}`);
  return res.json();
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-pair-")));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      SCOPE_PORT: String(port),
      SCOPE_HOST: "127.0.0.1",
      SCOPE_DB_PATH: path.join(tmpDir, "scope.db"),
      SCOPE_AUTH_TOKEN: TOKEN,
      SCOPE_MODEL_CATALOG: "off",
    },
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

test("GET /lan publishes a typable code, never the auth token", async () => {
  const data = await lan();
  assert.match(data.pair_code, /^\d{3} \d{3}$/, "six digits, grouped for reading");
  assert.ok(data.pair_expires_at > Date.now(), "the code has a live expiry");
  assert.ok(data.pair_expires_at <= Date.now() + 2 * 60_000, "and it is short-lived");
  assert.doesNotMatch(JSON.stringify(data.urls), /token=/, "no URL carries the token");
  assert.doesNotMatch(JSON.stringify(data), new RegExp(TOKEN), "the response body never contains it");
});

test("the code exchanges for a JWT, never for this run's master token", async () => {
  const { pair_code } = await lan();
  // Without the space (as a keypad without a separator key would give it).
  const typed = pair_code.replace(" ", "");
  const res = await pair({ code: typed }, { origin });
  assert.equal(res.status, 200, "the grouping is optional");
  assert.equal(res.headers.get("cache-control"), "no-store", "a credential is not cacheable");

  const data = await res.json();
  assert.doesNotMatch(JSON.stringify(data), new RegExp(TOKEN), "the master token never leaves the machine");
  assert.equal(data.token, undefined, "and is not handed over under the old key either");

  assert.equal(data.token_type, "Bearer");
  const parts = String(data.access_token).split(".");
  assert.equal(parts.length, 3, "the access token is a compact JWS");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.equal(header.alg, "HS256");
  assert.equal(claims.aud, "mobile", "scoped to the phone, not to the desktop's authority");
  assert.ok(claims.exp * 1000 > Date.now(), "it starts out live");
  assert.ok(claims.exp - claims.iat <= 3600, "and is short-lived");
  assert.equal(data.expires_in, claims.exp - claims.iat, "expires_in agrees with the claims");

  assert.ok(String(data.refresh_token).length >= 32, "the refresh token is high-entropy");
  assert.ok(data.refresh_expires_in > data.expires_in, "and outlives the access token");
});

test("a code is single-use, like an OTP", async () => {
  const { pair_code } = await lan();
  const first = await pair({ code: pair_code }, { origin });
  assert.equal(first.status, 200, "the first phone pairs");

  // Spending it destroys it: a second device (or a replayed request) cannot use
  // the same code, which is what makes it one-time rather than a short password.
  const again = await pair({ code: pair_code }, { origin });
  assert.equal(again.status, 401, "the spent code is refused");
  assert.deepEqual(await again.json(), { error: "used" }, "and says it was used, not mistyped");

  const next = await lan();
  assert.notEqual(next.pair_code, pair_code, "the panel is handed the next code");
  assert.ok(next.pair_expires_at > Date.now(), "with its own two minutes");
});

test("a wrong code is refused and the gate stays closed", async () => {
  const { pair_code } = await lan();
  const wrong = pair_code === "ZZZZ-ZZZZ" ? "YYYY-YYYY" : "ZZZZ-ZZZZ";
  const res = await pair({ code: wrong }, { origin });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "invalid" });
});

test("a cross-origin page cannot spend a code it happened to see", async () => {
  const { pair_code } = await lan();
  const res = await pair({ code: pair_code }, { origin: "http://evil.example" });
  assert.equal(res.status, 403, "only this server's own pages may pair");
});

test("repeated failures hit a rate limit instead of guessing the code", async () => {
  const { pair_code } = await lan();
  const wrong = pair_code === "ZZZZ-ZZZZ" ? "YYYY-YYYY" : "ZZZZ-ZZZZ";
  // The budget is per peer; earlier tests in this file spent a few failures, so
  // keep going until the limiter answers rather than assuming a count.
  let status = 0;
  for (let i = 0; i < 12 && status !== 429; i++) {
    status = (await pair({ code: wrong }, { origin })).status;
  }
  assert.equal(status, 429, "the brute-force budget is enforced");
  const blocked = await pair({ code: pair_code }, { origin });
  assert.equal(blocked.status, 429, "and a correct code waits out the window too");
});
