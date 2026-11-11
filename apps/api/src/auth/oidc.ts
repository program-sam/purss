import * as client from "openid-client";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";
import { safeEqual, sha256 } from "../secrets.ts";
import type { OidcProviderConfig } from "../config.ts";
import { sessionWrite } from "./accounts.ts";

/**
 * External sign-in via OpenID Connect (authorization code + PKCE + state + nonce).
 * Identities bind by validated issuer + subject, never by email. Sign-in only works
 * for an identity the account linked while signed in; there is no automatic linking.
 */
const configs = new Map<string, Promise<client.Configuration>>();

function provider(app: App, id: string): OidcProviderConfig {
  const p = app.config.oidc.find((x) => x.id === id);
  if (!p) throw new HttpError(404, "not_found", "That sign-in option isn't set up here.");
  return p;
}

function discovery(p: OidcProviderConfig): Promise<client.Configuration> {
  // Keyed by issuer and client too, so a changed provider configuration is never served stale.
  const key = JSON.stringify([p.id, p.issuer, p.clientId]);
  let c = configs.get(key);
  if (!c) {
    const options = new URL(p.issuer).protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;
    c = client.discovery(new URL(p.issuer), p.clientId, p.clientSecret, undefined, options);
    c.catch(() => configs.delete(key));
    configs.set(key, c);
  }
  return c;
}

const callbackUrl = (app: App, id: string) => `${app.config.publicOrigin}/api/auth/oidc/${encodeURIComponent(id)}/callback`;

/**
 * `binder` is a random value also set as an HttpOnly cookie on the starting browser; the
 * callback must present it, so a callback URL can't be replayed in someone else's browser.
 */
export async function startOidc(
  app: App, providerId: string, purpose: "signin" | "link", accountId: string | null, binder: string,
  options: { sharedComputer?: boolean; sessionId?: string | null } = {},
): Promise<string> {
  const p = provider(app, providerId);
  const config = await discovery(p);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    `oidc:${state}`, `oidc-${purpose}`, accountId, nonce,
    JSON.stringify({ verifier, providerId, binder: sha256(binder), sharedComputer: options.sharedComputer === true, sessionId: options.sessionId ?? null }), addSeconds(600));
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(app, providerId),
    scope: "openid",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return url.href;
}

/** Completes the flow. Returns the account to sign in, or the linked account for "link". */
export async function finishOidc(app: App, providerId: string, currentUrl: URL, binder: string, signedInAccountId: string | null, signedInSessionId: string | null = null): Promise<{ purpose: "signin" | "link"; accountId: string; sharedComputer: boolean }> {
  const p = provider(app, providerId);
  const state = currentUrl.searchParams.get("state") ?? "";
  const row = app.db.get<{ purpose: string; account_id: string | null; challenge: string; data: string; expires_at: string }>(
    "SELECT purpose, account_id, challenge, data, expires_at FROM auth_challenges WHERE id = ?", `oidc:${state}`);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", `oidc:${state}`);
  if (!row || row.expires_at < nowIso()) throw new HttpError(400, "expired", "That sign-in took too long or was already used. Please try again.");
  const data = JSON.parse(row.data) as { verifier: string; providerId: string; binder: string; sharedComputer?: boolean; sessionId?: string | null };
  if (data.providerId !== providerId || !binder || !safeEqual(sha256(binder), data.binder)) {
    throw new HttpError(400, "mismatch", "That sign-in didn't start in this browser. Please try again.");
  }
  if (row.purpose === "oidc-link" && (!signedInAccountId || signedInAccountId !== row.account_id)) {
    throw new HttpError(400, "mismatch", "Please finish connecting in the browser where you're signed in.");
  }
  const config = await discovery(p);
  let claims;
  try {
    const tokens = await client.authorizationCodeGrant(config, new URL(currentUrl.pathname + currentUrl.search, app.config.publicOrigin), {
      pkceCodeVerifier: data.verifier,
      expectedState: state,
      expectedNonce: row.challenge,
      idTokenExpected: true,
    });
    claims = tokens.claims();
  } catch {
    audit(app, row.account_id, "oidc", providerId, "failure");
    throw new HttpError(401, "oidc_failed", "Signing in with that provider didn't work. Please try again.");
  }
  if (!claims?.sub || !claims.iss) throw new HttpError(401, "oidc_failed", "Signing in with that provider didn't work. Please try again.");
  const existing = app.db.get<{ account_id: string }>("SELECT account_id FROM sign_in_methods WHERE kind = 'oidc' AND issuer = ? AND subject = ?", claims.iss, claims.sub);
  if (row.purpose === "oidc-link") {
    if (!row.account_id) throw new HttpError(400, "expired", "Please sign in first.");
    if (!signedInSessionId || data.sessionId !== signedInSessionId) throw new HttpError(401, "signed_out", "Please sign in again.");
    sessionWrite(app, row.account_id, signedInSessionId, () => {
      if (existing && existing.account_id !== row.account_id) throw new HttpError(409, "linked_elsewhere", "That external account is already used by another PURSS.");
      if (!existing) {
        app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES (?, ?, 'oidc', ?, ?, ?, ?)",
          newId("sim"), row.account_id, p.label, claims.iss, claims.sub, nowIso());
        audit(app, row.account_id, "oidc_link", providerId, "success");
      }
    });
    return { purpose: "link", accountId: row.account_id, sharedComputer: false };
  }
  if (!existing) {
    audit(app, null, "oidc", providerId, "failure", "identity not linked");
    throw new HttpError(403, "not_linked", "That account isn't connected to a PURSS here. Sign in another way and connect it in Settings first.");
  }
  app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE kind = 'oidc' AND issuer = ? AND subject = ?", nowIso(), claims.iss, claims.sub);
  return { purpose: "signin", accountId: existing.account_id, sharedComputer: data.sharedComputer === true };
}
