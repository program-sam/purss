import { createHash } from "node:crypto";
import type { App } from "../app.ts";
import { addSeconds, nowIso } from "../http.ts";
import { humanCode, normalizeCode, randomToken, safeEqual, sha256 } from "../secrets.ts";

/*
 * One-time authorization codes with PKCE (RFC 7636, S256 only): the shared core of "Connected apps"
 * (plan/24) and of the OAuth server for assistants (plan/33), kept free of HTTP and of what the
 * code is finally exchanged for.
 *
 * The flow it supports:
 *   1. The app makes a random code_verifier, keeps it, and sends only
 *      code_challenge = BASE64URL(SHA-256(code_verifier)) to the approval page.
 *   2. The signed-in person approves; issueCode() stores the challenge with what was approved
 *      (account, client kind, OAuth client id, redirect target, scope) and returns a one-time code.
 *   3. The app sends the code with its code_verifier; redeemCode() checks both.
 *
 * Properties this module guarantees:
 * - A code is single use. Redemption deletes the row in the same statement that reads it
 *   (DELETE … RETURNING), so two concurrent redemptions can't both succeed, and a failed attempt
 *   (wrong verifier, client or redirect) burns the code too: whoever intercepted it gets one try,
 *   and the legitimate app then fails loudly instead of silently racing an attacker.
 * - A code is bound to its challenge, client kind, OAuth client id and exact redirect target. A code intercepted on
 *   the way to the app (another app registering the same URL scheme, a leaked browser history
 *   entry) is useless without the verifier, which never left the app.
 * - A code lives CODE_TTL_SECONDS. Only SHA-256 hashes of codes are stored.
 * - The verifier check is constant-time over equal-length strings.
 *
 * Two code forms:
 * - "redirect": 32 random bytes, delivered by redirecting the browser to the app's redirect target.
 * - "typed": three groups of four characters from a 31-letter alphabet (about 59 bits), shown on the
 *   approval page for apps that can't receive a redirect. Guessing one is no use without the
 *   verifier; the token route rate-limits attempts anyway.
 */

export const CODE_TTL_SECONDS = 5 * 60;
/** RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** BASE64URL(SHA-256(…)) without padding is always 43 characters. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type CodeForm = "redirect" | "typed";

/**
 * What the person approved. `redirectUri` is null for typed codes. `label` is the app's device name
 * or the OAuth client's name. `clientId` and `scope` are set for OAuth codes (kind "oauth") only.
 */
export type Grant = { accountId: string; kind: string; clientId: string | null; redirectUri: string | null; label: string; scope: string | null };

/** BASE64URL(SHA-256(ASCII(code_verifier))), RFC 7636 §4.2. */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Does the verifier belong to the challenge? Constant time; false for malformed input. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier) || !CHALLENGE_PATTERN.test(challenge)) return false;
  return safeEqual(s256(verifier), challenge);
}

/** Typed codes are compared case- and separator-insensitively; redirect codes exactly. What is stored. */
export const codeHash = (code: string, form: CodeForm) => sha256(form === "typed" ? normalizeCode(code) : code);

/** Store an approved grant and return its one-time code (shown or sent once, never stored). */
export function issueCode(app: App, grant: Grant, codeChallenge: string, form: CodeForm): string {
  if (!CHALLENGE_PATTERN.test(codeChallenge)) throw new Error("issueCode: malformed code_challenge");
  if ((form === "redirect") !== (grant.redirectUri !== null)) throw new Error("issueCode: a redirect code needs a redirect target and a typed code none");
  const code = form === "typed" ? humanCode(3) : randomToken(32);
  app.db.run(
    "INSERT INTO connect_codes (code_hash, account_id, kind, client_id, redirect_uri, code_challenge, label, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    codeHash(code, form), grant.accountId, grant.kind, grant.clientId, grant.redirectUri, codeChallenge, grant.label, grant.scope, nowIso(), addSeconds(CODE_TTL_SECONDS),
  );
  return code;
}

export type Redemption =
  | { ok: true; grant: Grant }
  /** `accountId` is set when the code existed (and is now burned), for the audit log. */
  | { ok: false; reason: "unknown" | "expired" | "client" | "redirect" | "verifier"; accountId: string | null };

/**
 * Exchange a code. `kind` and `clientId` must be what the code was issued to; `redirectUri` must be
 * exactly the target the code was issued for, and absent for typed codes. Without `form`, the
 * redirect target's presence is how the form is told apart. OAuth (plan/33) passes form "redirect"
 * and may leave the target out (OAuth 2.1 dropped it from the token request; PKCE does its job):
 * the code is then still bound to the target it was issued for, which the grant records. The row is
 * gone afterwards whatever the outcome.
 */
export function redeemCode(app: App, input: { code: string; codeVerifier: string; kind: string; clientId: string | null; redirectUri: string | null; form?: CodeForm }): Redemption {
  const form: CodeForm = input.form ?? (input.redirectUri === null ? "typed" : "redirect");
  const row = app.db.get<{ account_id: string; kind: string; client_id: string | null; redirect_uri: string | null; code_challenge: string; label: string; scope: string | null; expires_at: string }>(
    "DELETE FROM connect_codes WHERE code_hash = ? RETURNING account_id, kind, client_id, redirect_uri, code_challenge, label, scope, expires_at",
    codeHash(input.code, form));
  if (!row) return { ok: false, reason: "unknown", accountId: null };
  const fail = (reason: "expired" | "client" | "redirect" | "verifier"): Redemption => ({ ok: false, reason, accountId: row.account_id });
  if (row.expires_at <= nowIso()) return fail("expired");
  if (row.kind !== input.kind || row.client_id !== input.clientId) return fail("client");
  if (input.redirectUri === null ? (row.redirect_uri === null) !== (form === "typed") : row.redirect_uri !== input.redirectUri) return fail("redirect");
  if (!verifierMatches(input.codeVerifier, row.code_challenge)) return fail("verifier");
  return { ok: true, grant: { accountId: row.account_id, kind: row.kind, clientId: row.client_id, redirectUri: row.redirect_uri, label: row.label, scope: row.scope } };
}

/** Drop expired codes (maintenance tick). */
export function purgeCodes(app: App): void {
  app.db.run("DELETE FROM connect_codes WHERE expires_at <= ?", nowIso());
}
