import { createHmac } from "node:crypto";
import { newId } from "@purss/domain";
import type { AssistantAccessLevel } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { addSeconds, nowIso } from "../http.ts";
import { ensureSecret, randomToken, safeEqual, sha256 } from "../secrets.ts";
import { codeHash, redeemCode } from "../connect/codes.ts";
import type { AssistantCaller } from "../services/assistant.ts";
import { MAX_GRANTS, endpointFor, grantCount, hostOf, installationEnabled, revokeGrantRow } from "../services/assistant.ts";
import { isAccountUsable } from "../services/deletion.ts";

/*
 * OAuth grants and tokens for assistants (plan/33). A grant is one assistant a person approved on
 * the consent page; it holds the access level (read, or read and organise: the same levels as
 * personal access tokens) and the resource (/mcp) its tokens are for.
 *
 * - Access tokens: `purss_oat_` + 32 random bytes, one hour, sent as a Bearer header to /mcp only.
 * - Refresh tokens: `purss_ort_<grant id>.<generation>.<nonce>.<mac>`, single use. The generation is
 *   0 for the pair the code brings and one more with each refresh; the nonce is 32 random bytes;
 *   the mac is HMAC-SHA256 over grant id, generation and nonce with the server's refresh key
 *   (secrets/oauth-refresh-key). Each refresh issues a new pair and moves the grant's end to
 *   GRANT_IDLE_DAYS from now. A grant stores only its current refresh token's hash and generation.
 *   An earlier refresh token presented again means two parties hold it: the whole grant is revoked
 *   (OAuth 2.1 §4.3.1). It is recognised as earlier, however many generations ago, by a valid mac
 *   with a generation below the grant's; nobody without the key can make one, so a grant id alone
 *   can't end a grant, and anything else is just refused. The same goes for an authorization code
 *   presented a second time (§4.1.3).
 *   Each grant records which key signed its tokens. Without that key (a restore without the secrets
 *   folder makes a new one, or the key file was replaced) a grant can't recognise its spent tokens,
 *   so it ends at the next refresh or revocation and the assistant connects again; its access
 *   tokens run out within the hour. A token from a generation the grant hasn't reached (a database restored from an older
 *   backup) is refused the same way; the assistant connects again.
 * - Only SHA-256 hashes of current tokens are stored. Tokens are looked up on every request, so
 *   revocation, the switches and suspension apply to the next one.
 *
 * A token acts as its account's principal, never as an administrator and never as a recent
 * sign-in, exactly like a personal access token: /mcp can't tell them apart past this module.
 */

export const ACCESS_TOKEN_PREFIX = "purss_oat_";
export const REFRESH_TOKEN_PREFIX = "purss_ort_";
export const ACCESS_TOKEN_SECONDS = 3600;
/** A grant whose refresh token isn't used for this long ends. */
export const GRANT_IDLE_DAYS = 90;
const LAST_USED_GRANULARITY_MS = 60_000;
/**
 * Refreshes allowed per hour, per grant and per account (all its grants together). An assistant
 * refreshes about once an hour; these are far above that and only stop a runaway or abusive client
 * from minting tokens (and rows) without end. Per grant and account, not per address: the hosted
 * service's assistants call from a few shared addresses. Counted in the database (oauth_refreshes),
 * in the refresh's own transaction, so the limits hold across processes and restarts.
 */
export const REFRESHES_PER_GRANT_PER_HOUR = 30;
export const REFRESHES_PER_ACCOUNT_PER_HOUR = 120;
const HOUR_MS = 3_600_000;

export type TokenResponse = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: AssistantAccessLevel };
/** RFC 6749 §5.2: refusals are invalid_grant; a refresh over the limits is temporarily_unavailable, to retry after `retryAfter` seconds. */
export type TokenError = { error: "invalid_grant"; error_description: string } | { error: "temporarily_unavailable"; error_description: string; retryAfter: number };

type GrantRow = { id: string; account_id: string; client_id: string; client_name: string; redirect_uri: string; access: AssistantAccessLevel; resource: string; refresh_hash: string; refresh_generation: number; refresh_key_id: string; created_at: string; last_used_at: string; expires_at: string };

