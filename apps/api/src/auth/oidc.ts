import { createHash } from "node:crypto";
import * as client from "openid-client";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, nowIso } from "../http.ts";
import { randomToken, safeEqual, sha256 } from "../secrets.ts";
import { issuerKey } from "../config.ts";
import type { OidcProviderConfig } from "../config.ts";
import { emailSchema } from "../services/account-email.ts";
import { openSignupAttempt, refreshAuth, sessionWrite, signupWithProvider } from "./accounts.ts";
import { canConfirm, linkedProviders } from "./providers.ts";
import { signupOpen } from "../mail/mailer.ts";
import { DEVICE_SESSION_PREFIX } from "../connect/devices.ts";

/**
 * External sign-in via OpenID Connect (authorization code + PKCE + state + nonce). Identities bind by validated
 * issuer + subject, never by email. Three purposes:
 * - signin: an identity already linked to an account signs in. An identity nobody linked creates an account when
 *   sign-up is open and the provider vouches for an email address no account has; there is no automatic linking.
 * - link: a signed-in account adds the identity as a way to sign in (recent authentication required). A connected app's link
 *   never completes in the browser: the browser hands the app a single-use code, and the app redeems it with its own token and
 *   the verifier it made, so only the app that asked (on the device that opened the browser) can link what was signed in.
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
/** How long an app's ticket for opening the system browser, and the code the browser hands back for a link, stay good. */
const TICKET_SECONDS = 5 * 60;
const LINK_CODE_SECONDS = 5 * 60;

type ChallengeData = {
  verifier: string; providerId: string; binder: string; sharedComputer?: boolean; sessionId?: string | null;
  /** When the request was made (ms): a step-up's ID token must show a sign-in after it. */
  startedAt?: number; stepUp?: "reauthenticate" | "choose-account";
  /** Started from a connected app's ticket: the browser that finishes it has no session of its own. */
  viaApp?: boolean;
  /** An app's link: what the app will redeem the code with (the challenge of its verifier) and the state it matches the answer by. */
  appLink?: { challenge: string; state: string };
  /** A sign-in the phone app or desktop app opened (it ends on the approval page): its failures are shown for the app, not as the web page. */
  appReturn?: boolean;
};

/** Whether the account has a sign-in with this provider linked (the issuer addresses compared as such, not as typed). */
function linkedTo(app: App, accountId: string, p: OidcProviderConfig): boolean {
  return linkedProviders(app, accountId).some((x) => issuerKey(x.issuer) === issuerKey(p.issuer));
}

/** Confirming it's you with this provider: it must be linked, and able to confirm this account (see canConfirm). */
function assertMayConfirm(app: App, accountId: string | null, p: OidcProviderConfig): void {
  if (!accountId || !linkedTo(app, accountId, p)) throw new HttpError(409, "not_linked", `${p.label} isn't connected to this account, so it can't confirm it's you.`);
  if (!canConfirm(app, accountId, p)) {
    throw new HttpError(409, "confirm_another_way", `Confirm it's you with your password or your fingerprint, face or screen lock instead: ${p.label} can only confirm an account that has neither.`);
  }
}

/**
 * `binder` is a random value also set as an HttpOnly cookie on the starting browser; the
 * callback must present it, so a callback URL can't be replayed in someone else's browser.
 */
