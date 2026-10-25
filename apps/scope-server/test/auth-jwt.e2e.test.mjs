// End-to-end tests for the mobile credential: pairing buys a JWT access token
// plus a rotating refresh token, and those — not the server's master token —
// are what a phone uses from then on.
//
//   node --import ./test/register-bundle.mjs --test test/auth-jwt.e2e.test.mjs

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
const TOKEN = "jwt-test-token";
let MOBILE_ORIGIN = ""; // this server's own origin, filled in `before`

let child = null;
let tmpDir = null;
let base = "";

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

function post(pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Pair the way the phone does: the code from GET /lan, same-origin. */
async function pairPhone() {
  const lan = await (await fetch(`${base}/lan?token=${TOKEN}`)).json();
  const res = await post("/pair", { code: lan.pair_code }, { origin: MOBILE_ORIGIN });
  assert.equal(res.status, 200, `pairing answered ${res.status}`);
  return res.json();
}

/** A real auth-walled route, asked as the phone asks it. */
function sessions(credential, { query = false } = {}) {
  if (query) return fetch(`${base}/sessions?limit=1&token=${encodeURIComponent(credential)}`);
  return fetch(`${base}/sessions?limit=1`, { headers: { authorization: `Bearer ${credential}` } });
}

function decodePayload(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

before(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scope-jwt-")));
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
      SCOPE_MODEL_CATALOG: "off",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth();
  MOBILE_ORIGIN = base;
});

after(async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("the access token opens the auth wall, in a header or in the query", async () => {
  const pair = await pairPhone();

  const viaHeader = await sessions(pair.access_token);
  assert.equal(viaHeader.status, 200, "Bearer works — fetch, and every API call the phone makes");

  // An EventSource URL and an <img> src cannot set a header, so ?token= has to
  // accept the same JWT.
  const viaQuery = await sessions(pair.access_token, { query: true });
  assert.equal(viaQuery.status, 200, "?token= works — the live stream and workspace media");

  const anonymous = await fetch(`${base}/sessions?limit=1`);
  assert.equal(anonymous.status, 401, "and no credential still means no");
});

test("a tampered or self-signed token is refused", async () => {
  const { access_token } = await pairPhone();

  // Flip one character of the payload: the signature no longer covers it.
  const [header, payload, signature] = access_token.split(".");
  const claims = decodePayload(access_token);
  const forgedPayload = Buffer.from(JSON.stringify({ ...claims, sub: "admin" })).toString("base64url");
  assert.equal((await sessions(`${header}.${forgedPayload}.${signature}`)).status, 401, "edited claims");

  // `alg: none` — the classic JWT downgrade. The header is attacker-controlled,
  // so the server must only ever trust the algorithm it signs with.
  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const unsigned = `${noneHeader}.${payload}.`;
  assert.equal((await sessions(unsigned)).status, 401, "unsigned token");

  // A token whose signature is well-formed but wrong.
  const wrongSignature = `${header}.${payload}.${"A".repeat(signature.length)}`;
  assert.equal((await sessions(wrongSignature)).status, 401, "wrong signature");
});

test("the refresh token rotates, and a rotated one cannot be replayed", async () => {
  const first = await pairPhone();

  const res = await post("/pair/refresh", { refresh_token: first.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(res.status, 200, "an unexpired refresh token is accepted");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const second = await res.json();
  assert.notEqual(second.refresh_token, first.refresh_token, "the refresh token is rotated, not reused");
  assert.equal((await sessions(second.access_token)).status, 200, "the new access token works");

  const replay = await post("/pair/refresh", { refresh_token: first.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(replay.status, 401, "the spent refresh token is dead");
  assert.deepEqual(await replay.json(), { error: "invalid_refresh" });

  // Rotation chains: the second token is still good, so a phone that keeps
  // refreshing stays paired without the desktop being involved.
  const third = await post("/pair/refresh", { refresh_token: second.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(third.status, 200, "and the chain continues");
});

test("a refresh from another origin is refused", async () => {
  const { refresh_token } = await pairPhone();
  const res = await post("/pair/refresh", { refresh_token }, { origin: "http://evil.example" });
  assert.equal(res.status, 403, "only this server's own pages may rotate a credential");
});

test("disconnecting a phone revokes only that phone", async () => {
  const phone = await pairPhone();
  const other = await pairPhone();

  const out = await post("/pair/revoke", { refresh_token: phone.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(out.status, 200, "logout answers even for a real session");

  const after = await post("/pair/refresh", { refresh_token: phone.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(after.status, 401, "the disconnected phone cannot renew");

  const still = await post("/pair/refresh", { refresh_token: other.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(still.status, 200, "the other phone is untouched");

  // The access token it already holds keeps working until it lapses: revoking
  // is about the renewal, and a JWT was never designed to be recalled.
  assert.equal((await sessions(phone.access_token)).status, 200, "an issued access token lives out its half hour");

  const again = await post("/pair/revoke", { refresh_token: phone.refresh_token }, { origin: MOBILE_ORIGIN });
  assert.equal(again.status, 200, "logout is idempotent");
});

test("the desktop's master token is unaffected by phone credentials", async () => {
  const res = await fetch(`${base}/sessions?limit=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200, "the master token still opens the same wall");
  assert.equal((await fetch(`${base}/sessions?limit=1&token=${TOKEN}`)).status, 200);
});


