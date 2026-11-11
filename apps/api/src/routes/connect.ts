import { appUrl } from "@purss/domain";
import { z } from "zod";
import { CONNECT_CLIENT_KINDS, connectApproveSchema, connectRequestSchema, connectSigninSchema, connectSignupSchema, connectTokenSchema } from "@purss/domain";
import type { ConnectApproveResult, ConnectClientKind, ConnectInfo, ConnectRequestSummary, ConnectTokenResult } from "@purss/domain";
import type { App, Ctx } from "../app.ts";
import { audit, requirePrincipal, requireRecentAuth } from "../app.ts";
import { HttpError, Router, badRequest, clientAddress, parse, rateLimit } from "../http.ts";
import { CODE_TTL_SECONDS, issueCode, redeemCode } from "../connect/codes.ts";
import { REDIRECT_PATTERNS, checkRedirect, cleanDeviceName } from "../connect/clients.ts";
import { MAX_DEVICES, createDeviceToken, deviceCount, deviceIdOf, listDevices, revokeDevice, tooMany } from "../connect/devices.ts";
import { acceptInvite, assertSignupCapacity, openSignupAttempt, selfSignup } from "../auth/accounts.ts";
import { PASSWORD_MIN, checkPassword, normalizeUsername, preparePassword } from "../auth/passwords.ts";
import { accountEmailAvailable, setAccountEmail } from "../services/account-email.ts";
import { signupOpen } from "../mail/mailer.ts";
import { endDeletion, keepTokenFor } from "../services/deletion.ts";
import { authenticationOptions, verifyAuthentication } from "../auth/passkeys.ts";
import { appPasskeys } from "../connect/app-association.ts";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

/*
 * Connected apps (plan/24). The app opens /connect in the system browser with
 *   client, redirect_uri, state, code_challenge, code_challenge_method=S256, device_name
 * (redirect_uri and state left out when the person will type the code instead). The web page shows
 * the request from GET /api/connect/request, and the signed-in person approves with
 * POST /api/connect/approve (same origin, CSRF header, recent sign-in). The app then exchanges the
 * code at POST /api/connect/token with its code_verifier and receives its device token once.
 */

const PRODUCT_NAME = "PURSS";

type Checked = { client: ConnectClientKind; redirect: { uri: string; label: string } | null; state: string | null; codeChallenge: string; deviceName: string };

/** Validate a connection request. An invalid redirect target is an error shown on the page, never followed. */
function checkRequest(input: z.infer<typeof connectRequestSchema>): Checked {
  let redirect: Checked["redirect"] = null;
  if (input.redirect_uri !== undefined) {
    redirect = checkRedirect(input.client, input.redirect_uri);
    if (!redirect) throw badRequest("This connection link doesn't come from a PURSS app (its return address isn't one the apps use).", "bad_redirect");
    if (!input.state) throw badRequest("This connection link is incomplete. Start connecting again from the app.", "bad_request");
  }
  return { client: input.client, redirect, state: redirect ? input.state! : null, codeChallenge: input.code_challenge, deviceName: cleanDeviceName(input.client, input.device_name) };
}

function parseRequest(value: unknown): Checked {
  const r = connectRequestSchema.safeParse(value ?? {});
  if (!r.success) throw badRequest("This connection link isn't complete or isn't valid. Start connecting again from the app.", "bad_request");
  return checkRequest(r.data);
}

/** The redirect back to the app (RFC 9207 `iss` lets an app that knows several PURSSes check which one answered). */
function backToApp(app: App, redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("iss", app.config.publicOrigin);
  return u.href;
}

export function connectInfo(app: App): ConnectInfo {
  const clients = Object.fromEntries(CONNECT_CLIENT_KINDS.map((k) => [k, { redirectUris: REDIRECT_PATTERNS[k], typedCode: true as const }])) as ConnectInfo["connect"]["clients"];
  return {
    service: "purss",
    name: PRODUCT_NAME,
    origin: app.config.publicOrigin,
    hosted: app.config.mode === "hosted",
    version: app.config.version?.version ?? null,
    connect: { page: `${app.config.publicOrigin}${appUrl("/connect")}`, token: `${app.config.publicOrigin}/api/connect/token`, codeChallengeMethods: ["S256"], clients },
    signup: { endpoint: `${app.config.publicOrigin}/api/connect/signup`, invitation: true, open: signupOpen(app), passwordMin: PASSWORD_MIN },
    signin: {
      endpoint: `${app.config.publicOrigin}/api/connect/signin`,
      methods: appPasskeys(app) ? ["password", "passkey"] : ["password"],
      passkeyOptions: appPasskeys(app) ? `${app.config.publicOrigin}/api/connect/passkey/options` : null,
      passwordReset: accountEmailAvailable(app) ? `${app.config.publicOrigin}/api/password-reset` : null,
      passwordResetConfirm: accountEmailAvailable(app) ? `${app.config.publicOrigin}/api/password-reset/confirm` : null,
      providers: app.config.oidc.map((o) => ({ id: o.id, label: o.label, start: `${app.config.publicOrigin}/api/auth/oidc/${encodeURIComponent(o.id)}/start` })),
    },
    features: { urlLookup: true, browserCapture: true },
  };
}