const fail = (error_description: string): TokenError => ({ error: "invalid_grant", error_description });

/** An OAuth principal's sessionId is this prefix plus its grant id. */
export const OAUTH_SESSION_PREFIX = "oauth:";

/** Both switches of plan/23 are on and the account is active and not being deleted. */
function accountAllows(app: App, accountId: string): boolean {
  const a = app.db.get<{ assistant_access: number }>("SELECT assistant_access FROM accounts WHERE id = ?", accountId);
  return !!a && a.assistant_access === 1 && installationEnabled(app) && isAccountUsable(app, accountId);
}

/**
 * Seconds until one more refresh fits within `max` in the last hour for this grant or account, or 0.
 * The max-th most recent refresh in the hour is the one that has to age out first.
 */
function refreshWait(app: App, column: "grant_id" | "account_id", id: string, max: number): number {
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const r = app.db.get<{ at: string }>(`SELECT at FROM oauth_refreshes WHERE ${column} = ? AND at > ? ORDER BY at DESC LIMIT 1 OFFSET ?`, id, since, max - 1);
  return r ? Math.max(1, Math.ceil((Date.parse(r.at) + HOUR_MS - Date.now()) / 1000)) : 0;
}

const REFRESH_KEY = "oauth-refresh-key";
const REFRESH_TOKEN = new RegExp(`^${REFRESH_TOKEN_PREFIX}(ogr_[0-9a-z]{26})\\.(0|[1-9][0-9]{0,8})\\.([\\w-]{43})\\.([\\w-]{43})$`);

/** The refresh token's mac, base64url. The key is read each time, so every process uses the one in the secrets folder. */
function refreshMac(app: App, grantId: string, generation: number, nonce: string): string {
  return createHmac("sha256", ensureSecret(app.config.secretsDir, REFRESH_KEY)).update(`purss oauth refresh\n${grantId}\n${generation}\n${nonce}`).digest("base64url");
}

/** Which refresh key signs a grant's tokens: a grant made under another key can't recognise its spent tokens. */
function refreshKeyId(app: App): string {
  return createHmac("sha256", ensureSecret(app.config.secretsDir, REFRESH_KEY)).update("purss oauth refresh key id").digest("base64url").slice(0, 22);
}

function newRefreshToken(app: App, grantId: string, generation: number): string {
  const nonce = randomToken(32);
  return `${REFRESH_TOKEN_PREFIX}${grantId}.${generation}.${nonce}.${refreshMac(app, grantId, generation, nonce)}`;
}

/**
 * The live grant a refresh token belongs to: its current one, or one it spent ("spent": this server
 * issued it to the grant at an earlier generation). Null for anything else, which never revokes.
 * A grant whose tokens were signed with a refresh key that is no longer the server's ("void") can't
 * tell its spent tokens from a thief's, so it ends at the first token presented for it.
 */
function refreshTokenGrant(app: App, token: string): { grant: GrantRow; spent: boolean; void: boolean } | null {
  const m = REFRESH_TOKEN.exec(token);
  if (!m) return null;
  const [, grantId = "", generation = "", nonce = "", mac = ""] = m;
  const grant = app.db.get<GrantRow>("SELECT * FROM oauth_grants WHERE id = ?", grantId);
  if (!grant) return null;
  if (!safeEqual(grant.refresh_key_id, refreshKeyId(app))) return { grant, spent: false, void: true };
  if (safeEqual(sha256(token), grant.refresh_hash)) return { grant, spent: false, void: false };
  if (Number(generation) < grant.refresh_generation && safeEqual(mac, refreshMac(app, grantId, Number(generation), nonce))) return { grant, spent: true, void: false };
  return null;
}

