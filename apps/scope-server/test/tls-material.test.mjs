// Unit tests for tls.ts — the local CA and the server certificate behind the
// phone-facing HTTPS listener. The hand-rolled ASN.1 is the risky part, so this
// asserts the result as an X.509 client sees it (Node's own parser, same code
// path Chrome's rules are mirrored from) rather than trusting the encoder.
//
//   node --import ./test/register-bundle.mjs --test test/tls-material.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildLocalCa, buildLocalServerCert, buildSelfSignedCert, ensureTlsMaterial, certDir } from "../tls.ts";

const DAY = 86_400_000;

function tmpDir(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `scope-tls-${tag}-`)));
}

/** Run `fn` with the TLS env vars pinned, restoring them afterwards. */
function withEnv(vars, fn) {
  const saved = {};
  for (const key of ["SCOPE_TLS_DIR", "SCOPE_TLS_CERT", "SCOPE_TLS_KEY"]) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a minted certificate parses, names the LAN addresses and matches its key", () => {
  const { cert, key, identity } = buildSelfSignedCert({ ips: ["192.168.2.149", "10.0.0.4"] });
  const parsed = new crypto.X509Certificate(cert);

  assert.ok(parsed.checkIP("192.168.2.149"), "the QR's LAN address is in the SAN list");
  assert.ok(parsed.checkIP("10.0.0.4"));
  assert.ok(parsed.checkIP("127.0.0.1"), "loopback works too (the suite dials 127.0.0.1)");
  assert.ok(parsed.checkHost("localhost"));
  assert.ok(parsed.checkPrivateKey(crypto.createPrivateKey(key)), "cert and key belong together");
  assert.ok(identity.includes("192.168.2.149"));

  const days = (new Date(parsed.validTo).getTime() - Date.now()) / DAY;
  assert.ok(days > 360 && days < 398, `valid ~397 days (Chrome's ceiling), got ${days.toFixed(1)}`);
  assert.match(parsed.subjectAltName, /IP Address:192\.168\.2\.149/);
});

test("the local CA is a real CA and signs the server certificate", () => {
  // Chrome only registers a service worker — and so only offers to install the
  // app — on an origin it trusts, which a self-signed leaf accepted through the
  // interstitial is not. One trusted CA is what makes the install possible.
  const ca = buildLocalCa();
  const leaf = buildLocalServerCert({ ips: ["192.168.2.149"], ca });
  const caX = new crypto.X509Certificate(ca.cert);
  const leafX = new crypto.X509Certificate(leaf.cert);

  assert.equal(caX.ca, true, "the CA carries CA:TRUE (Android's installer insists on it)");
  assert.equal(caX.subject, "CN=Pi Scope Local CA\nO=Pi Scope");
  assert.equal(leafX.ca, false, "the leaf is not a CA");
  assert.equal(leafX.issuer, caX.subject, "the leaf names the CA as its issuer");
  assert.ok(leafX.verify(caX.publicKey), "and its signature checks out against the CA key");
  assert.ok(leafX.checkIP("192.168.2.149") && leafX.checkHost("localhost"), "the SAN still names the addresses");
  assert.ok(leafX.checkPrivateKey(crypto.createPrivateKey(leaf.key)), "the leaf and its key belong together");

  const years = (new Date(caX.validTo).getTime() - Date.now()) / DAY / 365;
  assert.ok(years > 5, `the CA outlives many leaf re-mints (${years.toFixed(1)} years)`);

  // A certificate from the old self-signed build must not pass for ours.
  const legacy = buildSelfSignedCert({ ips: ["192.168.2.149"] });
  assert.equal(new crypto.X509Certificate(legacy.cert).verify(caX.publicKey), false);
});

