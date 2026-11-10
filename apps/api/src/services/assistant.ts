import type { z } from "zod";
import { newId } from "@purss/domain";
import type { AdminAssistantAccess, AssistantAccess, AssistantAccessLevel, AssistantGrantDTO, AssistantTokenCreated, AssistantTokenDTO, assistantTokenCreateSchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit, requireRecentAuth } from "../app.ts";
import { HttpError, addSeconds, notFound, nowIso } from "../http.ts";
import { getInstallation, setInstallation } from "../auth/accounts.ts";
import { randomToken, sha256 } from "../secrets.ts";
import { isAccountUsable } from "./deletion.ts";

/*
 * Assistant access (MCP, plan/23): an AI assistant reaches a PURSS through /mcp with a personal
 * access token. Three things must all be true for a token to work: the administrator turned it on
 * for the installation, the account turned it on for itself, and the token exists and hasn't expired.
 * Only a token's SHA-256 is stored; the secret is shown once. A token is never an administrator and
 * never counts as a recent sign-in, so it can't reach administration or account security.
 *
 * Where the installation offers it (hosted mode, or PURSS_ASSISTANT_OAUTH=on), assistants that only
 * accept OAuth connect through a consent page instead (oauth/, plan/33). Each approval is a grant,
 * listed and revoked here next to the tokens and gated by the same two switches.
 */

const INSTALLATION_KEY = "assistant_access";
export const TOKEN_PREFIX = "purss_mcp_";
const MAX_TOKENS = 20;
export const MAX_GRANTS = 20;
/** last_used_at is written at most this often per token. */
const LAST_USED_GRANULARITY_MS = 60_000;

export function installationEnabled(app: App): boolean {
  return getInstallation(app, INSTALLATION_KEY) === "on";
}

export function endpointFor(app: App): string {
  return `${app.config.publicOrigin}/mcp`;
}

type TokenRow = { id: string; name: string; access: AssistantAccessLevel; created_at: string; expires_at: string | null; last_used_at: string | null };
const toDTO = (r: TokenRow): AssistantTokenDTO => ({ id: r.id, name: r.name, access: r.access, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at });

export function getAccess(app: App, p: Principal): AssistantAccess {
  const enabled = app.db.get<{ assistant_access: number }>("SELECT assistant_access FROM accounts WHERE id = ?", p.accountId)?.assistant_access === 1;
  const tokens = app.db.all<TokenRow>("SELECT id, name, access, created_at, expires_at, last_used_at FROM assistant_tokens WHERE account_id = ? ORDER BY created_at", p.accountId).map(toDTO);
  return { available: installationEnabled(app), enabled, endpoint: endpointFor(app), oauth: app.config.assistantOAuth, tokens, grants: listGrants(app, p) };
}

/** The account's own switch. Turning it off revokes every token it made and every assistant it approved. */
export function setEnabled(app: App, p: Principal, enabled: boolean): AssistantAccess {
  if (enabled && !installationEnabled(app)) throw new HttpError(403, "assistant_unavailable", "Your administrator hasn't turned on assistant access for this PURSS.");
  app.db.tx(() => {
    app.db.run("UPDATE accounts SET assistant_access = ? WHERE id = ?", enabled ? 1 : 0, p.accountId);
    if (!enabled) revokeAllTokens(app, p.accountId);
    audit(app, p.accountId, enabled ? "assistant_access_on" : "assistant_access_off", p.accountId, "success");
  });
  return getAccess(app, p);
}

