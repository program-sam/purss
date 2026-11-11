import * as client from "openid-client";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";
import { randomToken, safeEqual, sha256 } from "../secrets.ts";
import type { OidcProviderConfig } from "../config.ts";
import { emailSchema } from "../services/account-email.ts";
import { assertSignupCapacity, emailInUse, openSignupAttempt, refreshAuth, sessionWrite, signupWithProvider } from "./accounts.ts";
import { signupOpen } from "../mail/mailer.ts";
import { DEVICE_SESSION_PREFIX } from "../connect/devices.ts";

/**
 * External sign-in via OpenID Connect (authorization code + PKCE + state + nonce). Identities bind by validated
 * issuer + subject, never by email. Three purposes:
 * - signin: an identity already linked to an account signs in. An identity nobody linked creates an account when
 *   sign-up is open and the provider vouches for an email address no account has; there is no automatic linking.
 * - link: a signed-in account adds the identity as a way to sign in (recent authentication required).
 * - stepup: a signed-in account proves again that it is the person behind a linked identity, which refreshes the
 *   session's (or connected app's) recent authentication ("confirm it's you"), for an account with no password or passkey too.
 */

export type OidcPurpose = "signin" | "link" | "stepup";

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

/** A provider's ID token may be dated a little before the request was sent (clock differences). */
const AUTH_TIME_SKEW_MS = 60_000;
/** How long an app's ticket for opening the system browser stays good. */
const TICKET_SECONDS = 5 * 60;

type ChallengeData = {
  verifier: string; providerId: string; binder: string; sharedComputer?: boolean; sessionId?: string | null;
  /** When the request was made (ms): a step-up's ID token must show a sign-in after it. */
  startedAt?: number; stepUp?: "reauthenticate" | "choose-account";
  /** Started from a connected app's ticket: the browser that finishes it has no session of its own. */
  viaApp?: boolean;
};

/** Whether the account has a sign-in with this provider (issuer) linked. */
function linkedTo(app: App, accountId: string, p: OidcProviderConfig): boolean {
  return !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'oidc' AND issuer = ?", accountId, p.issuer);
}

/**
 * `binder` is a random value also set as an HttpOnly cookie on the starting browser; the
 * callback must present it, so a callback URL can't be replayed in someone else's browser.
 */
export async function startOidc(
  app: App, providerId: string, purpose: OidcPurpose, accountId: string | null, binder: string,
  options: { sharedComputer?: boolean; sessionId?: string | null; viaApp?: boolean } = {},
): Promise<string> {
  const p = provider(app, providerId);
  if (purpose === "stepup" && (!accountId || !linkedTo(app, accountId, p))) {
    throw new HttpError(409, "not_linked", `${p.label} isn't connected to this account, so it can't confirm it's you.`);
  }
  const config = await discovery(p);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const stepUp = p.stepUp ?? "reauthenticate";
  const data: ChallengeData = {
    verifier, providerId, binder: sha256(binder), sharedComputer: options.sharedComputer === true, sessionId: options.sessionId ?? null,
    startedAt: Date.now(), ...(purpose === "stepup" ? { stepUp } : {}), ...(options.viaApp ? { viaApp: true } : {}),
  };
  app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    `oidc:${state}`, `oidc-${purpose}`, accountId, nonce, JSON.stringify(data), addSeconds(600));
  const params: Record<string, string> = {
    redirect_uri: callbackUrl(app, providerId),
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  };
  // "Confirm it's you" asks the provider to check the person again; on a shared computer a sign-in always offers the account choice.
  if (purpose === "stepup") Object.assign(params, stepUp === "choose-account" ? { prompt: "select_account" } : { prompt: "login", max_age: "0" });
  else if (purpose === "signin" && options.sharedComputer) params.prompt = "select_account";
  return client.buildAuthorizationUrl(config, params).href;
}

/**
 * A connected app can't run the provider's page itself (Google refuses embedded web views), so it asks for a single-use ticket
 * and opens `/api/auth/oidc/<id>/start?ticket=…` in the system browser. The ticket names the app's connection; whoever finishes
 * the flow must sign in at the provider as an identity already linked to that account.
 */