/** A new access token for a grant, answered together with its refresh token. Call inside a transaction. */
function respond(app: App, g: Pick<GrantRow, "id" | "access">, refreshToken: string): TokenResponse {
  const access = `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
  app.db.run("INSERT INTO oauth_access_tokens (token_hash, grant_id, expires_at) VALUES (?, ?, ?)", sha256(access), g.id, addSeconds(ACCESS_TOKEN_SECONDS));
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope: g.access };
}

/**
 * grant_type=authorization_code. The code (shared core, connect/codes.ts) is bound to the client,
 * the redirect URI it was issued for and the PKCE challenge; it is burned whatever happens.
 * `redirectUri` is null when the request leaves it out (OAuth 2.1 §10.2); when given it must match
 * exactly. A code that no longer exists but made a grant was used before: that grant is revoked.
 */
export function exchangeCode(app: App, input: { code: string; codeVerifier: string; clientId: string; redirectUri: string | null }): TokenResponse | TokenError {
  const out = redeemCode(app, { code: input.code, codeVerifier: input.codeVerifier, kind: "oauth", clientId: input.clientId, redirectUri: input.redirectUri, form: "redirect" });
  if (!out.ok) {
    if (out.reason === "unknown") {
      const replayed = app.db.get<{ id: string; account_id: string }>("SELECT id, account_id FROM oauth_grants WHERE code_hash = ?", codeHash(input.code, "redirect"));
      if (replayed) app.db.tx(() => revokeGrantRow(app, replayed, "authorization code used twice"));
    } else {
      audit(app, out.accountId, "assistant_grant_created", null, "failure", out.reason);
    }
    return fail("The authorization code isn't valid (unknown, expired, already used, or issued for another client, redirect URI or code verifier).");
  }
  const { accountId, label, scope, redirectUri } = out.grant;
  const resource = endpointFor(app);
  if (!accountAllows(app, accountId)) {
    audit(app, accountId, "assistant_grant_created", null, "failure", "assistant access off");
    return fail("Assistant access is turned off for this account or PURSS.");
  }
  return app.db.tx(() => {
    if (grantCount(app, accountId) >= MAX_GRANTS) {
      audit(app, accountId, "assistant_grant_created", null, "failure", "too many");
      return fail(`The account already has ${MAX_GRANTS} connected assistants. Disconnect one in Settings → Assistants first.`);
    }
    const now = nowIso();
    const g = { id: newId("ogr"), access: scope === "write" ? "write" as const : "read" as const };
    const refreshToken = newRefreshToken(app, g.id, 0);
    app.db.run(
      "INSERT INTO oauth_grants (id, account_id, client_id, client_name, redirect_uri, access, resource, code_hash, refresh_hash, refresh_generation, refresh_key_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
      g.id, accountId, input.clientId, label, redirectUri!, g.access, resource, codeHash(input.code, "redirect"), sha256(refreshToken), refreshKeyId(app), now, now, addSeconds(GRANT_IDLE_DAYS * 86_400),
    );
    audit(app, accountId, "assistant_grant_created", g.id, "success", `${g.access} ${hostOf(input.clientId)}`);
    return respond(app, g, refreshToken);
  });
}

/**
 * grant_type=refresh_token, with rotation. The grant's level always applies and is returned as
 * `scope`, whatever scope the request names (a client may echo what it first asked for after the
 * person allowed less). While a switch is off the refresh token is refused but kept, so it works
 * again once the switch is back on. Two refreshes with the same token are serialised by the
 * transaction: the first rotates, the second finds a spent token and revokes the grant.
 */
export function refreshTokens(app: App, input: { refreshToken: string; clientId: string }): TokenResponse | TokenError {
  const invalid = fail("The refresh token isn't valid. Connect the assistant again.");
  if (!REFRESH_TOKEN.test(input.refreshToken)) return invalid;
  return app.db.tx(() => {
    const found = refreshTokenGrant(app, input.refreshToken);
    if (!found) return invalid;
    const row = found.grant;
    if (found.spent || found.void) {
      revokeGrantRow(app, row, found.spent ? "refresh token used twice" : "refresh key changed");
      return invalid;
    }
    if (row.client_id !== input.clientId || row.expires_at <= nowIso()) return invalid;
    // Tokens are for this server's /mcp address; a grant made under another public address is void.
    if (row.resource !== endpointFor(app)) return invalid;
    if (!accountAllows(app, row.account_id)) return fail("Assistant access is turned off for this account or PURSS.");
    // Checked before the token is spent, so a refused refresh can be retried with the same token.
    const wait = Math.max(refreshWait(app, "grant_id", row.id, REFRESHES_PER_GRANT_PER_HOUR), refreshWait(app, "account_id", row.account_id, REFRESHES_PER_ACCOUNT_PER_HOUR));
    if (wait) return { error: "temporarily_unavailable", error_description: "Too many token refreshes for this assistant or account in the last hour. Try again later.", retryAfter: wait };
    const now = nowIso();
    const generation = row.refresh_generation + 1;
    const refreshToken = newRefreshToken(app, row.id, generation);
    app.db.run("INSERT INTO oauth_refreshes (account_id, grant_id, at) VALUES (?, ?, ?)", row.account_id, row.id, now);
    app.db.run("UPDATE oauth_grants SET refresh_hash = ?, refresh_generation = ?, expires_at = ?, last_used_at = ? WHERE id = ?",
      sha256(refreshToken), generation, addSeconds(GRANT_IDLE_DAYS * 86_400), now, row.id);
    return respond(app, row, refreshToken);
  });
}

/**
 * RFC 7009: revoke the grant behind an access token or a current or spent refresh token. Holding the
 * token is the proof (the clients are public, so there is no secret to check), and revoking a
 * stolen token only helps. Unknown tokens are not an error.
 */
export function revokeByToken(app: App, token: string): void {
  app.db.tx(() => {
    const g = token.startsWith(ACCESS_TOKEN_PREFIX)
      ? app.db.get<{ id: string; account_id: string }>("SELECT g.id, g.account_id FROM oauth_access_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?", sha256(token))
      : refreshTokenGrant(app, token)?.grant; // a void grant ends whoever asks: it could never refresh again
    if (g) revokeGrantRow(app, g, "revoked by the assistant");
  });
}

/**
 * The caller behind an access token at /mcp, or why not. Same outcomes as a personal access token:
 * "invalid" (401) for unknown, expired, revoked, another resource's or a suspended or deleting account's token,
 * or when OAuth is off on this installation; "off" (403) while a plan/23 switch is off.
 */
export function resolveAccessToken(app: App, secret: string): AssistantCaller | { error: "invalid" | "off" } {
  if (!app.config.assistantOAuth || !secret.startsWith(ACCESS_TOKEN_PREFIX)) return { error: "invalid" };
  const now = nowIso();
  const row = app.db.get<{ grant_id: string; account_id: string; access: AssistantAccessLevel; resource: string; last_used_at: string; assistant_access: number; workspace_id: string }>(
    `SELECT g.id AS grant_id, g.account_id, g.access, g.resource, g.last_used_at, a.assistant_access, w.id AS workspace_id
     FROM oauth_access_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN accounts a ON a.id = g.account_id JOIN workspaces w ON w.account_id = a.id
     WHERE t.token_hash = ? AND t.expires_at > ?`, sha256(secret), now);
  // Audience (RFC 8707): only tokens issued for this server's /mcp address.
  if (!row || !isAccountUsable(app, row.account_id) || row.resource !== endpointFor(app)) return { error: "invalid" };
  if (!installationEnabled(app) || row.assistant_access !== 1) return { error: "off" };
  if (Date.now() - Date.parse(row.last_used_at) > LAST_USED_GRANULARITY_MS) app.db.run("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", now, row.grant_id);
  return {
    principal: { accountId: row.account_id, workspaceId: row.workspace_id, isAdmin: false, sessionId: `${OAUTH_SESSION_PREFIX}${row.grant_id}`, csrf: "", authAt: new Date(0).toISOString() },
    access: row.access,
    tokenId: row.grant_id,
  };
}

/** Drop expired access tokens and grants, and refreshes older than the limits' hour (maintenance tick). */
export function purgeOAuth(app: App): void {
  const now = nowIso();
  app.db.run("DELETE FROM oauth_refreshes WHERE at <= ?", new Date(Date.now() - HOUR_MS).toISOString());
  app.db.run("DELETE FROM oauth_access_tokens WHERE expires_at <= ?", now);
  app.db.run("DELETE FROM oauth_grants WHERE expires_at <= ?", now);
}
