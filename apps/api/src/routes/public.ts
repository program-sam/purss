import { clientAddress } from "../http.ts";
import { z } from "zod";
import {
  bulkActionSchema, basketCreateSchema, basketPatchSchema, clearFreshSchema, collectionCreateSchema,
  browserCaptureSchema, collectionPatchSchema, discoverSchema, followSchema, itemIdsQuerySchema, itemListQuerySchema, manualKeepSchema, MAX_BULK_ITEMS, podcastSearchSchema, sourcePatchSchema,
  stateChangeSchema, undoSchema,
} from "@purss/domain";
import type { Bootstrap, SearchResult } from "@purss/domain";
import { appUrl } from "@purss/domain";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Ctx } from "../app.ts";
import { audit, requirePrincipal, requireRecentAuth } from "../app.ts";
import { badRequest, consumeRateLimit, HttpError, Router, notFound, nowIso, parse, rateLimit, setCookie } from "../http.ts";
import type { Handler } from "../http.ts";
import { randomToken } from "../secrets.ts";

const OIDC_COOKIE = "purss_oidc";
/** Where to return after a linked sign-in, e.g. an app's connection request (plan/24). */
const OIDC_NEXT_COOKIE = "purss_oidc_next";
import {
  acceptInvite, assertSignupCapacity, claim, endSession, openSignupAttempt,
  refreshAuth, recentAuthAvailable, selfSignup, sessionInfo, sessionWrite, setPassword, startSession,
} from "../auth/accounts.ts";
import { authenticationOptions, listMethods, registrationOptions, removeMethod, verifyAuthentication, verifyRegistration } from "../auth/passkeys.ts";
import { finishOidc, issueAppTicket, startFromTicket, startOidc } from "../auth/oidc.ts";
import { deviceIdOf } from "../connect/devices.ts";
import { PASSWORD_MAX, checkPassword, normalizeUsername, preparePassword } from "../auth/passwords.ts";
import { getItemDetail, listItemIds, listItems, searchSnippets } from "../services/items.ts";
import { noteSnippets, searchItems } from "../services/search.ts";
import { keepLink, keepWithBrowserCapture, lookupUrl, renameKeptLink } from "../services/links.ts";
import { applyUndo, bulk, changeState, clearFreshAll, keepWithUndo } from "../services/state.ts";
import { discoverSources, followSource, getSource, listSources, patchSource, retrySource, searchPodcastDirectory, unfollowSource } from "../services/sources.ts";
import {
  basketDeletePreview, createBasket, createCollection, deleteBasket, deleteCollection, deleteItems, deletePreview,
  listBaskets, listCollections, patchBasket, patchCollection,
} from "../services/collections.ts";
import { getPreferences, preferencesPatchSchema, setPreferences } from "../services/preferences.ts";
import { summary } from "../services/storage.ts";
import { capacity } from "../services/plans.ts";
import { listNotifications, markNotificationsRead, unreadCount } from "../services/notifications.ts";
import { readIcon } from "../services/icons.ts";
import { emailSchema, setAccountEmail } from "../services/account-email.ts";
import { DELETION_COOKIE, keepAccount, leaveDeletion, pendingDeletion, requestDeletion } from "../services/deletion.ts";

const limit = rateLimit;

/** A path on this PURSS only; "//host" and "/\host" would be read as another site. */
export function safeReturnPath(v: string | null | undefined): string | null {
  if (!v || v.length > 4000 || !v.startsWith("/") || v.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(v)) return null;
  return v;
}

/** The engine's configured purge window for entries not yet passed on (infra/engine, purss-engine.json). */
const ENGINE_RETENTION_DAYS = 90;
const staleDays = (iso: string | null | undefined) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : 0);

/** Room for BROWSER_CAPTURE_MAX_CHARS characters as JSON: up to 3 bytes each in UTF-8, plus escapes and the other fields. */
const BROWSER_CAPTURE_BODY_LIMIT = 8 * 1024 * 1024;

