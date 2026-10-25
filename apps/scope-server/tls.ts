/**
 * tls.ts — the certificate behind the phone-facing HTTPS listener.
 *
 * Why this exists: the QR/link a phone opens used to be plain `http://`, so the
 * pairing code the QR carries (and the auth token the phone trades it for) went
 * over Wi-Fi in clear text, readable by anything on the network. The phone now
 * gets an HTTPS listener; the desktop window, the launcher's health probes and
 * the test suite keep talking plain HTTP on loopback, where there is no network
 * to listen in on.
 *
 * The certificate is self-signed, because a LAN IP has no publicly-trusted
 * identity to point at (no CA will issue for 192.168.x.x, and the address
 * changes with the network anyway). That is honest about what it buys:
 * encryption, not proof of who is on the other end. Chrome shows its "your
 * connection is not private" interstitial once per browser session and the
 * pairing panel explains the tap-through.
 *
 * Generation and signing are hand-rolled DER rather than shelling out to
 * `openssl`: the packaged app ships on Windows, which has no openssl binary, and
 * a certificate the app cannot mint is a phone link that cannot work. It is
 * ~150 lines of ASN.1 for exactly one certificate shape, verified against
 * `openssl x509 -text` in the tests.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const DAY_MS = 86_400_000;
// Chrome refuses to remember an exception for a cert valid longer than 398 days,
// so stay just inside that and renew on the way in.
const VALIDITY_DAYS = 397;
// Re-mint rather than serve something that is about to expire mid-session.
const RENEW_BEFORE_MS = 7 * DAY_MS;

export interface TlsMaterial {
  key: string;
  cert: string;
  /** PEM of the local CA that signed `cert`; null for a supplied pair. */
  caCert: string | null;
  dir: string;
  /** A pair the user supplied (SCOPE_TLS_CERT/SCOPE_TLS_KEY), or ours. */
  source: "file" | "generated";
  /** True when this call minted a new cert (first run, or the LAN addresses moved). */
  regenerated: boolean;
  /** The names/IPs the cert is valid for, for the panel and tests. */
  identity: string[];
}

export type TlsResult = { ok: true; material: TlsMaterial } | { ok: false; error: string };

// ─── Minimal DER encoder ────────────────────────────────────────────────────
// Just enough ASN.1 to build one X.509 v3 certificate: definite lengths only,
// and the handful of tags/types that shape needs.

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
/** Context-specific, constructed: [n] EXPLICIT wrappers like version and extensions. */
const ctx = (n: number, ...p: Buffer[]) => tlv(0xa0 | n, ...p);
const octetString = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const NULL_DER = Buffer.from([0x05, 0x00]);

function integerBytes(b: Buffer): Buffer {
  // Positive INTEGERs: a leading 1 bit would read as negative, so pad.
  const body = b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
  return tlv(0x02, body);
}

function bitString(b: Buffer): Buffer {
  // 0 unused bits — every structure here is byte-aligned.
  return tlv(0x03, Buffer.from([0x00]), b);
}

/** An OID from its pre-encoded contents (2.5.4.3 → 55 04 03). */
function oid(contents: number[]): Buffer {
  return tlv(0x06, Buffer.from(contents));
}

const OID_SHA256_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_COMMON_NAME = [0x55, 0x04, 0x03];
const OID_ORGANIZATION = [0x55, 0x04, 0x0a];
const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];
const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];
const OID_KEY_USAGE = [0x55, 0x1d, 0x0f];
const OID_EXT_KEY_USAGE = [0x55, 0x1d, 0x25];
const OID_SERVER_AUTH = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01];

/** UTCTime (YYMMDDhhmmssZ) — valid until 2050, which 397 days never reaches. */
function utcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(stamp, "ascii"));
}

function name(commonName: string): Buffer {
  return seq(
    set(seq(oid(OID_COMMON_NAME), utf8(commonName))),
    set(seq(oid(OID_ORGANIZATION), utf8("Pi Scope"))),
  );
}

