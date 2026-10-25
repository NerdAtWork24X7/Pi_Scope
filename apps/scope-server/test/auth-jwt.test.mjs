// Unit tests for auth-jwt.ts — the phone's access/refresh credential.
//
// The e2e suite (auth-jwt.e2e.test.mjs) covers the HTTP surface; this pins the
// parts that are impractical to trigger over the wire: expiry, clock skew and
// the single-use refresh rotation.
//
//   node --import ./test/register-bundle.mjs --test test/auth-jwt.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCESS_TTL_MS,
  createAccessToken,
  issueTokens,
  refreshTokens,
  revokeRefreshToken,
  verifyAccessToken,
} from "../auth-jwt.ts";

test("a token verifies while it is live, and not a second after", () => {
  const now = Date.now();
  const { token } = createAccessToken(now, 60_000);
  assert.equal(verifyAccessToken(token, now), true);
  assert.equal(verifyAccessToken(token, now + 59_000), true);
  assert.equal(verifyAccessToken(token, now + 60_500), false, "exp is a hard edge");
});

test("the default lifetime is short enough to be a session, not a grant", () => {
  const { expiresIn } = createAccessToken();
  assert.equal(expiresIn * 1000, ACCESS_TTL_MS);
  assert.ok(ACCESS_TTL_MS <= 60 * 60_000, "under an hour");
});

test("a token that is not valid yet is refused beyond the clock-skew leeway", () => {
  const now = Date.now();
  // Issued ten minutes in the future (a phone whose clock ran ahead when it was
  // minted, or a stolen token minted later): not yet valid here.
  const { token } = createAccessToken(now + 10 * 60_000, 60 * 60_000);
  assert.equal(verifyAccessToken(token, now), false);
  // Inside a minute of nbf is tolerated, because two machines never agree.
  const { token: soon } = createAccessToken(now + 30_000, 60 * 60_000);
  assert.equal(verifyAccessToken(soon, now), true);
});

test("garbage is not a token", () => {
  for (const value of ["", "devtoken", "a.b", "a.b.c.d", null, undefined]) {
    assert.equal(verifyAccessToken(value), false, `${JSON.stringify(value)} must not authenticate`);
  }
});

test("refreshing rotates: the old token is dead the moment it is spent", () => {
  const first = issueTokens();
  const second = refreshTokens(first.refresh_token);
  assert.ok(second, "the first refresh succeeds");
  assert.notEqual(second.refresh_token, first.refresh_token, "and hands back a new one");
  assert.equal(refreshTokens(first.refresh_token), null, "replaying it gets nothing");
  assert.ok(verifyAccessToken(second.access_token), "the new access token is live");

  // The chain keeps going, so a phone that refreshes on a timer stays paired.
  const third = refreshTokens(second.refresh_token);
  assert.ok(third);
});

test("an unknown or revoked refresh token cannot renew", () => {
  assert.equal(refreshTokens("not-a-token"), null);
  assert.equal(refreshTokens(""), null);

  const pair = issueTokens();
  assert.equal(revokeRefreshToken(pair.refresh_token), true);
  assert.equal(refreshTokens(pair.refresh_token), null, "revoked means revoked");
  assert.equal(revokeRefreshToken(pair.refresh_token), false, "revoking twice is harmless");
});

test("an expired refresh token cannot renew", () => {
  const now = Date.now();
  const pair = issueTokens(now);
  const after30Days = now + 30 * 24 * 60 * 60_000 + 1_000;
  assert.equal(refreshTokens(pair.refresh_token, after30Days), null);
});