export async function startOidc(
  app: App, providerId: string, purpose: OidcPurpose, accountId: string | null, binder: string,
  options: { sharedComputer?: boolean; sessionId?: string | null; viaApp?: boolean; appLink?: ChallengeData["appLink"]; appReturn?: boolean } = {},
): Promise<string> {
  const p = provider(app, providerId);
  if (purpose === "stepup") assertMayConfirm(app, accountId, p);
  const config = await discovery(p);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const stepUp = p.stepUp;
  const data: ChallengeData = {
    verifier, providerId, binder: sha256(binder), sharedComputer: options.sharedComputer === true, sessionId: options.sessionId ?? null,
    startedAt: Date.now(), ...(purpose === "stepup" ? { stepUp } : {}), ...(options.viaApp ? { viaApp: true } : {}),
    ...(options.appLink ? { appLink: options.appLink } : {}), ...(options.appReturn ? { appReturn: true } : {}),
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

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * A connected app can't run the provider's page itself (Google refuses embedded web views), so it asks for a single-use ticket
 * and opens `/api/auth/oidc/<id>/start?ticket=…` in the system browser. The ticket names the app's connection. Confirming
 * refreshes that connection once the identity that signs in is one linked to its account. Linking takes a `link` of the app's own
 * (the S256 challenge of a verifier only it holds, and a state): the browser can't link anything; see redeemLinkCode.
 */
export function issueAppTicket(
  app: App, providerId: string, purpose: "link" | "stepup", accountId: string, appSessionId: string, link?: { challenge: string; state: string },
): string {
  const p = provider(app, providerId);
  if (!appSessionId.startsWith(DEVICE_SESSION_PREFIX)) throw new HttpError(400, "not_device", "This is for connected apps.");
  if (purpose === "stepup") assertMayConfirm(app, accountId, p);
  if (purpose === "link" && (!link || link.challenge.length !== 43 || !B64URL.test(link.challenge) || link.state.length < 16 || link.state.length > 128 || !B64URL.test(link.state))) {
    throw new HttpError(400, "bad_request", "Linking from an app needs its code challenge and state.");
  }
  const ticket = randomToken(24);
  app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, data, expires_at) VALUES (?, 'oidc-ticket', ?, '', ?, ?)",
    `oidc-ticket:${sha256(ticket)}`, accountId, JSON.stringify({ providerId, purpose, sessionId: appSessionId, ...(purpose === "link" ? { appLink: link } : {}) }), addSeconds(TICKET_SECONDS));
  return `${app.config.publicOrigin}/api/auth/oidc/${encodeURIComponent(providerId)}/start?ticket=${encodeURIComponent(ticket)}`;
}

/** Spend an app's ticket in the browser it was opened in: starts the flow it was issued for. */
export async function startFromTicket(app: App, providerId: string, ticket: string, binder: string): Promise<string> {
  const id = `oidc-ticket:${sha256(ticket)}`;
  const row = app.db.get<{ account_id: string; data: string; expires_at: string }>("SELECT account_id, data, expires_at FROM auth_challenges WHERE id = ? AND purpose = 'oidc-ticket'", id);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", id);
  const data = row ? JSON.parse(row.data) as { providerId: string; purpose: "link" | "stepup"; sessionId: string; appLink?: ChallengeData["appLink"] } : null;
  if (!row || !data || row.expires_at < nowIso() || data.providerId !== providerId) {
    throw new HttpError(400, "expired", "That link has expired or was already used. Start again from the app.");
  }
  return startOidc(app, providerId, data.purpose, row.account_id, binder, { sessionId: data.sessionId, viaApp: true, appLink: data.appLink });
}

/**
 * The app redeems what the browser handed it (purss://connect?link_code=…) with its own token, the account the ticket was made for and
 * the verifier whose challenge the ticket carried. Only then is the provider sign-in linked; a code that fails any check is spent.
 */
export function redeemLinkCode(app: App, providerId: string, caller: { accountId: string; sessionId: string }, code: string, verifier: string): void {
  const p = provider(app, providerId);
  const id = `oidc-link:${sha256(code)}`;
  const row = app.db.get<{ account_id: string | null; challenge: string; data: string; expires_at: string }>("SELECT account_id, challenge, data, expires_at FROM auth_challenges WHERE id = ? AND purpose = 'oidc-link-code'", id);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", id);
  const invalid = () => new HttpError(400, "invalid_grant", "That code isn't valid any more. Start linking again from the app.");
  if (!row || row.expires_at < nowIso()) throw invalid();
  const data = JSON.parse(row.data) as { providerId: string; issuer: string; subject: string; sessionId: string };
  if (data.providerId !== providerId || row.account_id !== caller.accountId || data.sessionId !== caller.sessionId) {
    audit(app, caller.accountId, "oidc_link", providerId, "failure", "code for another account or app");
    throw invalid();
  }
  if (!safeEqual(createHash("sha256").update(verifier).digest("base64url"), row.challenge)) {
    audit(app, caller.accountId, "oidc_link", providerId, "failure", "wrong verifier");
    throw invalid();
  }
  sessionWrite(app, caller.accountId, caller.sessionId, () => {
    const existing = app.db.get<{ account_id: string }>("SELECT account_id FROM sign_in_methods WHERE kind = 'oidc' AND issuer = ? AND subject = ?", data.issuer, data.subject);
    if (existing && existing.account_id !== caller.accountId) throw new HttpError(409, "linked_elsewhere", "That external account is already used by another PURSS.");
    if (!existing) {
      app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES (?, ?, 'oidc', ?, ?, ?, ?)",
        newId("sim"), caller.accountId, p.label, data.issuer, data.subject, nowIso());
      audit(app, caller.accountId, "oidc_link", providerId, "success");
    }
  });
}