export function issueAppTicket(app: App, providerId: string, purpose: "link" | "stepup", accountId: string, appSessionId: string): string {
  const p = provider(app, providerId);
  if (!appSessionId.startsWith(DEVICE_SESSION_PREFIX)) throw new HttpError(400, "not_device", "This is for connected apps.");
  if (purpose === "stepup" && !linkedTo(app, accountId, p)) throw new HttpError(409, "not_linked", `${p.label} isn't connected to this account, so it can't confirm it's you.`);
  const ticket = randomToken(24);
  app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, data, expires_at) VALUES (?, 'oidc-ticket', ?, '', ?, ?)",
    `oidc-ticket:${sha256(ticket)}`, accountId, JSON.stringify({ providerId, purpose, sessionId: appSessionId }), addSeconds(TICKET_SECONDS));
  return `${app.config.publicOrigin}/api/auth/oidc/${encodeURIComponent(providerId)}/start?ticket=${encodeURIComponent(ticket)}`;
}

/** Spend an app's ticket in the browser it was opened in: starts the flow it was issued for. */
export async function startFromTicket(app: App, providerId: string, ticket: string, binder: string): Promise<string> {
  const id = `oidc-ticket:${sha256(ticket)}`;
  const row = app.db.get<{ account_id: string; data: string; expires_at: string }>("SELECT account_id, data, expires_at FROM auth_challenges WHERE id = ? AND purpose = 'oidc-ticket'", id);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", id);
  const data = row ? JSON.parse(row.data) as { providerId: string; purpose: "link" | "stepup"; sessionId: string } : null;
  if (!row || !data || row.expires_at < nowIso() || data.providerId !== providerId) {
    throw new HttpError(400, "expired", "That link has expired or was already used. Start again from the app.");
  }
  return startOidc(app, providerId, data.purpose, row.account_id, binder, { sessionId: data.sessionId, viaApp: true });
}

export type OidcResult = {
  purpose: OidcPurpose; accountId: string; sharedComputer: boolean;
  /** The sign-in made a new account. */
  created: boolean;
  /** The flow was started from a connected app: the browser has no session to return to. */
  viaApp: boolean;
};

/** Who is finishing the flow: its binder cookie, the browser's session, and where the request came from. */
export type OidcCaller = { binder: string; accountId: string | null; sessionId: string | null; address: string };

const failed = () => new HttpError(401, "oidc_failed", "Signing in with that provider didn't work. Please try again.");

/** The provider's verified email address for an account it creates, or null when it gave none or doesn't vouch for it. */
function verifiedEmail(claims: client.IDToken): string | null {
  if (claims.email_verified !== true || typeof claims.email !== "string") return null;
  const parsed = emailSchema.safeParse(claims.email);
  return parsed.success ? parsed.data : null;
}

function displayName(claims: client.IDToken): string | null {
  if (typeof claims.name !== "string") return null;
  const name = [...claims.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()].slice(0, 60).join("").trim();
  return name || null;
}