function extension(o: number[], critical: boolean, value: Buffer): Buffer {
  return critical
    ? seq(oid(o), bool(true), octetString(value))
    : seq(oid(o), octetString(value));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** The IPv4/IPv6 octets a subjectAltName iPAddress entry carries. */
function ipBytes(ip: string): Buffer | null {
  if (net.isIPv4(ip)) return Buffer.from(ip.split(".").map((part) => parseInt(part, 10)));
  if (net.isIPv6(ip)) {
    // Only loopback matters here (LAN addresses are advertised as IPv4); encode
    // it directly rather than growing a full IPv6 text parser.
    if (ip === "::1") {
      const b = Buffer.alloc(16);
      b[15] = 1;
      return b;
    }
    return null;
  }
  return null;
}

export interface CertSpec {
  /** Extra DNS names, beyond localhost/pi-scope.local. */
  hosts?: string[];
  /** LAN addresses the phone may dial, so the cert matches whichever it uses. */
  ips?: string[];
  now?: Date;
}

// The local CA. A LAN IP has no publicly-trusted identity, so this machine mints
// its own: one CA certificate the phone is told to trust once, and a short-lived
// server certificate it signs. That is what makes the phone hop a plain HTTPS
// origin instead of a warning page — and Chrome only registers the service worker
// (so only offers to install the app) on an origin whose certificate it trusts.
const CA_COMMON_NAME = "Pi Scope Local CA";
// ~8 years, inside the UTC 2050 ceiling of the time encoding below. Long on
// purpose: every server-certificate re-mint reuses it, and re-trusting the CA is
// the one step the user should only ever do once.
const CA_VALIDITY_DAYS = 3000;

interface CertShape {
  /** Subject CN. */
  commonName: string;
  /** DNS names for the SAN list; empty mints no SAN at all. */
  hosts: string[];
  ipAddresses: string[];
  validityDays: number;
  /** True for the CA: basicConstraints cA=TRUE plus keyCertSign. */
  isCa: boolean;
  /** Signer for a leaf certificate; null mints a self-signed one. */
  signer: { key: string; commonName: string } | null;
  now: Date;
}

/** Build one X.509 v3 certificate with a freshly generated key. */
function mintCertificate(shape: CertShape): { key: string; cert: string } {
  const generalNames: Buffer[] = [
    ...shape.hosts.map((h) => tlv(0x82, Buffer.from(h, "ascii"))),
    ...shape.ipAddresses
      .map(ipBytes)
      .filter((b): b is Buffer => !!b)
      .map((b) => tlv(0x87, b)),
  ];

  // RSA 2048 / SHA-256: what every Android Chrome and iOS Safari accepts.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const extensions = shape.isCa
    ? seq(
      // cA=TRUE, critical: Android's "install a CA certificate" flow refuses a
      // certificate without it.
      extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true))),
      // keyCertSign (bit 5) + cRLSign (bit 6): one unused bit, value 0x06.
      extension(OID_KEY_USAGE, true, tlv(0x03, Buffer.from([0x01, 0x06]))),
    )
    : seq(
      ...(generalNames.length ? [extension(OID_SUBJECT_ALT_NAME, false, seq(...generalNames))] : []),
      // A leaf signs nothing, it only identifies this server.
      extension(OID_BASIC_CONSTRAINTS, true, seq()),
      // digitalSignature + keyEncipherment (bits 0 and 2 of the BIT STRING).
      extension(OID_KEY_USAGE, true, tlv(0x03, Buffer.from([0x05, 0xa0]))),
      extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
    );

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // keep it positive
  if (serial[0] === 0) serial[0] = 1;

  const subject = name(shape.commonName);
  const issuer = shape.signer ? name(shape.signer.commonName) : subject;
  const sigAlg = seq(oid(OID_SHA256_RSA), NULL_DER);
  const spki = seq(seq(oid(OID_RSA), NULL_DER), bitString(publicKey));
  const now = shape.now;

  const tbs = seq(
    ctx(0, integerBytes(Buffer.from([2]))), // version: v3
    integerBytes(serial),
    sigAlg,
    issuer,
    seq(utcTime(new Date(now.getTime() - DAY_MS)), utcTime(new Date(now.getTime() + shape.validityDays * DAY_MS))),
    subject,
    spki,
    ctx(3, extensions),
  );

  const signature = crypto.sign("sha256", tbs, shape.signer ? shape.signer.key : privateKey);
  const cert = seq(tbs, sigAlg, bitString(signature));

  return { key: privateKey, cert: pem("CERTIFICATE", cert) };
}