export type OidcResult = {
  purpose: OidcPurpose; accountId: string; sharedComputer: boolean;
  /** The sign-in made a new account. */
  created: boolean;
  /** The flow was started from a connected app: the browser has no session to return to. */
  viaApp: boolean;
  /** The flow was an app's (its ticket, or its sign-in that ends on the approval page): any refusal is shown as a page for the app. */
  appFlow: boolean;
  /** An app's link, signed in at the provider: what the browser hands back to the app to redeem (never linked until it does). */
  linkCode: { code: string; state: string } | null;
};

/** A refusal in a flow an app started: the system browser shows it as a page for the app, not as the web sign-in page. */
export class OidcFlowError extends HttpError {
  constructor(e: HttpError) { super(e.status, e.code, e.message, e.details, e.retryAt); }
}

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

/**
 * Completes the flow; the caller starts the session (signin) or sends the person on. A refusal in a flow an app started
 * (its ticket, or its sign-in that ends on the approval page) is an OidcFlowError, which the caller shows as a page for the app.
 */
export async function finishOidc(app: App, providerId: string, currentUrl: URL, caller: OidcCaller): Promise<OidcResult> {
  const flow = { fromApp: false };
  try {
    return await finish(app, providerId, currentUrl, caller, flow);
  } catch (err) {
    throw flow.fromApp && err instanceof HttpError ? new OidcFlowError(err) : err;
  }
}