/** What the system browser shows after it finished an app's external sign-in (the app, waiting, carries on by itself). */
function appReturnPage(purpose: "link" | "stepup"): string {
  const said = purpose === "link" ? "The sign-in is connected to your PURSS account." : "You're confirmed.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to PURSS</title></head>`
    + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1.5rem"><h1 style="font-size:1.4rem">${said}</h1>`
    + `<p>Go back to the PURSS app. You can close this page.</p></body></html>`;
}

/** The username and password every new account is made with, from sign-up, setup and invitations. */
const newAccountSchema = { username: z.string().max(80), password: z.string().max(PASSWORD_MAX * 4) };

/** Keep the public sign-up flow isolated so hosted email enrollment can be added alongside it. */
const signupHandler: Handler<Ctx> = async (req, ctx, res) => {
  const address = clientAddress(req.raw, ctx.app.config.trustProxy);
  const attemptRetryAt = openSignupAttempt(ctx.app, address);
  // Open sign-up is hosted-only and needs working email: every account gets an address to confirm.
  const body = parse(z.object({
    displayName: z.string().trim().max(60).nullable().default(null), email: emailSchema, ...newAccountSchema, sharedComputer: z.boolean().default(false),
  }), req.body);
  // Checked and hashed before anything is written: hashing is slow, and a refused password must leave nothing behind.
  const password = await preparePassword(body.username, body.password);
  assertSignupCapacity(ctx.app, address, attemptRetryAt);
  const out = ctx.app.db.tx(() => {
    const created = selfSignup(ctx.app, body.displayName, address, password, attemptRetryAt);
    setAccountEmail(ctx.app, created.accountId, body.email);
    return created;
  });
  startSession(ctx.app, res, req.raw, out.accountId, "signup", { sharedComputer: body.sharedComputer });
  return { ok: true };
};