/** Completes the flow; the caller starts the session (signin) or sends the person on. */
export async function finishOidc(app: App, providerId: string, currentUrl: URL, caller: OidcCaller): Promise<OidcResult> {
  const p = provider(app, providerId);
  const state = currentUrl.searchParams.get("state") ?? "";
  const row = app.db.get<{ purpose: string; account_id: string | null; challenge: string; data: string; expires_at: string }>(
    "SELECT purpose, account_id, challenge, data, expires_at FROM auth_challenges WHERE id = ?", `oidc:${state}`);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", `oidc:${state}`);
  if (!row || row.expires_at < nowIso()) throw new HttpError(400, "expired", "That sign-in took too long or was already used. Please try again.");
  const data = JSON.parse(row.data) as ChallengeData;
  if (data.providerId !== providerId || !caller.binder || !safeEqual(sha256(caller.binder), data.binder)) {
    throw new HttpError(400, "mismatch", "That sign-in didn't start in this browser. Please try again.");
  }
  const purpose = row.purpose.slice("oidc-".length) as OidcPurpose;
  const viaApp = data.viaApp === true;
  // Linking and confirming finish in the browser where they started and where the account is signed in: the same session. A
  // flow an app started has no session in this browser; its ticket named the app's connection, and the identity checked below
  // must belong to that account.
  if (purpose !== "signin" && !viaApp && (!caller.accountId || caller.accountId !== row.account_id)) {
    throw new HttpError(400, "mismatch", "Please finish in the browser where you're signed in.");
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
    throw failed();
  }
  if (!claims?.sub || !claims.iss) throw failed();
  const existing = app.db.get<{ account_id: string }>("SELECT account_id FROM sign_in_methods WHERE kind = 'oidc' AND issuer = ? AND subject = ?", claims.iss, claims.sub);

  if (purpose === "link") {
    if (!row.account_id || !data.sessionId) throw new HttpError(400, "expired", "Please sign in first.");
    if (!viaApp && caller.sessionId !== data.sessionId) throw new HttpError(401, "signed_out", "Please sign in again.");
    sessionWrite(app, row.account_id, data.sessionId, () => {
      if (existing && existing.account_id !== row.account_id) throw new HttpError(409, "linked_elsewhere", "That external account is already used by another PURSS.");
      if (!existing) {
        app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES (?, ?, 'oidc', ?, ?, ?, ?)",
          newId("sim"), row.account_id, p.label, claims.iss, claims.sub, nowIso());
        audit(app, row.account_id, "oidc_link", providerId, "success");
      }
    });
    return { purpose, accountId: row.account_id, sharedComputer: false, created: false, viaApp };
  }

  if (purpose === "stepup") {
    if (!row.account_id || !data.sessionId) throw new HttpError(400, "expired", "Please sign in first.");
    if (!viaApp && caller.sessionId !== data.sessionId) throw new HttpError(401, "signed_out", "Please sign in again.");
    // The identity that signed in must be one this account has linked: another Google account can't confirm it.
    if (existing?.account_id !== row.account_id) {
      audit(app, row.account_id, "oidc_step_up", providerId, "failure", "another identity");
      throw new HttpError(403, "wrong_account", `That ${p.label} account isn't the one connected to this PURSS account.`);
    }
    // A provider that re-authenticated says when; one that shows the person signed in before this request didn't ask again.
    if (data.stepUp === "reauthenticate" && typeof claims.auth_time === "number" && claims.auth_time * 1000 < (data.startedAt ?? 0) - AUTH_TIME_SKEW_MS) {
      audit(app, row.account_id, "oidc_step_up", providerId, "failure", "stale auth_time");
      throw new HttpError(401, "stale_auth", `${p.label} didn't ask you to sign in again, so it can't confirm it's you. Try again.`);
    }
    const sessionId = data.sessionId;
    sessionWrite(app, row.account_id, sessionId, () => refreshAuth(app, sessionId));
    app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE kind = 'oidc' AND issuer = ? AND subject = ?", nowIso(), claims.iss, claims.sub);
    audit(app, row.account_id, "oidc_step_up", providerId, "success");
    return { purpose, accountId: row.account_id, sharedComputer: false, created: false, viaApp };
  }

  // Signing in.
  if (existing) {
    app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE kind = 'oidc' AND issuer = ? AND subject = ?", nowIso(), claims.iss, claims.sub);
    return { purpose, accountId: existing.account_id, sharedComputer: data.sharedComputer === true, created: false, viaApp: false };
  }
  // An identity nobody linked: with open sign-up it makes an account, under the same limits as signing up with a password.
  if (!signupOpen(app)) {
    audit(app, null, "oidc", providerId, "failure", "identity not linked");
    throw new HttpError(403, "not_linked", `That ${p.label} account isn't connected to a PURSS here. Sign in another way and connect it in Settings first.`);
  }
  const attemptRetryAt = openSignupAttempt(app, caller.address);
  const email = verifiedEmail(claims);
  if (!email) {
    audit(app, null, "oidc", providerId, "failure", "no verified email");
    throw new HttpError(403, "email_unverified", `${p.label} didn't give PURSS a verified email address, so it can't make an account from it.`);
  }
  // Never linked or duplicated by email: someone who already has an account links the provider in Settings → Security.
  if (emailInUse(app, email)) {
    audit(app, null, "oidc", providerId, "failure", "email in use");
    throw new HttpError(409, "email_in_use", `An account with this email address already exists. Sign in with your username and password, then connect ${p.label} in Settings → Security.`);
  }
  assertSignupCapacity(app, caller.address, attemptRetryAt);
  const { accountId } = signupWithProvider(app, { displayName: displayName(claims), email, label: p.label, issuer: claims.iss, subject: claims.sub }, caller.address, attemptRetryAt);
  return { purpose, accountId, sharedComputer: data.sharedComputer === true, created: true, viaApp: false };
}