async function finish(app: App, providerId: string, currentUrl: URL, caller: OidcCaller, flow: { fromApp: boolean }): Promise<OidcResult> {
  const p = provider(app, providerId);
  const state = currentUrl.searchParams.get("state") ?? "";
  const row = app.db.get<{ purpose: string; account_id: string | null; challenge: string; data: string; expires_at: string }>(
    "SELECT purpose, account_id, challenge, data, expires_at FROM auth_challenges WHERE id = ?", `oidc:${state}`);
  app.db.run("DELETE FROM auth_challenges WHERE id = ?", `oidc:${state}`);
  if (!row || row.expires_at < nowIso()) throw new HttpError(400, "expired", "That sign-in took too long or was already used. Please try again.");
  const data = JSON.parse(row.data) as ChallengeData;
  const viaApp = data.viaApp === true;
  flow.fromApp = viaApp || data.appReturn === true;
  if (data.providerId !== providerId || !caller.binder || !safeEqual(sha256(caller.binder), data.binder)) {
    throw new HttpError(400, "mismatch", "That sign-in didn't start in this browser. Please try again.");
  }
  const purpose = row.purpose.slice("oidc-".length) as OidcPurpose;
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
  const result = (r: Pick<OidcResult, "accountId" | "sharedComputer" | "created"> & Partial<Pick<OidcResult, "viaApp" | "linkCode">>): OidcResult => ({ purpose, viaApp, appFlow: flow.fromApp, linkCode: null, ...r });

  if (purpose === "link") {
    if (!row.account_id || !data.sessionId) throw new HttpError(400, "expired", "Please sign in first.");
    const accountId = row.account_id;
    if (viaApp) {
      // An app's link never completes here: whoever signs in at the provider in this browser may not be the person whose app asked
      // (an app's ticket can be handed to anyone). The identity waits behind a code that only goes back to the app.
      if (!data.appLink) throw new HttpError(400, "expired", "Start linking again from the app.");
      if (existing && existing.account_id !== accountId) throw new HttpError(409, "linked_elsewhere", "That external account is already used by another PURSS.");
      const code = randomToken(24);
      app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, data, expires_at) VALUES (?, 'oidc-link-code', ?, ?, ?, ?)",
        `oidc-link:${sha256(code)}`, accountId, data.appLink.challenge, JSON.stringify({ providerId, issuer: claims.iss, subject: claims.sub, sessionId: data.sessionId }), addSeconds(LINK_CODE_SECONDS));
      return result({ accountId, sharedComputer: false, created: false, linkCode: { code, state: data.appLink.state } });
    }
    if (caller.sessionId !== data.sessionId) throw new HttpError(401, "signed_out", "Please sign in again.");
    sessionWrite(app, accountId, data.sessionId, () => {
      if (existing && existing.account_id !== accountId) throw new HttpError(409, "linked_elsewhere", "That external account is already used by another PURSS.");
      if (!existing) {
        app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, issuer, subject, created_at) VALUES (?, ?, 'oidc', ?, ?, ?, ?)",
          newId("sim"), accountId, p.label, claims.iss, claims.sub, nowIso());
        audit(app, accountId, "oidc_link", providerId, "success");
      }
    });
    return result({ accountId, sharedComputer: false, created: false });
  }

  if (purpose === "stepup") {
    if (!row.account_id || !data.sessionId) throw new HttpError(400, "expired", "Please sign in first.");
    const accountId = row.account_id;
    if (!viaApp && caller.sessionId !== data.sessionId) throw new HttpError(401, "signed_out", "Please sign in again.");
    // The identity that signed in must be one this account has linked: another Google account can't confirm it.
    if (existing?.account_id !== accountId) {
      audit(app, accountId, "oidc_step_up", providerId, "failure", "another identity");
      throw new HttpError(403, "wrong_account", `That ${p.label} account isn't the one connected to this PURSS account.`);
    }
    // The account may have gained a password or a passkey since the flow started.
    assertMayConfirm(app, accountId, p);
    // A provider asked to re-authenticate must say when it did, and that must be after this request: one that doesn't say, or
    // shows the person signed in before it, didn't ask again.
    if (data.stepUp === "reauthenticate") {
      const authTime = claims.auth_time;
      const stale = typeof authTime !== "number" ? "no auth_time" : authTime * 1000 < (data.startedAt ?? 0) - AUTH_TIME_SKEW_MS ? "stale auth_time" : null;
      if (stale) {
        audit(app, accountId, "oidc_step_up", providerId, "failure", stale);
        throw new HttpError(401, "stale_auth", `${p.label} didn't confirm that you just signed in again, so it can't confirm it's you. Try again.`);
      }
    }
    const sessionId = data.sessionId;
    sessionWrite(app, accountId, sessionId, () => refreshAuth(app, sessionId));
    app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE kind = 'oidc' AND issuer = ? AND subject = ?", nowIso(), claims.iss, claims.sub);
    audit(app, accountId, "oidc_step_up", providerId, "success");
    return result({ accountId, sharedComputer: false, created: false });
  }

  // Signing in.
  if (existing) {
    app.db.run("UPDATE sign_in_methods SET last_used_at = ? WHERE kind = 'oidc' AND issuer = ? AND subject = ?", nowIso(), claims.iss, claims.sub);
    return result({ accountId: existing.account_id, sharedComputer: data.sharedComputer === true, created: false, viaApp: false });
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
  // The day's capacity and an address another account has confirmed are checked in the account's own transaction (never linked or
  // duplicated by email: someone who already has an account links the provider in Settings → Security).
  try {
    const { accountId } = signupWithProvider(app, { displayName: displayName(claims), email, label: p.label, issuer: claims.iss, subject: claims.sub }, caller.address, attemptRetryAt);
    return result({ accountId, sharedComputer: data.sharedComputer === true, created: true, viaApp: false });
  } catch (err) {
    if (err instanceof HttpError && err.code === "email_in_use") audit(app, null, "oidc", providerId, "failure", "email in use");
    throw err;
  }
}
