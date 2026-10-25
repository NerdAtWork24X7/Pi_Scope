// auth-jwt.ts — the credential a paired phone carries.
//
// A phone used to be handed this server's AUTH_TOKEN itself: the master secret
// for every read and write, with no expiry, no way to tell one phone from
// another, and nothing to revoke short of restarting the server. The pairing
// code (the OTP, see server.ts) now buys a short-lived JWT access token plus an
// opaque rotating refresh token instead. The master secret never leaves the
// machine; the phone holds a credential that expires in half an hour and one
// that can be revoked, and losing either costs the user a code from the desktop
// panel, not a reinstall.
//
// HS256 over a random per-boot key. The key stays in memory on purpose: the
// server's token is minted per run, and a phone whose paired access outlived
// the process would be a credential that no longer maps to the security
// boundary it was issued under. A restart therefore means re-pairing — the same
// rule the previous token had, stated by the phone's own pairing gate.
//
// Refresh tokens are looked up by hash, never stored raw, and are single-use:
// each refresh rotates to a fresh token, so a replay of an already-rotated one
// is refused rather than silently honoured.

import * as crypto from "node:crypto";

/** Access token life. Short enough that a stolen one is not a standing grant,
 *  long enough that a phone in a pocket spends a normal session without a
 *  round trip — the refresh happens in the background, five minutes early. */
export const ACCESS_TTL_MS = 30 * 60_000;
/** How long a paired phone stays paired without a new code. Rotated on every
 *  refresh, so this is an idle limit, not a hard wall. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** Refresh 5 minutes before the access token lapses, so an in-flight request
 *  never races the expiry. */
export const REFRESH_LEAD_MS = 5 * 60_000;

const ISSUER = "pi-scope";
const AUDIENCE = "mobile";
/** Tolerance for clock skew between the phone and this machine, in seconds. */
const SKEW_MS = 60_000;
/** Live refresh sessions (one per paired phone). A LAN tool needs a handful;
 *  the cap only stops a pathological client from growing the map unbounded. */
const MAX_SESSIONS = 64;
/** A JWT we issue is ~300 bytes. Anything far past that is not ours. */
const MAX_TOKEN_LENGTH = 4096;

const signingKey = crypto.randomBytes(32);

export interface TokenPair {
  token_type: "Bearer";
  access_token: string;
  /** Seconds until `access_token` expires. */
  expires_in: number;
  refresh_token: string;
  /** Seconds until `refresh_token` expires. */
  refresh_expires_in: number;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(input: string): string {
  return crypto.createHmac("sha256", signingKey).update(input).digest("base64url");
}

/** Constant-time compare of two base64url segments. */
function signatureMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Mint an access token for `now`, signed with this process's key. `ttlMs` is
 *  a test seam — the server always uses ACCESS_TTL_MS. */
export function createAccessToken(now = Date.now(), ttlMs = ACCESS_TTL_MS): { token: string; expiresIn: number } {
  const iat = Math.floor(now / 1000);
  const exp = Math.floor((now + ttlMs) / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "phone",
    iat,
    nbf: iat,
    exp,
    jti: crypto.randomUUID(),
  }));
  const body = `${header}.${claims}`;
  return { token: `${body}.${sign(body)}`, expiresIn: Math.round(ttlMs / 1000) };
}

/**
 * True when `token` is an access token this process minted, still inside its
 * validity window. Every other shape of string — the raw AUTH_TOKEN, a
 * truncated token, a token signed by a previous run — is false.
 */
export function verifyAccessToken(token: string | null | undefined, now = Date.now()): boolean {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerSeg, claimsSeg, signatureSeg] = parts;
  if (!signatureMatches(sign(`${headerSeg}.${claimsSeg}`), signatureSeg)) return false;
  // Reject `alg: none` and algorithm-confusion shapes outright: the header is
  // attacker-controlled up to the signature, so its algorithm is only trusted
  // after the signature has been checked — and even then it must be the one we
  // sign with.
  const header = decodeSegment(headerSeg);
  if (!header || header.alg !== "HS256") return false;
  const claims = decodeSegment(claimsSeg);
  if (!claims || claims.iss !== ISSUER) return false;
  const audience = claims.aud;
  const audienceOk = audience === AUDIENCE || (Array.isArray(audience) && audience.includes(AUDIENCE));
  if (!audienceOk) return false;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) return false;
  const nbf = Number(claims.nbf);
  if (Number.isFinite(nbf) && nbf * 1000 > now + SKEW_MS) return false;
  return true;
}

// ─── Refresh sessions ───────────────────────────────────────────────────────

/** hash → session. The refresh token itself is never kept: a leaked copy of
 *  this map's keys would still be useless, and there is nothing to compare
 *  against byte by byte. */
const sessions = new Map<string, { expiresAt: number; issuedAt: number }>();

function hashRefresh(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function newRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Drop expired sessions, then the oldest ones if a client has paired past the
 *  cap — older pairings give way to newer ones rather than blocking them. */
function prune(now: number): void {
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  if (sessions.size <= MAX_SESSIONS) return;
  const oldest = [...sessions.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt);
  for (const [key] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(key);
}

/** A fresh pair for a phone that just proved it knows the pairing code. */
export function issueTokens(now = Date.now()): TokenPair {
  const refresh = newRefreshToken();
  sessions.set(hashRefresh(refresh), { expiresAt: now + REFRESH_TTL_MS, issuedAt: now });
  prune(now);
  const access = createAccessToken(now);
  return {
    token_type: "Bearer",
    access_token: access.token,
    expires_in: access.expiresIn,
    refresh_token: refresh,
    refresh_expires_in: Math.round(REFRESH_TTL_MS / 1000),
  };
}

/**
 * Trade a refresh token for a new pair. The presented token is spent either
 * way: a rotation cannot be replayed, and a stale one cannot be retried
 * forever. Returns null when the token is unknown, already rotated or expired.
 */
export function refreshTokens(token: string | null | undefined, now = Date.now()): TokenPair | null {
  if (!token || token.length > 512) return null;
  const key = hashRefresh(token);
  const session = sessions.get(key);
  if (!session) return null;
  sessions.delete(key);
  if (session.expiresAt <= now) return null;
  return issueTokens(now);
}

/** Forget a refresh token (the phone's "disconnect"). Idempotent. */
export function revokeRefreshToken(token: string | null | undefined): boolean {
  if (!token) return false;
  return sessions.delete(hashRefresh(token));
}

/** Live paired phones. Exposed for /auth/status and the tests. */
export function pairedPhoneCount(): number {
  prune(Date.now());
  return sessions.size;
}