/** A new token: needs a recent sign-in, like other new credentials. The secret is returned once. */
export function createToken(app: App, p: Principal, input: z.infer<typeof assistantTokenCreateSchema>): AssistantTokenCreated {
  const access = getAccess(app, p);
  if (!access.available) throw new HttpError(403, "assistant_unavailable", "Your administrator hasn't turned on assistant access for this PURSS.");
  if (!access.enabled) throw new HttpError(403, "assistant_off", "Turn on assistant access first.");
  requireRecentAuth(p);
  if (access.tokens.length >= MAX_TOKENS) throw new HttpError(409, "too_many_tokens", `You can have up to ${MAX_TOKENS} tokens. Revoke one you no longer use first.`);
  const secret = `${TOKEN_PREFIX}${randomToken(32)}`;
  const row: TokenRow = {
    id: newId("tok"), name: input.name, access: input.access, created_at: nowIso(),
    expires_at: input.expiresInDays === null ? null : addSeconds(input.expiresInDays * 86_400), last_used_at: null,
  };
  app.db.tx(() => {
    app.db.run("INSERT INTO assistant_tokens (id, account_id, name, access, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.id, p.accountId, row.name, row.access, sha256(secret), row.created_at, row.expires_at);
    audit(app, p.accountId, "assistant_token_created", row.id, "success", row.access);
  });
  return { token: toDTO(row), secret };
}

export function revokeToken(app: App, p: Principal, id: string): { ok: true } {
  const r = app.db.run("DELETE FROM assistant_tokens WHERE id = ? AND account_id = ?", id, p.accountId);
  if (!r.changes) throw notFound("That token");
  audit(app, p.accountId, "assistant_token_revoked", id, "success");
  return { ok: true };
}

/**
 * Revoke every token and OAuth grant of an account, and OAuth codes not yet exchanged (its own switch
 * turned off; signing out everywhere, auth/sign-out.ts). Returns how many tokens and grants.
 */
export function revokeAllTokens(app: App, accountId: string): number {
  app.db.run("DELETE FROM connect_codes WHERE account_id = ? AND kind = 'oauth'", accountId);
  return app.db.run("DELETE FROM assistant_tokens WHERE account_id = ?", accountId).changes
    + app.db.run("DELETE FROM oauth_grants WHERE account_id = ?", accountId).changes;
}

// ---------- assistants connected with OAuth (plan/33) ----------

type GrantRow = { id: string; client_id: string; client_name: string; redirect_uri: string; access: AssistantAccessLevel; created_at: string; last_used_at: string };
export const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

export function grantCount(app: App, accountId: string): number {
  return app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants WHERE account_id = ? AND expires_at > ?", accountId, nowIso())!.n;
}

export function listGrants(app: App, p: Principal): AssistantGrantDTO[] {
  return app.db.all<GrantRow>("SELECT id, client_id, client_name, redirect_uri, access, created_at, last_used_at FROM oauth_grants WHERE account_id = ? AND expires_at > ? ORDER BY created_at, id", p.accountId, nowIso())
    .map((g) => ({ id: g.id, clientName: g.client_name, clientHost: hostOf(g.client_id), redirectHost: hostOf(g.redirect_uri), access: g.access, createdAt: g.created_at, lastUsedAt: g.last_used_at }));
}

/** Delete a grant (its tokens go with it) and record why. */
export function revokeGrantRow(app: App, g: { id: string; account_id: string }, why: string): void {
  app.db.run("DELETE FROM oauth_grants WHERE id = ?", g.id);
  audit(app, g.account_id, "assistant_grant_revoked", g.id, "success", why);
}

export function revokeGrant(app: App, p: Principal, id: string): { ok: true } {
  const g = app.db.get<{ id: string; account_id: string }>("SELECT id, account_id FROM oauth_grants WHERE id = ? AND account_id = ?", id, p.accountId);
  if (!g) throw notFound("That assistant");
  app.db.tx(() => revokeGrantRow(app, g, "revoked in Settings"));
  return { ok: true };
}

export type AssistantCaller = { principal: Principal; access: AssistantAccessLevel; tokenId: string };
/** An assistant principal's sessionId is this prefix plus its token id. */
export const ASSISTANT_SESSION_PREFIX = "assistant:";

/**
 * Resolve a bearer token to the account it acts for, or explain why not. The principal is scoped to
 * the account's PURSS like a signed-in session, but is never an administrator and never counts
 * as a recent sign-in.
 */
export function resolveToken(app: App, authorization: string | undefined): AssistantCaller | { error: "missing" | "invalid" | "off" } {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return { error: "missing" };
  const secret = m[1]!;
  if (!secret.startsWith(TOKEN_PREFIX)) return { error: "invalid" };
  const row = app.db.get<{ id: string; account_id: string; access: AssistantAccessLevel; expires_at: string | null; last_used_at: string | null; assistant_access: number; workspace_id: string }>(
    `SELECT t.id, t.account_id, t.access, t.expires_at, t.last_used_at, a.assistant_access, w.id AS workspace_id
     FROM assistant_tokens t JOIN accounts a ON a.id = t.account_id JOIN workspaces w ON w.account_id = a.id WHERE t.token_hash = ?`, sha256(secret));
  if (!row || !isAccountUsable(app, row.account_id) || (row.expires_at !== null && row.expires_at <= nowIso())) return { error: "invalid" };
  if (!installationEnabled(app) || row.assistant_access !== 1) return { error: "off" };
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > LAST_USED_GRANULARITY_MS) {
    app.db.run("UPDATE assistant_tokens SET last_used_at = ? WHERE id = ?", nowIso(), row.id);
  }
  return {
    principal: { accountId: row.account_id, workspaceId: row.workspace_id, isAdmin: false, sessionId: `${ASSISTANT_SESSION_PREFIX}${row.id}`, csrf: "", authAt: new Date(0).toISOString() },
    access: row.access,
    tokenId: row.id,
  };
}

// ---------- administration ----------

export function adminAccess(app: App): AdminAssistantAccess {
  return {
    enabled: installationEnabled(app),
    oauth: app.config.assistantOAuth,
    accountsEnabled: app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts WHERE assistant_access = 1")!.n,
    tokens: app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_tokens")!.n,
    grants: app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants WHERE expires_at > ?", nowIso())!.n,
  };
}

/** The installation switch. Off makes every token and grant stop working at once; they are kept for when it's back on. */
export function setInstallationEnabled(app: App, admin: Principal, enabled: boolean): AdminAssistantAccess {
  app.db.tx(() => {
    setInstallation(app, INSTALLATION_KEY, enabled ? "on" : "off");
    audit(app, admin.accountId, enabled ? "assistant_installation_on" : "assistant_installation_off", null, "success");
  });
  return adminAccess(app);
}