/** Mint a self-signed server certificate + key for the given LAN addresses.
 *  Kept for a user-supplied pair and for tests; the listener itself serves a leaf
 *  signed by the local CA (see buildLocalServerCert). */
export function buildSelfSignedCert(spec: CertSpec = {}): { key: string; cert: string; identity: string[] } {
  const hosts = [...new Set(["localhost", "pi-scope.local", ...(spec.hosts ?? [])].map((h) => h.toLowerCase()))];
  const ips = [...new Set(["127.0.0.1", "::1", ...(spec.ips ?? [])])];
  const { key, cert } = mintCertificate({
    commonName: hosts[0],
    hosts,
    ipAddresses: ips,
    validityDays: VALIDITY_DAYS,
    isCa: false,
    signer: null,
    now: spec.now ?? new Date(),
  });
  return { key, cert, identity: [...hosts, ...ips] };
}

/** Mint the local CA: one long-lived certificate the phone can be told to trust. */
export function buildLocalCa(spec: { now?: Date } = {}): { key: string; cert: string } {
  return mintCertificate({
    commonName: CA_COMMON_NAME,
    hosts: [],
    ipAddresses: [],
    validityDays: CA_VALIDITY_DAYS,
    isCa: true,
    signer: null,
    now: spec.now ?? new Date(),
  });
}

/** Mint the server certificate, signed by the local CA. */
export function buildLocalServerCert(
  spec: CertSpec & { ca: { key: string; cert: string } },
): { key: string; cert: string; identity: string[] } {
  const hosts = [...new Set(["localhost", "pi-scope.local", ...(spec.hosts ?? [])].map((h) => h.toLowerCase()))];
  const ips = [...new Set(["127.0.0.1", "::1", ...(spec.ips ?? [])])];
  const { key, cert } = mintCertificate({
    commonName: hosts[0],
    hosts,
    ipAddresses: ips,
    validityDays: VALIDITY_DAYS,
    isCa: false,
    signer: { key: spec.ca.key, commonName: CA_COMMON_NAME },
    now: spec.now ?? new Date(),
  });
  return { key, cert, identity: [...hosts, ...ips] };
}

/** True when `certPem` is a leaf this CA actually signed. */
function signedByCa(certPem: string, caPem: string): boolean {
  try {
    const leaf = new crypto.X509Certificate(certPem);
    const ca = new crypto.X509Certificate(caPem);
    return leaf.issuer === ca.subject && leaf.verify(ca.publicKey);
  } catch {
    return false;
  }
}