export function publicRouter(): Router<Ctx> {
  const r = new Router<Ctx>();

  // ---------- session & sign-in ----------
  r.get("/api/session", (_req, ctx) => sessionInfo(ctx));

  r.post("/api/setup/claim", async (req, ctx, res) => {
    limit(`claim:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 10);
    const body = parse(z.object({ code: z.string().min(4).max(60), displayName: z.string().trim().max(60).nullable().default(null), ...newAccountSchema, sharedComputer: z.boolean().default(false) }), req.body);
    const out = claim(ctx.app, body.code, body.displayName, await preparePassword(body.username, body.password));
    startSession(ctx.app, res, req.raw, out.accountId, "setup", { sharedComputer: body.sharedComputer });
    return { ok: true };
  });

  r.post("/api/invites/accept", async (req, ctx, res) => {
    limit(`invite:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 10);
    const body = parse(z.object({ code: z.string().min(4).max(60), displayName: z.string().trim().max(60).nullable().default(null), ...newAccountSchema, sharedComputer: z.boolean().default(false) }), req.body);
    const out = acceptInvite(ctx.app, body.code, body.displayName, await preparePassword(body.username, body.password));
    startSession(ctx.app, res, req.raw, out.accountId, "invite", { sharedComputer: body.sharedComputer });
    return { ok: true };
  });

  r.post("/api/signup", signupHandler);

  r.post("/api/auth/passkey/login/options", (req, ctx) => {
    limit(`passkey:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 60);
    const body = parse(z.object({ sharedComputer: z.boolean().default(false) }), req.body);
    return authenticationOptions(ctx.app, body.sharedComputer);
  });
  r.post("/api/auth/passkey/login/verify", async (req, ctx, res) => {
    const body = parse(z.object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()) }), req.body);
    const result = await verifyAuthentication(ctx.app, body.challengeId, body.response as unknown as AuthenticationResponseJSON);
    startSession(ctx.app, res, req.raw, result.accountId, "passkey", { sharedComputer: result.sharedComputer });
    return { ok: true };
  });

  r.post("/api/auth/password", async (req, ctx, res) => {
    // A username, or the account's confirmed email address.
    const body = parse(z.object({ username: z.string().max(254), password: z.string().min(1).max(PASSWORD_MAX * 4), sharedComputer: z.boolean().default(false) }), req.body);
    limit(`password:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 10);
    // Also per name as typed, so spreading guesses over many addresses doesn't help. An address keeps its own count:
    // sharing its username's count would let anyone tell which address belongs to which username from the answers.
    limit(`password-user:${normalizeUsername(body.username)}`, 10, 15 * 60_000);
    const accountId = await checkPassword(ctx.app, body.username, body.password);
    if (!accountId) {
      audit(ctx.app, null, "sign_in", "password", "failure");
      throw new HttpError(401, "bad_password", "That username and password don't match.");
    }
    startSession(ctx.app, res, req.raw, accountId, "password", { sharedComputer: body.sharedComputer });
    return { ok: true };
  });

  r.post("/api/auth/logout", (_req, ctx, res) => {
    endSession(ctx.app, res, ctx.principal?.sessionId ?? null);
    return { ok: true };
  });

  /**
   * Starts an external sign-in in this browser (purpose: sign in, `?link=1` to add it to the signed-in account, `?stepup=1` to
   * confirm it's you with it). `next` is where to return afterwards. `?ticket=` starts what a connected app asked for.
   */
  r.get("/api/auth/oidc/:provider/start", async (req, ctx, res) => {
    const providerId = req.params.provider!;
    const ticket = req.query.get("ticket");
    const purpose = req.query.get("stepup") === "1" ? "stepup" : req.query.get("link") === "1" ? "link" : "signin";
    const binder = randomToken(24);
    let url: string;
    if (ticket) {
      limit(`oidc-ticket:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 30);
      url = await startFromTicket(ctx.app, providerId, ticket, binder);
    } else {
      const p = purpose === "signin" ? null : requirePrincipal(ctx);
      if (p && deviceIdOf(p)) throw badRequest("A connected app opens this in the system browser with a ticket.", "use_ticket");
      if (purpose === "link") requireRecentAuth(p!);
      const sharedComputer = purpose === "signin" && req.query.get("shared") === "1";
      url = await startOidc(ctx.app, providerId, purpose, p?.accountId ?? null, binder, { sharedComputer, sessionId: p?.sessionId ?? null });
    }
    const cookie = { maxAge: 600, secure: ctx.app.config.publicOrigin.startsWith("https:"), path: "/api/auth/oidc/" };
    setCookie(res, OIDC_COOKIE, binder, cookie);
    const next = purpose === "link" ? null : safeReturnPath(req.query.get("next"));
    if (next && !ticket) setCookie(res, OIDC_NEXT_COOKIE, next, cookie);
    res.writeHead(302, { location: url, "cache-control": "no-store" });
    res.end();
    return undefined;
  });
  r.get("/api/auth/oidc/:provider/callback", async (req, ctx, res) => {
    let target = appUrl("/");
    let fromApp: "link" | "stepup" | null = null;
    try {
      const out = await finishOidc(ctx.app, req.params.provider!, new URL(req.raw.url ?? "/", ctx.app.config.publicOrigin), {
        binder: req.cookies[OIDC_COOKIE] ?? "", accountId: ctx.principal?.accountId ?? null, sessionId: ctx.principal?.sessionId ?? null,
        address: clientAddress(req.raw, ctx.app.config.trustProxy),
      });
      if (out.purpose === "signin") startSession(ctx.app, res, req.raw, out.accountId, "oidc", { sharedComputer: out.sharedComputer });
      if (out.viaApp && out.purpose !== "signin") fromApp = out.purpose;
      target = appUrl(out.purpose === "link" ? "/?dialog=security" : safeReturnPath(req.cookies[OIDC_NEXT_COOKIE]) ?? "/");
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "oidc_failed";
      // The sign-in page asks GET /api/auth/deletion (with the cookie just set) when the deletion is due.
      target = appUrl(code === "deletion_pending" ? "/signin?notice=deletion_pending" : `/signin?error=${encodeURIComponent(code)}`);
    }
    const cleared = { maxAge: 0, secure: ctx.app.config.publicOrigin.startsWith("https:"), path: "/api/auth/oidc/" };
    setCookie(res, OIDC_COOKIE, "", cleared);
    setCookie(res, OIDC_NEXT_COOKIE, "", cleared);
    if (fromApp) {
      // The system browser has nothing of PURSS to show: the app notices by itself (it asks whether it is confirmed).
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(appReturnPage(fromApp));
      return undefined;
    }
    res.writeHead(302, { location: target, "cache-control": "no-store" });
    res.end();
    return undefined;
  });
  /** A connected app asks for a ticket to open an external sign-in in the system browser: to add it, or to confirm it's you with it. */
  r.post("/api/auth/oidc/:provider/ticket", (req, ctx) => {
    const p = requirePrincipal(ctx);
    if (!deviceIdOf(p)) throw badRequest("Browsers start this themselves.", "not_device");
    limit(`oidc-ticket:${p.accountId}`, 30);
    const { purpose } = parse(z.object({ purpose: z.enum(["link", "stepup"]) }), req.body);
    if (purpose === "link") requireRecentAuth(p);
    return { url: issueAppTicket(ctx.app, req.params.provider!, purpose, p.accountId, p.sessionId) };
  });

  // ---------- account security (signed in) ----------
  // Adding a sign-in method needs recent authentication.
  r.post("/api/auth/passkey/register/options", (_req, ctx) => {
    const p = requirePrincipal(ctx);
    requireRecentAuth(p);
    return registrationOptions(ctx.app, p.accountId);
  });
  r.post("/api/auth/passkey/register/verify", async (req, ctx) => {
    const p = requirePrincipal(ctx);
    const body = parse(z.object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()), label: z.string().trim().max(60).nullable().default(null) }), req.body);
    await verifyRegistration(ctx.app, p.accountId, p.sessionId, body.challengeId, body.response as unknown as RegistrationResponseJSON, body.label);
    return { ok: true };
  });
  r.post("/api/auth/step-up/passkey", async (req, ctx) => {
    const p = requirePrincipal(ctx);
    limit(`stepup-passkey:${p.accountId}`, 30);
    const body = parse(z.object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()) }), req.body);
    const result = await verifyAuthentication(ctx.app, body.challengeId, body.response as unknown as AuthenticationResponseJSON);
    if (result.accountId !== p.accountId) throw new HttpError(403, "wrong_account", "That passkey belongs to a different account.");
    sessionWrite(ctx.app, p.accountId, p.sessionId, () => refreshAuth(ctx.app, p.sessionId));
    return { ok: true };
  });
  r.post("/api/auth/step-up/password", async (req, ctx) => {
    const p = requirePrincipal(ctx);
    limit(`stepup-password:${p.accountId}`, 10);
    const { password } = parse(z.object({ password: z.string().min(1).max(PASSWORD_MAX * 4) }), req.body);
    if ((await checkPassword(ctx.app, "", password, p.accountId)) !== p.accountId) throw new HttpError(401, "bad_password", "That password isn't right.");
    sessionWrite(ctx.app, p.accountId, p.sessionId, () => refreshAuth(ctx.app, p.sessionId));
    return { ok: true };
  });
  // Changing the password needs recent authentication, like adding a passkey.
  r.put("/api/account/password", async (req, ctx) => {
    const p = requirePrincipal(ctx);
    requireRecentAuth(p);
    const body = parse(z.object({ username: z.string().max(80), password: z.string().max(PASSWORD_MAX * 4) }), req.body);
    await setPassword(ctx.app, p.accountId, p.sessionId, body.username, body.password);
    return { ok: true };
  });
  // Deleting the account: a recent sign-in plus typing the display name (or "delete").
  r.post("/api/account/deletion", (req, ctx, res) => {
    const p = requirePrincipal(ctx);
    requireRecentAuth(p);
    const { confirm } = parse(z.object({ confirm: z.string().max(200) }), req.body);
    const out = requestDeletion(ctx.app, p, confirm);
    endSession(ctx.app, res, null); // the session row is already gone; clear the cookie
    return out;
  });
  // Signing in during the grace period: the browser holds a single-use cookie instead of a session.
  r.get("/api/auth/deletion", (req, ctx) => pendingDeletion(ctx.app, req.cookies[DELETION_COOKIE]));
  r.post("/api/auth/deletion/cancel", (req, ctx, res) => {
    limit(`deletion-cancel:${clientAddress(req.raw, ctx.app.config.trustProxy)}`, 20);
    keepAccount(ctx.app, req.raw, res, req.cookies[DELETION_COOKIE]);
    return { ok: true };
  });
  r.delete("/api/auth/deletion", (req, ctx, res) => {
    leaveDeletion(ctx.app, res, req.cookies[DELETION_COOKIE]);
    return { ok: true };
  });
  r.get("/api/account/security", (_req, ctx) => {
    const p = requirePrincipal(ctx);
    const sessions = ctx.app.db.all<{ id: string; created_at: string; last_seen_at: string; method: string; user_agent: string | null; session_class: string }>(
      "SELECT id, created_at, last_seen_at, method, user_agent, session_class FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC", p.accountId, nowIso());
    return {
      methods: listMethods(ctx.app, p.accountId),
      sessions: sessions.map((s) => ({ id: s.id.slice(0, 16), current: s.id === p.sessionId, createdAt: s.created_at, lastSeenAt: s.last_seen_at, method: s.method, device: s.user_agent, sessionClass: s.session_class })),
      recentAuth: recentAuthAvailable(ctx.app, p.accountId, p.sessionId),
    };
  });
  r.delete("/api/account/methods/:id", (req, ctx) => {
    const p = requirePrincipal(ctx);
    removeMethod(ctx.app, p.accountId, p.sessionId, req.params.id!);
    return { ok: true };
  });
  r.delete("/api/account/sessions/:id", (req, ctx) => {
    const p = requirePrincipal(ctx);
    const revoked = sessionWrite(ctx.app, p.accountId, p.sessionId, () => {
      const rows = ctx.app.db.all<{ id: string }>("SELECT id FROM sessions WHERE account_id = ? AND substr(id, 1, 16) = ? AND id <> ?", p.accountId, req.params.id!, p.sessionId);
      if (!rows.length) throw notFound("That session");
      ctx.app.db.run("DELETE FROM sessions WHERE account_id = ? AND substr(id, 1, 16) = ? AND id <> ?", p.accountId, req.params.id!, p.sessionId);
      audit(ctx.app, p.accountId, "session_revoke", null, "success");
      return rows.map((r) => r.id);
    });
    for (const id of revoked) ctx.app.events.emit(`session:${id}`, "revoked");
    return { ok: true };
  });
  r.post("/api/account/sessions/sign-out-others", (_req, ctx) => {
    const p = requirePrincipal(ctx);
    const revoked = sessionWrite(ctx.app, p.accountId, p.sessionId, () => {
      const rows = ctx.app.db.all<{ id: string }>("SELECT id FROM sessions WHERE account_id = ? AND id <> ?", p.accountId, p.sessionId);
      ctx.app.db.run("DELETE FROM sessions WHERE account_id = ? AND id <> ?", p.accountId, p.sessionId);
      audit(ctx.app, p.accountId, "sessions_revoke_others", null, "success");
      return rows.map((r) => r.id);
    });
    for (const id of revoked) ctx.app.events.emit(`session:${id}`, "revoked");
    return { ok: true };
  });

  // ---------- PURSS ----------
  r.get("/api/bootstrap", (_req, ctx): Bootstrap => {
    const p = requirePrincipal(ctx);
    const cp = ctx.app.db.get<{ last_success_at: string | null; last_error: string | null }>(
      "SELECT c.last_success_at, c.last_error FROM sync_checkpoints c JOIN engine_users e ON e.id = c.engine_user_id WHERE e.account_id = ?", p.accountId);
    const eu = ctx.app.db.get<{ status: string }>("SELECT status FROM engine_users WHERE account_id = ?", p.accountId);
    return {
      collections: listCollections(ctx.app, p),
      sources: listSources(ctx.app, p),
      baskets: listBaskets(ctx.app, p),
      preferences: getPreferences(ctx.app, p.workspaceId),
      capacity: capacity(ctx.app, p.accountId),
      paused: summary(ctx.app, p.accountId).pausedReason,
      unreadNotifications: unreadCount(ctx.app, p.workspaceId),
      engine: {
        status: eu?.status === "ready" ? (cp?.last_error ? "unavailable" : "ok") : eu?.status === "error" ? "unavailable" : "starting",
        lastSyncAt: cp?.last_success_at ?? null,
        // The sync's own words for what went wrong come first, then how long it has been.
        message: eu?.status === "error" ? "The collection engine couldn't be set up for your PURSS. An administrator can retry it."
          : [
            cp?.last_error,
            staleDays(cp?.last_success_at) >= 1
              ? `New items last arrived ${staleDays(cp?.last_success_at)} day${staleDays(cp?.last_success_at) === 1 ? "" : "s"} ago. Everything you have is still here, but the engine drops entries it hasn't passed on after ${ENGINE_RETENTION_DAYS} days, so a longer gap can't be filled in later.`
              : null,
          ].filter(Boolean).join(" ") || null,
      },
    };
  });

  r.get("/api/preferences", (_req, ctx) => getPreferences(ctx.app, requirePrincipal(ctx).workspaceId));
  r.patch("/api/preferences", (req, ctx) => setPreferences(ctx.app, requirePrincipal(ctx).workspaceId, parse(preferencesPatchSchema, req.body)));

  // ---------- items ----------
  r.get("/api/items", (req, ctx) => {
    const p = requirePrincipal(ctx);
    const q = parse(itemListQuerySchema, Object.fromEntries(req.query));
    // Home's lists (mix=home) have their own order and are not searched: asking for either is refused rather than answered
    // by a list that follows none of Home's rules.
    if (q.mix && (q.q || q.sort !== "newest")) throw badRequest("Home's lists have their own order and can't be searched or sorted.");
    return listItems(ctx.app, p, q);
  });
  /** "Select all" on a list: every item it shows, in its order (not Home's lists, which aren't selected from). */
  r.get("/api/items/ids", (req, ctx) => {
    const q = parse(itemIdsQuerySchema, Object.fromEntries(req.query));
    if (q.mix) throw badRequest("Home's lists can't be selected as a whole.");
    return listItemIds(ctx.app, requirePrincipal(ctx), q);
  });
  /** What the PURSS has for a page (the browser extension asks this). Before /api/items/:id, which would match it too. */
  r.get("/api/items/lookup", (req, ctx) => {
    const p = requirePrincipal(ctx);
    const { url } = parse(z.object({ url: z.string().trim().min(1).max(2000) }), { url: req.query.get("url") ?? undefined });
    return lookupUrl(ctx.app, p, url);
  });
  r.get("/api/items/:id", (req, ctx) => getItemDetail(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.patch("/api/items/:id/state", (req, ctx) => changeState(ctx.app, requirePrincipal(ctx), req.params.id!, parse(stateChangeSchema, req.body)));
  r.put("/api/items/:id/baskets/:basketId", (req, ctx) => keepWithUndo(ctx.app, requirePrincipal(ctx), req.params.id!, req.params.basketId!, true));
  r.delete("/api/items/:id/baskets/:basketId", (req, ctx) => keepWithUndo(ctx.app, requirePrincipal(ctx), req.params.id!, req.params.basketId!, false));
  r.post("/api/items/bulk", (req, ctx) => {
    const body = parse(bulkActionSchema, req.body);
    return bulk(ctx.app, requirePrincipal(ctx), body.itemIds, body.action);
  });
  r.post("/api/items/clear-fresh", (req, ctx) => clearFreshAll(ctx.app, requirePrincipal(ctx), parse(clearFreshSchema, req.body).scope));
  r.post("/api/undo", (req, ctx) => applyUndo(ctx.app, requirePrincipal(ctx), parse(undoSchema, req.body).undoToken));
  r.post("/api/items/delete-preview", (req, ctx) => {
    const { itemIds } = parse(z.object({ itemIds: z.array(z.string()).min(1).max(MAX_BULK_ITEMS) }), req.body);
    return deletePreview(ctx.app, requirePrincipal(ctx), itemIds);
  });
  r.post("/api/items/delete", (req, ctx) => {
    const p = requirePrincipal(ctx);
    const { confirmToken } = parse(z.object({ confirmToken: z.string() }), req.body);
    const out = deleteItems(ctx.app, p, confirmToken);
    audit(ctx.app, p.accountId, "items_delete", null, "success", `${out.deleted} items`);
    return out;
  });
  /** Keep a single link that isn't from a followed source. A page the PURSS already has is kept as that item; a new one takes its title, picture and site from the page when it tells. */
  r.post("/api/items/manual", (req, ctx) => {
    const p = requirePrincipal(ctx);
    limit(`keep-link:${p.accountId}`, 120); // each new link asks the page about itself, like a lookup does
    return keepLink(ctx.app, p, parse(manualKeepSchema, req.body));
  });
  /** Keep a page with the readable text the person's browser extracted (plan/32). Larger body: the page's readable HTML. */
  r.post("/api/items/browser-capture", (req, ctx) => {
    const p = requirePrincipal(ctx);
    rateLimit(`browser-capture:${p.accountId}`, 60);
    return keepWithBrowserCapture(ctx.app, p, parse(browserCaptureSchema, req.body));
  }, { bodyLimit: BROWSER_CAPTURE_BODY_LIMIT });
  /** A link kept by hand can be renamed; a followed source's titles are the publisher's. */
  r.patch("/api/items/:id/title", (req, ctx) => renameKeptLink(ctx.app, requirePrincipal(ctx), req.params.id!, parse(z.object({ title: z.string().trim().min(1).max(300) }), req.body).title));

  r.get("/api/search", (req, ctx): SearchResult => {
    const p = requirePrincipal(ctx);
    const q = (req.query.get("q") ?? "").trim().slice(0, 200);
    if (!q) return { items: [], snippets: {}, sources: [], collections: [], baskets: [] };
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const items = searchItems(ctx.app, p, q, 8);
    const snippets = searchSnippets(ctx.app, items.map((i) => i.id), q);
    return {
      items,
      snippets,
      noteSnippets: noteSnippets(ctx.app, p, items.map((i) => i.id).filter((id) => !snippets[id]), q),
      sources: ctx.app.db.all<{ id: string; title: string }>("SELECT id, title FROM sources WHERE workspace_id = ? AND followed = 1 AND title LIKE ? LIMIT 5", p.workspaceId, like),
      collections: ctx.app.db.all<{ id: string; name: string }>("SELECT id, name FROM collections WHERE workspace_id = ? AND name LIKE ? LIMIT 5", p.workspaceId, like),
      baskets: ctx.app.db.all<{ id: string; name: string }>("SELECT id, name FROM baskets WHERE workspace_id = ? AND name LIKE ? LIMIT 5", p.workspaceId, like),
    };
  });

  // ---------- sources ----------
  r.post("/api/discover", async (req, ctx) => {
    const p = requirePrincipal(ctx);
    limit(`discover:${p.accountId}`, 120);
    return discoverSources(ctx.app, p, parse(discoverSchema, req.body).url);
  });
  /** Shows by name from Apple's podcast directory: what was typed goes there, nothing else. Following a hit is an ordinary lookup of its feed. */
  r.post("/api/discover/podcasts", async (req, ctx) => {
    const p = requirePrincipal(ctx);
    limit(`discover-podcasts:${p.accountId}`, 60);
    return searchPodcastDirectory(parse(podcastSearchSchema, req.body).query);
  });
  r.post("/api/sources", (req, ctx) => followSource(ctx.app, requirePrincipal(ctx), parse(followSchema, req.body)));
  r.get("/api/sources/:id", (req, ctx) => getSource(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.get("/api/sources/:id/icon", (req, ctx, res) => {
    const icon = readIcon(ctx.app, requirePrincipal(ctx), req.params.id!);
    const etag = `"${icon.digest.slice(0, 32)}"`;
    // The address carries the digest, so the browser can keep it; private because it is per account.
    const headers = { "content-type": "image/webp", "cache-control": "private, max-age=31536000, immutable", etag, "content-security-policy": "default-src 'none'; sandbox" };
    if (req.raw.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return undefined; }
    res.writeHead(200, { ...headers, "content-length": icon.bytes.byteLength });
    res.end(icon.bytes);
    return undefined;
  });
  r.patch("/api/sources/:id", (req, ctx) => patchSource(ctx.app, requirePrincipal(ctx), req.params.id!, parse(sourcePatchSchema, req.body)));
  r.post("/api/sources/:id/retry", (req, ctx) => retrySource(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.delete("/api/sources/:id", (req, ctx) => unfollowSource(ctx.app, requirePrincipal(ctx), req.params.id!, { deleteUnkept: req.query.get("deleteUnkept") === "1" }));

  // ---------- collections ----------
  r.get("/api/collections", (_req, ctx) => listCollections(ctx.app, requirePrincipal(ctx)));
  r.post("/api/collections", (req, ctx) => createCollection(ctx.app, requirePrincipal(ctx), parse(collectionCreateSchema, req.body)));
  r.patch("/api/collections/:id", (req, ctx) => patchCollection(ctx.app, requirePrincipal(ctx), req.params.id!, parse(collectionPatchSchema, req.body)));
  r.delete("/api/collections/:id", (req, ctx) => { deleteCollection(ctx.app, requirePrincipal(ctx), req.params.id!); return { ok: true }; });

  // ---------- baskets ----------
  r.get("/api/baskets", (_req, ctx) => listBaskets(ctx.app, requirePrincipal(ctx)));
  r.post("/api/baskets", (req, ctx) => createBasket(ctx.app, requirePrincipal(ctx), parse(basketCreateSchema, req.body)));
  r.patch("/api/baskets/:id", (req, ctx) => patchBasket(ctx.app, requirePrincipal(ctx), req.params.id!, parse(basketPatchSchema, req.body)));
  r.post("/api/baskets/:id/delete-preview", (req, ctx) => basketDeletePreview(ctx.app, requirePrincipal(ctx), req.params.id!));
  r.post("/api/baskets/:id/delete", (req, ctx) => {
    deleteBasket(ctx.app, requirePrincipal(ctx), req.params.id!, parse(z.object({ confirmToken: z.string() }), req.body).confirmToken);
    return { ok: true };
  });

  // ---------- notifications ----------
  r.get("/api/notifications", (_req, ctx) => listNotifications(ctx.app, requirePrincipal(ctx)));
  r.post("/api/notifications/read", (req, ctx) => {
    const { ids } = parse(z.object({ ids: z.union([z.array(z.string()).max(200), z.literal("all")]) }), req.body);
    return { changed: markNotificationsRead(ctx.app, requirePrincipal(ctx), ids) };
  });

  return r;
}