/** A phone app connected after the person signed in with `method`. */
function connectedApp(app: App, accountId: string, deviceName: string, method: string): ConnectTokenResult {
  const made = createDeviceToken(app, accountId, "mobile", deviceName, method);
  audit(app, accountId, "sign_in", method, "success");
  return { token: made.secret, tokenType: "Bearer", device: made.device };
}

export function connectRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  // ---------- for apps ----------
  r.get("/api/connect/info", (_req, ctx) => connectInfo(ctx.app));

  r.post("/api/connect/token", (req, ctx): ConnectTokenResult => {
    const { app } = ctx;
    rateLimit(`connect-token:${clientAddress(req.raw, app.config.trustProxy)}`, 30);
    const body = parse(connectTokenSchema, req.body);
    const out = redeemCode(app, { code: body.code, codeVerifier: body.codeVerifier, kind: body.client, clientId: null, redirectUri: body.redirectUri ?? null });
    if (!out.ok) {
      audit(app, out.accountId, "device_connect", null, "failure", out.reason);
      throw new HttpError(400, "invalid_grant", "That connection code isn't valid any more. Start connecting again from the app.");
    }
    try {
      const made = createDeviceToken(app, out.grant.accountId, body.client, out.grant.label);
      return { token: made.secret, tokenType: "Bearer", device: made.device };
    } catch (err) {
      if (err instanceof HttpError) audit(app, out.grant.accountId, "device_connect", null, "failure", err.code);
      throw err;
    }
  });

  /**
   * Sign in from the mobile app with a username and password (or a passkey), and connect it: the same
   * checks, limits and answers as signing in in a browser, but the result is the app's device token, not a
   * cookie.
   */
  r.post("/api/connect/signin", async (req, ctx): Promise<ConnectTokenResult> => {
    const { app } = ctx;
    const address = clientAddress(req.raw, app.config.trustProxy);
    const body = parse(connectSigninSchema, req.body);
    const deviceName = cleanDeviceName("mobile", body.deviceName);
    const method = `app-${body.method}`;
    // As in a browser: an account set to be deleted isn't signed in to, but this answer can keep it (/api/connect/keep-account).
    const connect = (accountId: string): ConnectTokenResult | { keepToken: string; dueAt: string } => {
      const keep = keepTokenFor(app, accountId, method);
      if (keep) return { keepToken: keep.token, dueAt: keep.dueAt };
      return connectedApp(app, accountId, deviceName, method);
    };
    const answer = (out: ConnectTokenResult | { keepToken: string; dueAt: string }): ConnectTokenResult => {
      if ("keepToken" in out) throw new HttpError(409, "deletion_pending", "This account is set to be deleted. You can still keep it.", { dueAt: out.dueAt, keepToken: out.keepToken });
      return out;
    };
    if (body.method === "passkey") {
      rateLimit(`passkey:${address}`, 60);
      const { accountId } = await verifyAuthentication(app, body.challengeId, body.response as unknown as AuthenticationResponseJSON);
      return answer(app.db.tx(() => connect(accountId)));
    }
    rateLimit(`password:${address}`, 10);
    rateLimit(`password-user:${normalizeUsername(body.username)}`, 10, 15 * 60_000);
    const accountId = await checkPassword(app, body.username, body.password);
    if (!accountId) {
      audit(app, null, "sign_in", method, "failure");
      throw new HttpError(401, "bad_password", "That username and password don't match.");
    }
    return answer(app.db.tx(() => connect(accountId)));
  });

  /** A passkey challenge for signing in from the phone app (where the PURSS vouches for it). */
  r.post("/api/connect/passkey/options", (req, ctx) => {
    if (!appPasskeys(ctx.app)) throw new HttpError(404, "not_available", "Passkeys can't be used in the app with this PURSS yet.");
    rateLimit(`passkey:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 60);
    return authenticationOptions(ctx.app);
  });

  /** "Keep my account" in the app: end the pending deletion with the token sign-in gave, and connect. */
  r.post("/api/connect/keep-account", (req, ctx): ConnectTokenResult => {
    const { app } = ctx;
    rateLimit(`deletion-cancel:${clientAddress(req.raw, app.config.trustProxy)}`, 20);
    const body = parse(z.object({ client: z.literal("mobile"), keepToken: z.string().min(16).max(200), deviceName: z.string().max(200).optional() }), req.body);
    return app.db.tx(() => {
      const kept = endDeletion(app, body.keepToken);
      return connectedApp(app, kept.accountId, cleanDeviceName("mobile", body.deviceName), kept.method);
    });
  });

  /**
   * Create an account from the mobile app and connect it in one step: with an invitation code, or an email address
   * where sign-up is open, plus a username and password to sign in with. The account, its password and the app's
   * device token are written in one transaction, so nothing is left half made.
   */
  r.post("/api/connect/signup", async (req, ctx): Promise<ConnectTokenResult> => {
    const { app } = ctx;
    const address = clientAddress(req.raw, app.config.trustProxy);
    const body = parse(connectSignupSchema, req.body);
    // The same limits as accepting an invitation or signing up in a browser.
    const attemptRetryAt = body.invitation !== undefined ? (rateLimit(`invite:${address}`, 10), null) : openSignupAttempt(app, address);
    if (body.invitation === undefined) assertSignupCapacity(app, address, attemptRetryAt);
    const password = await preparePassword(body.username, body.password);
    const deviceName = cleanDeviceName("mobile", body.deviceName);
    return app.db.tx(() => {
      const created = body.invitation !== undefined ? acceptInvite(app, body.invitation, body.displayName, password) : selfSignup(app, body.displayName, address, password, attemptRetryAt);
      const made = createDeviceToken(app, created.accountId, "mobile", deviceName, body.invitation !== undefined ? "invite" : "signup");
      // Last: the confirmation email goes out at once, so nothing may refuse the sign-up after it.
      if (body.email !== undefined) setAccountEmail(app, created.accountId, body.email);
      return { token: made.secret, tokenType: "Bearer", device: made.device };
    });
  });

  /** Disconnect the app making the request (its own "sign out"). */
  r.delete("/api/connect/device", (_req, ctx) => {
    const p = requirePrincipal(ctx);
    const id = deviceIdOf(p);
    if (!id) throw badRequest("This is for connected apps. Sign out in PURSS instead.", "not_device");
    return revokeDevice(ctx.app, p, id, "self");
  });

  // ---------- the approval page (browser session only, see connect/clients.ts) ----------
  r.get("/api/connect/request", (req, ctx): ConnectRequestSummary => {
    requirePrincipal(ctx);
    const c = parseRequest(Object.fromEntries(req.query));
    return {
      client: c.client, deviceName: c.deviceName, redirect: c.redirect,
      declineUrl: c.redirect ? backToApp(ctx.app, c.redirect.uri, { error: "access_denied", state: c.state! }) : null,
    };
  });

  r.post("/api/connect/approve", (req, ctx): ConnectApproveResult => {
    const p = requirePrincipal(ctx);
    if (deviceIdOf(p)) throw new HttpError(403, "not_for_apps", "That can only be done in PURSS in a web browser.");
    // A connected app holds a long-lived credential, so approving one needs a recent sign-in, like a new passkey or token.
    requireRecentAuth(p);
    rateLimit(`connect-approve:${p.accountId}`, 30);
    const body = connectApproveSchema.safeParse(req.body ?? {});
    if (!body.success) throw badRequest("This connection request isn't valid. Start connecting again from the app.", "bad_request");
    const c = checkRequest(body.data);
    const deviceName = cleanDeviceName(c.client, body.data.device_name);
    if (deviceCount(ctx.app, p.accountId) >= MAX_DEVICES) throw tooMany();
    const grant = { accountId: p.accountId, kind: c.client, clientId: null, redirectUri: c.redirect?.uri ?? null, label: deviceName, scope: null };
    const code = issueCode(ctx.app, grant, c.codeChallenge, c.redirect ? "redirect" : "typed");
    audit(ctx.app, p.accountId, "connect_approve", null, "success", c.client);
    if (c.redirect) return { redirectTo: backToApp(ctx.app, c.redirect.uri, { code, state: c.state! }) };
    return { code, expiresInMinutes: CODE_TTL_SECONDS / 60 };
  });

  // ---------- Settings → Connected apps ----------
  r.get("/api/connect/devices", (_req, ctx) => listDevices(ctx.app, requirePrincipal(ctx)));
  r.delete("/api/connect/devices/:id", (req, ctx) => revokeDevice(ctx.app, requirePrincipal(ctx), req.params.id!, "settings"));

  return r;
}