/** The CA on disk, when it is a CA, still valid, and paired with its key. */
function readCa(certFile: string, keyFile: string): { key: string; cert: string } | null {
  try {
    const cert = fs.readFileSync(certFile, "utf8");
    const key = fs.readFileSync(keyFile, "utf8");
    const parsed = new crypto.X509Certificate(cert);
    if (parsed.ca !== true) return null;
    if (new Date(parsed.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) return null;
    const privateKey = crypto.createPrivateKey(key);
    if (typeof parsed.checkPrivateKey === "function" && !parsed.checkPrivateKey(privateKey)) return null;
    return { key, cert };
  } catch {
    return null;
  }
}

/** Where the minted pair lives; override with SCOPE_TLS_DIR. */
export function certDir(): string {
  return process.env.SCOPE_TLS_DIR ?? path.join(os.homedir(), ".pi-scope", "tls");
}

function safeCheck(fn: () => unknown): boolean {
  try {
    return !!fn();
  } catch {
    return false;
  }
}

/**
 * True when an existing pair can still be used: it parses, it matches its own
 * key, it is not about to expire, and it names every address we advertise. A
 * machine that moves between Wi-Fi networks changes IPs, and a cert without the
 * new one would fail the hostname check — hence the identity comparison, not
 * just an expiry check.
 */
function coversIdentity(certPem: string, keyPem: string, hosts: string[], ips: string[]): boolean {
  try {
    const cert = new crypto.X509Certificate(certPem);
    if (new Date(cert.validTo).getTime() - Date.now() < RENEW_BEFORE_MS) return false;
    try {
      const key = crypto.createPrivateKey(keyPem);
      if (typeof cert.checkPrivateKey === "function" && !cert.checkPrivateKey(key)) return false;
    } catch {
      return false;
    }
    for (const host of hosts) if (!safeCheck(() => cert.checkHost(host))) return false;
    for (const ip of ips) if (!safeCheck(() => cert.checkIP(ip))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The certificate to serve: a user-supplied pair when both env vars are set,
 * otherwise the cached one in `certDir()`, minted (or re-minted) as needed.
 * Returns a reason instead of throwing so the caller can fall back to HTTP on
 * loopback-only rather than refusing to boot.
 */
export function ensureTlsMaterial(spec: CertSpec = {}): TlsResult {
  const hosts = [...new Set(["localhost", "pi-scope.local", ...(spec.hosts ?? [])].map((h) => h.toLowerCase()))];
  const ips = [...new Set(["127.0.0.1", "::1", ...(spec.ips ?? [])])];
  const identity = [...hosts, ...ips];

  const certPath = process.env.SCOPE_TLS_CERT;
  const keyPath = process.env.SCOPE_TLS_KEY;
  if (certPath || keyPath) {
    if (!certPath || !keyPath) {
      return { ok: false, error: "SCOPE_TLS_CERT and SCOPE_TLS_KEY must be set together" };
    }
    try {
      const cert = fs.readFileSync(certPath, "utf8");
      const key = fs.readFileSync(keyPath, "utf8");
      new crypto.X509Certificate(cert); // parse-check before handing it to https
      crypto.createPrivateKey(key);
      return { ok: true, material: { key, cert, caCert: null, dir: path.dirname(certPath), source: "file", regenerated: false, identity } };
    } catch (err: any) {
      return { ok: false, error: `could not read SCOPE_TLS_CERT/SCOPE_TLS_KEY: ${err?.message ?? err}` };
    }
  }

  const dir = certDir();
  const caCertFile = path.join(dir, "ca-cert.pem");
  const caKeyFile = path.join(dir, "ca-key.pem");
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");

  // The CA comes first, and outlives every server certificate: a laptop that
  // changes networks re-mints the leaf (the LAN address in its SAN moved), while
  // the trust the phone granted once keeps working.
  let ca = readCa(caCertFile, caKeyFile);
  let regenerated = false;
  if (!ca) {
    try {
      const minted = buildLocalCa();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(caKeyFile, minted.key, { mode: 0o600 });
      fs.chmodSync(caKeyFile, 0o600);
      fs.writeFileSync(caCertFile, minted.cert, { mode: 0o644 });
      ca = minted;
      regenerated = true;
    } catch (err: any) {
      return { ok: false, error: `could not create a local CA in ${dir}: ${err?.message ?? err}` };
    }
  }

  try {
    const cert = fs.readFileSync(certFile, "utf8");
    const key = fs.readFileSync(keyFile, "utf8");
    // A cert from an older build is self-signed and would fail the phone's trust
    // check (and Chrome's service-worker rule), so the issuer is part of the
    // reuse test, not just the SAN and expiry.
    if (coversIdentity(cert, key, hosts, ips) && signedByCa(cert, ca.cert)) {
      return { ok: true, material: { key, cert, caCert: ca.cert, dir, source: "generated", regenerated, identity } };
    }
  } catch {
    // Missing or unreadable: mint a fresh leaf below.
  }

  try {
    const minted = buildLocalServerCert({ ...spec, hosts, ips, ca });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The private key is the secret here; the cert is public by nature.
    fs.writeFileSync(keyFile, minted.key, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    fs.writeFileSync(certFile, minted.cert, { mode: 0o644 });
    return { ok: true, material: { key: minted.key, cert: minted.cert, caCert: ca.cert, dir, source: "generated", regenerated: true, identity } };
  } catch (err: any) {
    return { ok: false, error: `could not create a certificate in ${dir}: ${err?.message ?? err}` };
  }
}