test("ensureTlsMaterial mints a CA, and re-minting the leaf keeps it", () => {
  const dir = tmpDir("ca");
  withEnv({ SCOPE_TLS_DIR: dir }, () => {
    const first = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(first.ok, true);
    assert.ok(first.material.caCert, "the CA PEM comes back for /scope-ca.crt");
    const caX = new crypto.X509Certificate(first.material.caCert);
    assert.equal(caX.ca, true);
    assert.ok(new crypto.X509Certificate(first.material.cert).verify(caX.publicKey), "the served cert is signed by it");

    // On disk: the CA key is a secret, the certificates are public.
    assert.equal(fs.statSync(path.join(dir, "ca-key.pem")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "ca-cert.pem")).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(dir, "key.pem")).mode & 0o777, 0o600);

    const second = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(second.material.caCert, first.material.caCert, "a reuse never re-mints the CA");

    // The machine moved networks: the leaf must be re-minted for the new
    // address, and the CA must survive it — re-trusting is the one step the user
    // should only do once.
    const moved = ensureTlsMaterial({ ips: ["192.168.2.149", "192.168.9.7"] });
    assert.equal(moved.material.regenerated, true);
    assert.equal(moved.material.caCert, first.material.caCert, "the trusted CA is untouched");
    assert.ok(new crypto.X509Certificate(moved.material.cert).checkIP("192.168.9.7"));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a certificate left by the old self-signed build is replaced, not served", () => {
  const dir = tmpDir("legacy");
  withEnv({ SCOPE_TLS_DIR: dir }, () => {
    // Simulate an install from before the CA existed: a valid, covering pair that
    // simply is not signed by the CA.
    fs.mkdirSync(dir, { recursive: true });
    const legacy = buildSelfSignedCert({ ips: ["192.168.2.149"] });
    fs.writeFileSync(path.join(dir, "cert.pem"), legacy.cert);
    fs.writeFileSync(path.join(dir, "key.pem"), legacy.key);

    const result = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(result.ok, true);
    assert.equal(result.material.regenerated, true, "the leaf is re-minted under the new CA");
    assert.notEqual(result.material.cert, legacy.cert);
    assert.ok(result.material.caCert);
    assert.ok(new crypto.X509Certificate(result.material.cert).verify(new crypto.X509Certificate(result.material.caCert).publicKey));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensureTlsMaterial caches the pair and re-mints when the LAN address changes", () => {
  const dir = tmpDir("cache");
  withEnv({ SCOPE_TLS_DIR: dir }, () => {
    const first = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(first.ok, true);
    assert.equal(first.material.regenerated, true, "the first call has to mint one");
    assert.equal(first.material.dir, dir);
    assert.equal(certDir(), dir);

    // 0600: the private key is a secret, even for a self-signed cert.
    const mode = fs.statSync(path.join(dir, "key.pem")).mode & 0o777;
    assert.equal(mode, 0o600, `key.pem must be owner-only, got ${mode.toString(8)}`);

    const second = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(second.ok, true);
    assert.equal(second.material.regenerated, false, "a covering cert is reused, not re-minted");
    assert.equal(second.material.cert, first.material.cert);

    // Same machine, different network: the old cert does not name the new
    // address, so it would fail the phone's hostname check.
    const moved = ensureTlsMaterial({ ips: ["192.168.2.149", "192.168.9.7"] });
    assert.equal(moved.ok, true);
    assert.equal(moved.material.regenerated, true, "a new address forces a new cert");
    assert.ok(new crypto.X509Certificate(moved.material.cert).checkIP("192.168.9.7"));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a supplied SCOPE_TLS_CERT/SCOPE_TLS_KEY pair is used as-is", () => {
  const dir = tmpDir("supplied");
  const minted = buildSelfSignedCert({ ips: ["192.168.2.149"] });
  const certFile = path.join(dir, "custom.crt");
  const keyFile = path.join(dir, "custom.key");
  fs.writeFileSync(certFile, minted.cert);
  fs.writeFileSync(keyFile, minted.key);

  withEnv({ SCOPE_TLS_CERT: certFile, SCOPE_TLS_KEY: keyFile, SCOPE_TLS_DIR: path.join(dir, "unused") }, () => {
    const result = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(result.ok, true);
    assert.equal(result.material.source, "file");
    assert.equal(result.material.cert, minted.cert, "our own cert is never substituted");
    assert.equal(fs.existsSync(path.join(dir, "unused")), false, "nothing is written when a pair is supplied");
  });

  // Half a pair is a configuration error worth naming, not a silent fallback.
  withEnv({ SCOPE_TLS_CERT: certFile, SCOPE_TLS_KEY: undefined }, () => {
    const result = ensureTlsMaterial({ ips: ["192.168.2.149"] });
    assert.equal(result.ok, false);
    assert.match(result.error, /SCOPE_TLS_CERT and SCOPE_TLS_KEY/);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
