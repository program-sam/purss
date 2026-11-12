import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { BROWSER_CAPTURE_MAX_CHARS } from "@purss/domain";
import { requireAdmin, requireRecentAuth } from "../app.ts";
import { TEST_PASSWORD, makeOwner, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { publicRouter, safeReturnPath } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { publicServer } from "../server.ts";
import { eventStream } from "../main.ts";
import { createBasket } from "../services/collections.ts";
import { keepLink } from "../services/links.ts";
import { addSeconds } from "../http.ts";
import { normalizeCode, sha256 } from "../secrets.ts";
import { checkRedirect, cleanDeviceName, deviceMayUse, isClientOrigin } from "./clients.ts";
import { issueCode, redeemCode, s256, verifierMatches } from "./codes.ts";
import { MAX_DEVICES, createDeviceToken, purgeIdleDevices, resolveDeviceToken } from "./devices.ts";
import { createInvite } from "../auth/accounts.ts";
import { checkMail, settleMail, useTransport } from "../mail/mailer.ts";

// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CHROME_REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";

async function boot() {
  // Behind a "proxy" so each test can present its own address to the per-address rate limit.
  const { app, cleanup } = makeTestApp({ PURSS_TRUST_PROXY: "1" });
  const owner = makeOwner(app, { admin: true });
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const address = `203.0.113.${Math.floor(Math.random() * 250) + 1}-${randomUUID()}`;
  return { app, owner, server, session, address, close: async () => { await server.close(); cleanup(); } };
}
type Boot = Awaited<ReturnType<typeof boot>>;

type Opts = { token?: string; origin?: string | null; cookie?: string; csrf?: string; body?: unknown; headers?: Record<string, string> };
async function raw(b: Boot, method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": b.address, ...o.headers };
  if (o.origin) headers.origin = o.origin;
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.csrf) headers["x-purss-csrf"] = o.csrf;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(b.server.base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}
const asApp = (b: Boot, token: string, method: string, path: string, body?: unknown, origin: string | null = "capacitor://localhost") =>
  raw(b, method, path, { token, origin, body });

function requestParams(client: "mobile" | "extension", redirect: string | null, extra: Record<string, string> = {}) {
  return {
    client, code_challenge: CHALLENGE, code_challenge_method: "S256", device_name: client === "mobile" ? "Pixel 8" : "Firefox on the laptop",
    ...(redirect ? { redirect_uri: redirect, state: "state-1234567890" } : {}), ...extra,
  };
}

/** The whole connection as an app and the person would do it; returns the device token. */
async function connect(b: Boot, client: "mobile" | "extension" = "mobile", opts: { redirect?: string | null; session?: TestSession } = {}): Promise<string> {
  const redirect = opts.redirect === undefined ? (client === "mobile" ? "purss://connect" : CHROME_REDIRECT) : opts.redirect;
  const approve = await call(b.app, b.server.base, "POST", "/api/connect/approve", opts.session ?? b.session, requestParams(client, redirect));
  assert.equal(approve.status, 200, approve.text);
  const code = redirect ? new URL(approve.json.redirectTo).searchParams.get("code")! : approve.json.code;
  const out = await raw(b, "POST", "/api/connect/token", { origin: client === "mobile" ? "capacitor://localhost" : "chrome-extension://abcdefghijklmnopabcdefghijklmnop", body: { client, code, codeVerifier: VERIFIER, ...(redirect ? { redirectUri: redirect } : {}) } });
  assert.equal(out.status, 200, out.text);
  return out.json.token;
}

test("an app connects with a one-time code and PKCE, then acts as its account without cookies or CSRF", async (t) => {
  const b = await boot();
  t.after(b.close);
  const query = new URLSearchParams(requestParams("mobile", "purss://connect")).toString();
  const summary = await call(b.app, b.server.base, "GET", `/api/connect/request?${query}`, b.session);
  assert.equal(summary.status, 200, summary.text);
  assert.equal(summary.json.client, "mobile");
  assert.equal(summary.json.deviceName, "Pixel 8");
  assert.equal(summary.json.redirect.uri, "purss://connect");
  const decline = new URL(summary.json.declineUrl);
  assert.deepEqual([decline.protocol, decline.searchParams.get("error"), decline.searchParams.get("state"), decline.searchParams.get("iss")], ["purss:", "access_denied", "state-1234567890", b.app.config.publicOrigin]);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 0, "looking at the request issues nothing");

  const approve = await call(b.app, b.server.base, "POST", "/api/connect/approve", b.session, requestParams("mobile", "purss://connect"));
  assert.equal(approve.status, 200, approve.text);
  const back = new URL(approve.json.redirectTo);
  assert.equal(`${back.protocol}//${back.host}`, "purss://connect");
  assert.equal(back.searchParams.get("state"), "state-1234567890");
  assert.equal(back.searchParams.get("iss"), b.app.config.publicOrigin);
  const code = back.searchParams.get("code")!;
  assert.ok(code.length >= 40);
  assert.equal(b.app.db.get<{ code_hash: string }>("SELECT code_hash FROM connect_codes")!.code_hash, sha256(code), "only the code's hash is stored");

  const exchange = await raw(b, "POST", "/api/connect/token", { origin: "capacitor://localhost", body: { client: "mobile", code, codeVerifier: VERIFIER, redirectUri: "purss://connect" } });
  assert.equal(exchange.status, 200, exchange.text);
  assert.equal(exchange.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.equal(exchange.headers.get("access-control-allow-credentials"), null);
  const token: string = exchange.json.token;
  assert.match(token, /^purss_dev_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([exchange.json.tokenType, exchange.json.device.kind, exchange.json.device.name], ["Bearer", "mobile", "Pixel 8"]);
  assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM device_tokens")).includes(token.slice(8)), "the token itself is never stored");
  assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM audit_events")).includes(token.slice(8)), "nor logged");

  // The code worked once.
  const again = await raw(b, "POST", "/api/connect/token", { body: { client: "mobile", code, codeVerifier: VERIFIER, redirectUri: "purss://connect" } });
  assert.deepEqual([again.status, again.json.error.code], [400, "invalid_grant"]);

  // Reads and changes work from the app's WebView origin, with no cookie and no CSRF header.
  const session = await asApp(b, token, "GET", "/api/session");
  assert.equal(session.json.account.id, b.owner.accountId);
  assert.equal(session.json.account.isAdmin, true, "the phone app of an administrator is an administrator, as the browser is");
  assert.equal(session.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.equal(session.headers.get("set-cookie"), null);
  assert.equal((await asApp(b, token, "GET", "/api/bootstrap")).status, 200);
  const basket = await asApp(b, token, "POST", "/api/baskets", { name: "From the phone" });
  assert.equal(basket.status, 200, basket.text);
  assert.equal((await asApp(b, token, "POST", "/api/baskets", { name: "Plain client" }, null)).status, 200, "a native client sends no Origin");

  const actions = b.app.db.all<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_events WHERE action IN ('connect_approve', 'device_connect') ORDER BY at, rowid").map((a) => `${a.action}:${a.outcome}`);
  assert.deepEqual(actions, ["connect_approve:success", "device_connect:success", "device_connect:failure"]);
});

test("codes are bound to the verifier, client and return address, expire, and burn on a wrong attempt", async (t) => {
  const b = await boot();
  t.after(b.close);
  assert.equal(s256(VERIFIER), CHALLENGE, "RFC 7636 test vector");
  assert.ok(verifierMatches(VERIFIER, CHALLENGE));
  assert.ok(!verifierMatches("short", CHALLENGE));
  assert.ok(!verifierMatches(VERIFIER + "x", CHALLENGE));

  const grant = (redirectUri: string | null) => ({ accountId: b.owner.accountId, kind: "mobile", clientId: null, redirectUri, label: "Phone", scope: null });
  const redeem = (code: string, over: Partial<{ codeVerifier: string; kind: string; redirectUri: string | null }> = {}) =>
    redeemCode(b.app, { code, codeVerifier: VERIFIER, kind: "mobile", clientId: null, redirectUri: "purss://connect", ...over });

  const wrongVerifier = issueCode(b.app, grant("purss://connect"), CHALLENGE, "redirect");
  assert.deepEqual(redeem(wrongVerifier, { codeVerifier: "A".repeat(43) }), { ok: false, reason: "verifier", accountId: b.owner.accountId });
  assert.deepEqual(redeem(wrongVerifier), { ok: false, reason: "unknown", accountId: null }, "a wrong verifier burned the code");

  assert.equal(redeem(issueCode(b.app, grant("purss://connect"), CHALLENGE, "redirect"), { kind: "extension" }).ok, false);
  assert.equal(redeem(issueCode(b.app, grant("purss://connect"), CHALLENGE, "redirect"), { redirectUri: "purss://connect/other" }).ok, false);
  assert.equal(redeem(issueCode(b.app, grant("purss://connect"), CHALLENGE, "redirect"), { redirectUri: null }).ok, false, "a redirect code can't be typed in");

  const expired = issueCode(b.app, grant("purss://connect"), CHALLENGE, "redirect");
  b.app.db.run("UPDATE connect_codes SET expires_at = ?", addSeconds(-1));
  assert.deepEqual(redeem(expired), { ok: false, reason: "expired", accountId: b.owner.accountId });

  // A typed code: short, forgiving of case and spacing, and still needs the verifier.
  const typed = issueCode(b.app, grant(null), CHALLENGE, "typed");
  assert.match(typed, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  assert.equal(redeem(typed, { redirectUri: "purss://connect" }).ok, false, "a typed code never goes with a return address");
  const typed2 = issueCode(b.app, grant(null), CHALLENGE, "typed");
  const ok = redeem(` ${typed2.toUpperCase().replace(/-/g, " ")} `, { redirectUri: null });
  assert.deepEqual(ok, { ok: true, grant: grant(null) });
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 1, "every code that was matched is gone; the one never matched waits to expire");

  assert.throws(() => issueCode(b.app, grant("purss://connect"), "not-a-challenge", "redirect"));
  assert.throws(() => issueCode(b.app, grant(null), CHALLENGE, "redirect"));

  // The typed form end to end, with an extension (Safari can't receive a redirect).
  const token = await connect(b, "extension", { redirect: null });
  assert.equal((await raw(b, "GET", "/api/baskets", { token, origin: "safari-web-extension://8C1F3C3A-1111-2222-3333-444455556666" })).status, 200);
});

test("the approval page refuses bad requests and never sends a code to an unknown address", async (t) => {
  const b = await boot();
  t.after(b.close);
  const approve = (body: Record<string, string>, s: TestSession | null = b.session, extra: Parameters<typeof call>[6] = {}) =>
    call(b.app, b.server.base, "POST", "/api/connect/approve", s, body, extra);
  for (const [client, uri] of [
    ["mobile", "https://evil.example/cb"], ["mobile", "purss://connect/x"], ["mobile", "purss://connect?next=x"], ["mobile", "PURSS://connect"],
    ["extension", "purss://connect"], ["extension", "http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"],
    ["extension", "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.example/"], ["extension", "https://evil.example/.chromiumapp.org/"],
    ["extension", "https://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP.chromiumapp.org/"], ["extension", `${CHROME_REDIRECT}?x=1`], ["extension", `${CHROME_REDIRECT}#x`],
    ["extension", "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org:444/"], ["extension", "https://u:p@abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"],
    ["extension", "http://127.0.0.1/mozoauth2/0123456789abcdef0123456789abcdef01234567"], ["extension", "https://zz.extensions.allizom.org/"],
  ] as const) {
    const r = await approve(requestParams(client, uri));
    assert.equal(r.status, 400, `${client} ${uri}`);
    const q = await call(b.app, b.server.base, "GET", `/api/connect/request?${new URLSearchParams(requestParams(client, uri))}`, b.session);
    assert.equal(q.status, 400, `request page ${uri}`);
  }
  assert.equal((await approve({ ...requestParams("mobile", "purss://connect"), state: "" })).status, 400, "state is required with a return address");
  assert.equal((await approve(requestParams("mobile", "purss://connect", { code_challenge_method: "plain" }))).status, 400, "S256 only");
  assert.equal((await approve(requestParams("mobile", "purss://connect", { code_challenge: "short" }))).status, 400);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 0, "no code was issued");

  // Approving is a same-origin request with the session's CSRF token and a recent sign-in.
  const good = requestParams("mobile", "purss://connect");
  assert.equal((await approve(good, { ...b.session, csrf: "wrong" })).json.error.code, "csrf");
  assert.equal((await approve(good, b.session, { headers: { origin: "https://evil.example" } })).json.error.code, "origin");
  assert.equal((await approve(good, b.session, { headers: { origin: "capacitor://localhost" } })).json.error.code, "origin", "an app origin gets no cookie powers");
  assert.equal((await approve(good, null)).status, 401);
  assert.equal((await approve(good, signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 }))).json.error.code, "step_up");
  assert.equal((await call(b.app, b.server.base, "GET", `/api/connect/request?${new URLSearchParams(good)}`, null)).status, 401);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 0);

  // The page itself can't be framed.
  const page = await raw(b, "GET", `/connect?${new URLSearchParams(good)}`);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  // Valid ones.
  assert.ok(checkRedirect("extension", CHROME_REDIRECT));
  assert.ok(checkRedirect("extension", `${CHROME_REDIRECT}cb`));
  assert.ok(checkRedirect("extension", "https://0123456789abcdef0123456789abcdef01234567.extensions.allizom.org/"));
  assert.equal(cleanDeviceName("mobile", "  My\u0000 phone\u202e\n  "), "My phone");
  assert.equal(cleanDeviceName("extension", "\u200b"), "Browser extension");
  assert.equal(cleanDeviceName("mobile", "x".repeat(200)).length, 80);
});

test("the phone app is a full sign-in: an administrator, confirm-it's-you like a session, only approving other apps stays with the browser", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await connect(b);
  const caller = resolveDeviceToken(b.app, token)!;
  requireRecentAuth(caller.principal); // just approved after a recent sign-in
  assert.equal(requireAdmin({ app: b.app, principal: caller.principal }).isAdmin, true);
  assert.equal((await asApp(b, token, "GET", "/api/account/security")).status, 200);
  assert.equal((await asApp(b, token, "GET", "/api/admin/accounts")).status, 200);
  assert.equal((await asApp(b, token, "GET", "/api/connect/devices")).status, 200);
  for (const [method, path] of [["POST", "/api/connect/approve"], ["GET", "/api/connect/request"]] as const) {
    const r = await asApp(b, token, method, path, method === "GET" ? undefined : {});
    assert.deepEqual([r.status, r.json?.error?.code], [403, "not_for_apps"], `${method} ${path}`);
  }

  // Ten minutes later it has to confirm it's you, and the app does that itself, as a session would.
  b.app.db.run("UPDATE device_tokens SET auth_at = ?", addSeconds(-3600));
  const change = { email: "app-changed@example.test" };
  const stale = await asApp(b, token, "PUT", "/api/account/email", change);
  assert.deepEqual([stale.status, stale.json.error.code], [403, "step_up"]);
  assert.equal((await asApp(b, token, "GET", "/api/account/security")).json.recentAuth, false);
  assert.equal((await asApp(b, token, "POST", "/api/auth/step-up/password", { password: "not the password" })).status, 401);
  assert.equal((await asApp(b, token, "POST", "/api/auth/step-up/password", { password: TEST_PASSWORD })).status, 200);
  assert.equal((await asApp(b, token, "GET", "/api/account/security")).json.recentAuth, true);
  const fresh = await asApp(b, token, "PUT", "/api/account/email", change);
  assert.equal(fresh.status, 200, fresh.text);

  // A connection with no recent sign-in recorded has to confirm first.
  b.app.db.run("UPDATE device_tokens SET auth_at = NULL");
  assert.throws(() => requireRecentAuth(resolveDeviceToken(b.app, token)!.principal), /confirm it's you/);

  // The extension is never an administrator or a recent sign-in.
  const ext = resolveDeviceToken(b.app, await connect(b, "extension"))!;
  assert.equal(ext.principal.isAdmin, false);
  assert.throws(() => requireRecentAuth(ext.principal), /confirm it's you/);
});

test("a device token can't reach a browser-only route through another spelling of its path", async (t) => {
  const b = await boot();
  t.after(b.close);
  const mobile = await connect(b);
  const extension = await connect(b, "extension");
  // Reaching a route means a JSON answer without an error; `/API/…` is not the API at all (the web app's page).
  const answered = (r: Awaited<ReturnType<typeof raw>>) => r.status < 300 && (r.json !== null || !String(r.headers.get("content-type")).startsWith("text/html"));
  // Each spelling either is the canonical route after URL parsing (dot segments; then the gate refuses
  // it) or names no route at all; none may reach a handler.
  const spellings = (p: string) => {
    const rest = p.slice("/api/".length);
    const [first, ...more] = rest.split("/");
    return [
      p, `/api//${rest}`, `/api/${first}//${more.join("/")}`, `${p}/`, `${p}//`, `/api/${rest.replace(/\//g, "%2F")}`,
      `/api/${rest.replace(/\//g, "%2f")}`, `/api/./${rest}`, `/api/x/../${rest}`, `/api/%2e/${rest}`, `/api/x/%2e%2e/${rest}`,
      `/API/${rest}`, `/api/${rest.toUpperCase()}`, `/api/${first!.charAt(0).toUpperCase()}${first!.slice(1)}/${more.join("/")}`, `/api\\${rest}`,
    ];
  };
  for (const [method, path] of [["GET", "/api/connect/request"], ["POST", "/api/connect/approve"]] as const) {
    for (const p of spellings(path)) {
      const r = await asApp(b, mobile, method, p, method === "GET" ? undefined : { name: "x", access: "write", enabled: true });
      assert.ok(!answered(r), `mobile ${method} ${p} -> ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  for (const [method, path] of [["GET", "/api/export"], ["GET", "/api/items"], ["GET", "/api/bootstrap"]] as const) {
    for (const p of spellings(path)) {
      const r = await raw(b, method, p, { token: extension, origin });
      assert.ok(!answered(r), `extension ${method} ${p} -> ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  // The canonical spellings of what a token may use still work, and a browser session gets no detour either.
  assert.equal((await asApp(b, mobile, "GET", "/api/baskets")).status, 200);
  assert.equal((await raw(b, "GET", "/api/baskets", { token: extension, origin })).status, 200);
  assert.equal((await asApp(b, mobile, "GET", "/api//account/security")).status, 404, "the phone app reaches account security only by its own path");
  const viaCookie = await call(b.app, b.server.base, "GET", "/api//account/security", b.session);
  assert.equal(viaCookie.status, 404);
});

test("the extension's token reaches only keeping, lookup, baskets, collections, search and following", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await connect(b, "extension");
  const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const basket = createBasket(b.app, b.owner, { name: "Reading", captureMode: "metadata" }).id;
  const ext = (method: string, path: string, body?: unknown) => raw(b, method, path, { token, origin, body });

  assert.equal((await ext("GET", "/api/baskets")).json[0].name, "Reading");
  assert.equal((await ext("GET", "/api/collections")).status, 200);
  assert.equal((await ext("GET", "/api/search?q=x")).status, 200);
  const kept = await ext("POST", "/api/items/manual", { url: "https://example.org/a?utm_source=x", basketId: basket });
  assert.deepEqual([kept.status, kept.json.existing], [200, false], kept.text);
  const lookup = await ext("GET", `/api/items/lookup?url=${encodeURIComponent("http://example.org/a#top")}`);
  assert.equal(lookup.json.item.id, kept.json.itemId);
  assert.deepEqual(lookup.json.item.baskets, [{ id: basket, name: "Reading" }]);
  const twice = await ext("POST", "/api/items/manual", { url: "https://example.org/a", basketId: basket });
  assert.deepEqual([twice.json.itemId, twice.json.existing, twice.json.alreadyInBasket], [kept.json.itemId, true, true]);

  for (const [method, path] of [
    ["GET", "/api/bootstrap"], ["GET", "/api/items"], [`GET`, `/api/items/${kept.json.itemId}`], ["PATCH", `/api/items/${kept.json.itemId}/state`],
    ["DELETE", `/api/items/${kept.json.itemId}/baskets/${basket}`], ["GET", "/api/export"], ["GET", "/api/events"], ["POST", "/api/baskets"],
    ["DELETE", "/api/sources/src_x"], ["PATCH", "/api/preferences"], ["POST", "/api/items/delete"],
  ] as const) {
    const r = await ext(method, path, method === "GET" ? undefined : {});
    assert.deepEqual([r.status, r.json?.error?.code], [403, "not_for_apps"], `${method} ${path}`);
  }
  assert.ok(deviceMayUse("extension", "POST", "/api/discover"));
  assert.ok(deviceMayUse("extension", "POST", "/api/sources"));
  assert.ok(deviceMayUse("extension", "HEAD", "/api/baskets"));
  assert.ok(!deviceMayUse("extension", "GET", "/api/baskets/x"));
  assert.ok(deviceMayUse("mobile", "GET", "/api/export"));
  assert.ok(deviceMayUse("mobile", "GET", "/api/assistant/tokens"));
  assert.ok(deviceMayUse("mobile", "DELETE", "/api/connect/devices/x"));
  assert.ok(!deviceMayUse("mobile", "POST", "/api/connect/approve"));
});

test("the extension keeps a page with its browser text, within the size limits", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await connect(b, "extension");
  const origin = "moz-extension://8c1f3c3a-1111-2222-3333-444455556666";
  const basket = createBasket(b.app, b.owner, { name: "Reading", captureMode: "metadata" }).id;
  const ext = (body: unknown) => raw(b, "POST", "/api/items/browser-capture", { token, origin, body });

  const kept = await ext({ url: "https://example.org/essay", basketId: basket, title: "Essay", html: "<p>Seen in the browser.</p><script>x()</script>" });
  assert.deepEqual([kept.status, kept.json.textSaved, kept.json.existing], [200, true, false], kept.text);
  assert.equal(kept.headers.get("access-control-allow-origin"), origin);
  const lookup = await raw(b, "GET", `/api/items/lookup?url=${encodeURIComponent("https://example.org/essay")}`, { token, origin });
  assert.ok(lookup.json.item.browserCapturedAt, "lookup tells the extension the text was captured");

  const tooLong = await ext({ url: "https://example.org/long", basketId: basket, html: "x".repeat(BROWSER_CAPTURE_MAX_CHARS + 1) });
  assert.equal(tooLong.status, 400);
  // A body past the limit is refused while it is still arriving (the answer comes before the upload ends).
  const tooBig = await new Promise<number>((resolve, reject) => {
    const r = request(b.server.base + "/api/items/browser-capture", { method: "POST", headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json", "x-forwarded-for": b.address } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end(JSON.stringify({ url: "https://example.org/big", basketId: basket, html: "\u0001".repeat(1_500_000) }));
  });
  assert.equal(tooBig, 413);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures")!.n, 1, "only the first one was stored");

  // The web app reaches it with its session as usual; a signed-out request is refused.
  const web = await call(b.app, b.server.base, "POST", "/api/items/browser-capture", b.session, { url: "https://example.org/web", basketId: basket, html: "<p>From the web app.</p>" }, { headers: { "x-forwarded-for": b.address } });
  assert.equal(web.status, 200, web.text);
  assert.equal((await call(b.app, b.server.base, "POST", "/api/items/browser-capture", null, { url: "https://example.org/x", basketId: basket, html: "<p>x</p>" })).status, 401);
});

test("a token acts only within its own account", async (t) => {
  const b = await boot();
  t.after(b.close);
  const other = makeOwner(b.app, { admin: false });
  const theirBasket = createBasket(b.app, other, { name: "Theirs", captureMode: "metadata" }).id;
  const theirItem = (await keepLink(b.app, other, { url: "https://private.example/diary", basketId: theirBasket }, async () => null)).itemId;
  const token = await connect(b);
  assert.equal((await asApp(b, token, "GET", `/api/items/${theirItem}`)).status, 404);
  assert.equal((await asApp(b, token, "GET", `/api/items/lookup?url=${encodeURIComponent("https://private.example/diary")}`)).json.item, null);
  assert.equal((await asApp(b, token, "POST", "/api/items/manual", { url: "https://private.example/diary", basketId: theirBasket })).status, 404);
  assert.equal((await asApp(b, token, "PUT", `/api/items/${theirItem}/baskets/${theirBasket}`)).status, 404);
  assert.ok(!(await asApp(b, token, "GET", "/api/baskets")).json.some((x: { id: string }) => x.id === theirBasket));
  // Their browser session can't disconnect this app.
  const mine = b.app.db.get<{ id: string }>("SELECT id FROM device_tokens")!.id;
  assert.equal((await call(b.app, b.server.base, "DELETE", `/api/connect/devices/${mine}`, signIn(b.app, other.accountId))).status, 404);
  assert.equal((await asApp(b, token, "GET", "/api/session")).status, 200, "still connected");
});

test("disconnecting, suspension and 90 idle days stop a token at the next request", async (t) => {
  const b = await boot();
  t.after(b.close);
  const settings = (method: string, path: string) => call(b.app, b.server.base, method, path, b.session);

  const first = await connect(b);
  const listed = await settings("GET", "/api/connect/devices");
  assert.equal(listed.json.length, 1);
  assert.deepEqual([listed.json[0].kind, listed.json[0].name, listed.json[0].current], ["mobile", "Pixel 8", false]);
  assert.equal((await asApp(b, first, "GET", "/api/session")).json.account.id, b.owner.accountId);
  assert.equal((await settings("DELETE", `/api/connect/devices/${listed.json[0].id}`)).status, 200);
  const gone = await asApp(b, first, "GET", "/api/session");
  assert.deepEqual([gone.status, gone.json.error.code], [401, "device_signed_out"]);
  assert.match(gone.headers.get("www-authenticate") ?? "", /invalid_token/);
  assert.equal(gone.headers.get("access-control-allow-origin"), "capacitor://localhost", "the app can read why");

  // The app disconnects itself.
  const second = await connect(b);
  assert.equal((await asApp(b, second, "GET", "/api/session")).status, 200);
  assert.equal((await asApp(b, second, "DELETE", "/api/connect/device")).status, 200);
  assert.equal((await asApp(b, second, "GET", "/api/session")).status, 401);
  assert.equal((await settings("DELETE", "/api/connect/device")).json.error.code, "not_device");

  // Suspension by an administrator disconnects the account's apps.
  const member = makeOwner(b.app, { admin: false });
  const memberSession = signIn(b.app, member.accountId);
  const third = await connect(b, "mobile", { session: memberSession });
  const suspend = await call(b.app, b.server.base, "PATCH", `/api/admin/accounts/${member.accountId}`, b.session, { status: "suspended" });
  assert.equal(suspend.status, 200, suspend.text);
  assert.equal((await asApp(b, third, "GET", "/api/session")).status, 401);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM device_tokens WHERE account_id = ?", member.accountId)!.n, 0);

  // Idle for 90 days.
  const fourth = await connect(b);
  b.app.db.run("UPDATE device_tokens SET last_used_at = ? WHERE account_id = ?", addSeconds(-90 * 86_400 - 60), b.owner.accountId);
  assert.equal((await asApp(b, fourth, "GET", "/api/session")).status, 401);
  assert.equal((await settings("GET", "/api/connect/devices")).json.length, 0, "and it isn't listed");
  purgeIdleDevices(b.app);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM device_tokens")!.n, 0);
  const audit = b.app.db.all<{ detail: string }>("SELECT detail FROM audit_events WHERE action = 'device_revoke' ORDER BY rowid").map((a) => a.detail);
  assert.deepEqual(audit, ["settings", "self"]);
});

test("use moves the idle limit along, at most hourly", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await connect(b);
  const old = addSeconds(-80 * 86_400);
  b.app.db.run("UPDATE device_tokens SET last_used_at = ?", old);
  assert.equal((await asApp(b, token, "GET", "/api/session")).status, 200);
  const after = b.app.db.get<{ last_used_at: string }>("SELECT last_used_at FROM device_tokens")!.last_used_at;
  assert.ok(after > old);
  assert.equal((await asApp(b, token, "GET", "/api/session")).status, 200);
  assert.equal(b.app.db.get<{ last_used_at: string }>("SELECT last_used_at FROM device_tokens")!.last_used_at, after, "not rewritten within the hour");
});

test("a bearer request ignores cookies and never falls back to them; other Authorization headers change nothing", async (t) => {
  const b = await boot();
  t.after(b.close);
  const other = makeOwner(b.app, { admin: false });
  const otherSession = signIn(b.app, other.accountId);
  const token = await connect(b);
  const mixed = await raw(b, "GET", "/api/session", { token, cookie: otherSession.cookie });
  assert.equal(mixed.json.account.id, b.owner.accountId, "the token decides, not the cookie");
  const bad = await raw(b, "GET", "/api/session", { token: "purss_dev_not-a-real-token", cookie: otherSession.cookie });
  assert.equal(bad.status, 401, "an invalid token is refused, not replaced by the cookie");
  // A reverse proxy's Basic credentials, or an assistant token, don't make a request a device request.
  const basic = await raw(b, "GET", "/api/session", { cookie: otherSession.cookie, headers: { authorization: "Basic dXNlcjpwYXNz" } });
  assert.equal(basic.json.account.id, other.accountId);
  const mcp = await raw(b, "POST", "/api/baskets", { token: "purss_mcp_something", cookie: otherSession.cookie, origin: "capacitor://localhost", body: { name: "x" } });
  assert.equal(mcp.json.error.code, "origin", "still a cookie request with all its checks");
});

test("cookie requests keep every protection and CORS answers only token requests from app origins", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await connect(b);
  const cookie = { cookie: b.session.cookie, csrf: b.session.csrf };
  // Cookie mutations from an app or foreign origin, or with no origin, are refused as before.
  for (const origin of ["capacitor://localhost", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "https://evil.example", null]) {
    const r = await raw(b, "POST", "/api/baskets", { ...cookie, origin, body: { name: "x" } });
    assert.deepEqual([r.status, r.json.error.code], [403, "origin"], String(origin));
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  const read = await raw(b, "GET", "/api/session", { ...cookie, origin: "capacitor://localhost" });
  assert.equal(read.headers.get("access-control-allow-origin"), null, "a cookie response is never exposed cross-origin");
  assert.equal((await raw(b, "POST", "/api/baskets", { ...cookie, origin: b.app.config.publicOrigin, body: { name: "Same origin" } })).status, 200);

  // Preflights.
  const preflight = (origin: string, method: string, path: string, headers: string) =>
    raw(b, "OPTIONS", path, { origin, headers: { "access-control-request-method": method, "access-control-request-headers": headers } });
  const ok = await preflight("moz-extension://8c1f3c3a-1111-2222-3333-444455556666", "POST", "/api/items/manual", "authorization, content-type");
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "moz-extension://8c1f3c3a-1111-2222-3333-444455556666");
  assert.match(ok.headers.get("access-control-allow-headers") ?? "", /authorization/);
  assert.equal(ok.headers.get("access-control-allow-credentials"), null);
  assert.equal((await preflight("capacitor://localhost", "POST", "/api/connect/token", "content-type")).status, 204, "the code exchange needs no token");
  const noToken = await preflight("capacitor://localhost", "POST", "/api/baskets", "content-type, x-purss-csrf");
  assert.deepEqual([noToken.status, noToken.headers.get("access-control-allow-origin")], [403, null], "a cookie-style request gets no CORS");
  const evil = await preflight("https://evil.example", "POST", "/api/baskets", "authorization");
  assert.deepEqual([evil.status, evil.headers.get("access-control-allow-origin")], [403, null]);
  for (const origin of ["https://localhost:8443", "http://localhost.evil.example", "capacitor://evil", "chrome-extension://a/b", "tauri://evil", "http://tauri.localhost:8080", "https://tauri.localhost.evil.example"]) {
    assert.equal(isClientOrigin(origin), false, origin);
  }
  // The desktop app's page (plan/42).
  for (const origin of ["tauri://localhost", "http://tauri.localhost"]) assert.equal(isClientOrigin(origin), true, origin);

  // A token sent from an ordinary web page is refused.
  const fromPage = await raw(b, "GET", "/api/session", { token, origin: "https://evil.example" });
  assert.deepEqual([fromPage.status, fromPage.json.error.code, fromPage.headers.get("access-control-allow-origin")], [403, "origin", null]);
  // From the PURSS's own origin it works without CORS headers.
  const own = await raw(b, "GET", "/api/session", { token, origin: b.app.config.publicOrigin });
  assert.deepEqual([own.status, own.headers.get("access-control-allow-origin")], [200, null]);
});

test("connect info tells an app it found a PURSS, with no secrets and no sign-in", async (t) => {
  const b = await boot();
  t.after(b.close);
  const r = await raw(b, "GET", "/api/connect/info", { origin: "moz-extension://8c1f3c3a-1111-2222-3333-444455556666", cookie: b.session.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "moz-extension://8c1f3c3a-1111-2222-3333-444455556666");
  assert.equal(r.json.service, "purss");
  assert.equal(r.json.origin, b.app.config.publicOrigin);
  assert.deepEqual(r.json.connect.codeChallengeMethods, ["S256"]);
  assert.deepEqual(r.json.connect.clients.mobile.redirectUris, ["purss://connect"]);
  assert.equal(r.json.connect.token, `${b.app.config.publicOrigin}/api/connect/token`);
  assert.deepEqual(r.json.features, { urlLookup: true, browserCapture: true });
  assert.deepEqual(r.json.signup, { endpoint: `${b.app.config.publicOrigin}/api/connect/signup`, start: null, passwordMin: 10 });
  assert.ok(!r.text.includes(b.owner.accountId), "nothing about the person, even with a cookie");
});

test("an account can connect at most 20 apps", async (t) => {
  const b = await boot();
  t.after(b.close);
  for (let i = 0; i < MAX_DEVICES; i++) createDeviceToken(b.app, b.owner.accountId, "mobile", `Phone ${i}`);
  const r = await call(b.app, b.server.base, "POST", "/api/connect/approve", b.session, requestParams("mobile", "purss://connect"));
  assert.deepEqual([r.status, r.json.error.code], [409, "too_many_devices"]);
  assert.throws(() => createDeviceToken(b.app, b.owner.accountId, "mobile", "One more"), /up to 20/);
});

test("the code exchange is rate-limited per address", async (t) => {
  const b = await boot();
  t.after(b.close);
  let limited = 0;
  for (let i = 0; i < 32; i++) {
    const r = await raw(b, "POST", "/api/connect/token", { body: { client: "mobile", code: `guess-${i}`, codeVerifier: VERIFIER, redirectUri: "purss://connect" } });
    if (r.status === 429) limited++;
    else assert.equal(r.status, 400);
  }
  assert.equal(limited, 2, "30 attempts per 10 minutes");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'device_connect' AND outcome = 'failure'")!.n, 30);
});

test("the live event stream takes a token and ends when the app is disconnected", async (t) => {
  const b = await boot();
  t.after(b.close);
  const server = publicServer(b.app, [publicRouter(), ...extraRouters.api()], { events: eventStream });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await connect(b);
  const extension = await connect(b, "extension");

  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}`, origin: "capacitor://localhost" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("access-control-allow-origin"), "capacitor://localhost");
  const reader = res.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  const id = b.app.db.get<{ id: string }>("SELECT id FROM device_tokens WHERE kind = 'mobile'")!.id;
  assert.equal((await call(b.app, b.server.base, "DELETE", `/api/connect/devices/${id}`, b.session)).status, 200);
  assert.equal((await reader.read()).done, true, "the stream ended");

  assert.equal((await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${extension}` } })).status, 403, "not for the extension");
});


test("a linked sign-in returns only to a path on this PURSS", () => {
  assert.equal(safeReturnPath("/connect?client=mobile"), "/connect?client=mobile");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/a\nb", "", null, undefined]) assert.equal(safeReturnPath(bad), null, String(bad));
});

const signupBody = (invitation: string, over: Record<string, unknown> = {}) => ({ client: "mobile", invitation, email: "invited@example.test", displayName: "Robin", password: "a long enough secret", deviceName: "Pixel 8", ...over });

test("the app creates an account with an invitation and is connected at once, with its password for the browser and no recovery codes", async (t) => {
  const b = await boot();
  t.after(b.close);
  const code = createInvite(b.app, b.owner.accountId, "invited@example.test", null, null);
  const r = await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", cookie: b.session.cookie, body: signupBody(code) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.deepEqual(Object.keys(r.json).sort(), ["device", "token", "tokenType"], "a device token and nothing else: no recovery codes");
  assert.equal(r.json.device.name, "Pixel 8");
  const acct = b.app.db.get<{ account_id: string }>("SELECT account_id FROM device_tokens WHERE id = ?", r.json.device.id)!.account_id;
  assert.notEqual(acct, b.owner.accountId, "a new account, not the one whose cookie came along");
  assert.equal(b.app.db.get<{ display_name: string }>("SELECT display_name FROM accounts WHERE id = ?", acct)!.display_name, "Robin");
  assert.deepEqual(b.app.db.all<{ kind: string; label: string | null }>("SELECT kind, label FROM sign_in_methods WHERE account_id = ?", acct).map((m) => [m.kind, m.label]), [["password", null]], "made with its password and nothing else");
  assert.equal(b.app.db.get<{ email: string }>("SELECT email FROM accounts WHERE id = ?", acct)!.email, "invited@example.test", "and the invited address");
  assert.equal(b.app.db.get("SELECT 1 FROM role_grants WHERE account_id = ?", acct), undefined, "never an administrator");

  const me = await asApp(b, r.json.token, "GET", "/api/session");
  assert.equal(me.json.account.id, acct);
  assert.equal(me.json.account.hasPassword, true);
  requireRecentAuth(resolveDeviceToken(b.app, r.json.token)!.principal); // choosing the password counts as signing in

  // The password works in a browser.
  const signedIn = await raw(b, "POST", "/api/auth/password", { origin: b.app.config.publicOrigin, body: { email: "Invited@Example.test", password: "a long enough secret" } });
  assert.equal(signedIn.status, 200, signedIn.text);
  // The invitation is used up.
  const again = await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(code) });
  assert.equal(again.status, 403);
});

test("a refused sign-up leaves nothing behind: another address, a taken address, a bad invitation, a weak password", async (t) => {
  const b = await boot();
  t.after(b.close);
  const accounts = () => b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n;
  const before = accounts();
  const first = createInvite(b.app, b.owner.accountId, "invited@example.test", null, null);
  const second = createInvite(b.app, b.owner.accountId, "second@example.test", null, null);
  const unused = () => b.app.db.get("SELECT used_at FROM invites WHERE id = ?", sha256(normalizeCode(second)))?.used_at ?? null;
  assert.equal((await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(first) })).status, 200);
  assert.equal((await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(second) })).json.error.code, "invite_email", "only the address it was made for");
  b.app.db.run("UPDATE accounts SET email = 'second@example.test' WHERE id = ?", b.owner.accountId);
  const taken = await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(second, { email: "second@example.test" }) });
  assert.equal(taken.json.error.code, "email_in_use");
  assert.equal(accounts(), before + 1, "the account for the taken address was rolled back");
  assert.equal(unused(), null, "and its invitation still works");
  b.app.db.run("UPDATE accounts SET email = 'owner@example.test' WHERE id = ?", b.owner.accountId);
  assert.equal((await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(second, { email: "second@example.test", password: "short" }) })).json.error.code, "short_password");
  assert.equal((await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody("NOPE-NOPE", { email: "second@example.test" }) })).status, 403);
  assert.equal((await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: { ...signupBody("x"), invitation: undefined } })).status, 400, "an invitation is needed: open sign-up starts by email");
  assert.equal(accounts(), before + 1);
  // It used up the invitation only once it worked.
  assert.equal(unused(), null);
  assert.equal((await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(second, { email: "second@example.test" }) })).status, 200);
});

test("the recovery-code endpoints are gone, for the browser and for the app", async (t) => {
  const b = await boot();
  t.after(b.close);
  for (const path of ["/api/auth/recovery", "/api/auth/step-up/recovery", "/api/account/recovery-codes", "/api/account/recovery-codes/acknowledge", "/api/connect/recovery-codes/acknowledge"]) {
    const r = await raw(b, "POST", path, { origin: b.app.config.publicOrigin, cookie: b.session.cookie, csrf: b.session.csrf, body: { code: "abcd-abcd-abcd-abcd", generation: 1 } });
    assert.equal(r.status, 404, path);
  }
  const app = await raw(b, "POST", "/api/connect/signin", { origin: "capacitor://localhost", body: { client: "mobile", method: "recovery", code: "abcd-abcd-abcd-abcd" } });
  assert.equal(app.status, 400, "the app can sign in with a password or a passkey only");
  const info = await raw(b, "GET", "/api/connect/info");
  assert.deepEqual(info.json.signin.methods, ["password"]);
});

test("open sign-up from the app starts by email, like the browser, and the link finishes it", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_TRUST_PROXY: "1", PURSS_MODE: "hosted", PURSS_SIGNUP: "open", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" });
  const sent: { to: string; subject: string }[] = [];
  useTransport(app, { send: async (m) => { sent.push({ to: String(m.to), subject: m.subject }); }, verify: async () => {} });
  await checkMail(app);
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  t.after(async () => { await settleMail(app); await server.close(); cleanup(); });
  const info = await (await fetch(`${server.base}/api/connect/info`)).json() as { signup: { start: string | null } };
  assert.equal(info.signup.start, `${app.config.publicOrigin}/api/signup/start`);
  const r = await fetch(`${server.base}/api/signup/start`, { method: "POST", headers: { origin: "capacitor://localhost", "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify({ email: "first@example.org" }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "capacitor://localhost", "the app may call it before it is connected");
  await settleMail(app);
  assert.deepEqual(sent, [{ to: "first@example.org", subject: "Finish creating your PURSS account" }]);
  assert.equal(app.db.get("SELECT 1 FROM accounts WHERE email = 'first@example.org'"), undefined, "no account until the link is used");
});

test("the app signs in with an email address and password and is connected, with the browser's checks", async (t) => {
  const b = await boot();
  t.after(b.close);
  const code = createInvite(b.app, b.owner.accountId, "invited@example.test", null, null);
  const made = await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(code) });
  const acct = b.app.db.get<{ account_id: string }>("SELECT account_id FROM device_tokens WHERE id = ?", made.json.device.id)!.account_id;
  const signin = (body: unknown) => raw(b, "POST", "/api/connect/signin", { origin: "capacitor://localhost", cookie: b.session.cookie, body });

  const wrong = await signin({ client: "mobile", method: "password", email: "invited@example.test", password: "not the secret" });
  assert.equal(wrong.json.error.code, "bad_password");
  const ok = await signin({ client: "mobile", method: "password", email: "Invited@Example.test", password: "a long enough secret", deviceName: "Tablet" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.equal((await asApp(b, ok.json.token, "GET", "/api/session")).json.account.id, acct, "the account that signed in, not the cookie's");
  assert.equal(ok.json.device.name, "Tablet");

  // A suspended account isn't signed in to, and nothing is spent by the refusal.
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", acct);
  assert.equal((await signin({ client: "mobile", method: "password", email: "invited@example.test", password: "a long enough secret" })).json.error.code, "suspended");
  b.app.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", acct);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'sign_in' AND target = 'app-password' AND outcome = 'failure'")!.n, 1, "only the wrong password was a failure");

  // Signing in counts as confirming it's you, for ten minutes, as in a browser.
  assert.equal((await asApp(b, ok.json.token, "PUT", "/api/account/email", { email: "robin2@example.test" })).status, 200);
  b.app.db.run("UPDATE device_tokens SET auth_at = ?", addSeconds(-3600));
  assert.equal((await asApp(b, ok.json.token, "PUT", "/api/account/email", { email: "robin3@example.test" })).json.error.code, "step_up");
  // Changing the password takes the current one instead, however long ago it signed in.
  assert.equal((await asApp(b, ok.json.token, "PUT", "/api/account/password", { currentPassword: "a long enough secret", password: "another long enough secret" })).status, 200);
});

test("signing in from the app shares the browser's limits per network address and per email address", async (t) => {
  const b = await boot();
  t.after(b.close);
  for (let i = 0; i < 10; i++) await raw(b, "POST", "/api/auth/password", { origin: b.app.config.publicOrigin, body: { email: "someone@example.org", password: "guess" } });
  const r = await raw(b, "POST", "/api/connect/signin", { origin: "capacitor://localhost", body: { client: "mobile", method: "password", email: "SOMEONE@example.org", password: "guess" } });
  assert.equal(r.status, 429);
});

test("the app can ask for a password reset email where the server sends email, with the same answer whether or not the account exists", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_TRUST_PROXY: "1", PURSS_MODE: "hosted", PURSS_SMTP_HOST: "smtp.example.org", PURSS_MAIL_FROM: "PURSS <ws@example.org>" });
  useTransport(app, { send: async () => {}, verify: async () => {} });
  await checkMail(app);
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  t.after(async () => { await settleMail(app); await server.close(); cleanup(); });
  const info = await (await fetch(`${server.base}/api/connect/info`)).json() as { signin: { passwordReset: string | null } };
  assert.equal(info.signin.passwordReset, `${app.config.publicOrigin}/api/password-reset`);
  const r = await fetch(`${server.base}/api/password-reset`, { method: "POST", headers: { origin: "capacitor://localhost", "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@example.org" }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.deepEqual(await r.json(), { ok: true });
});

test("a PURSS without email for accounts doesn't offer the app a password reset", async (t) => {
  const b = await boot();
  t.after(b.close);
  assert.equal((await raw(b, "GET", "/api/connect/info")).json.signin.passwordReset, null);
});

test("signing in from the app to an account set to be deleted offers to keep it, and keeping it connects the app", async (t) => {
  const b = await boot();
  t.after(b.close);
  const made = await raw(b, "POST", "/api/connect/signup", { origin: "capacitor://localhost", body: signupBody(createInvite(b.app, b.owner.accountId, "invited@example.test", null, null)) });
  const acct = b.app.db.get<{ account_id: string }>("SELECT account_id FROM device_tokens WHERE id = ?", made.json.device.id)!.account_id;
  const del = await asApp(b, made.json.token, "POST", "/api/account/deletion", { confirm: "Robin" });
  assert.equal(del.status, 200, del.text);
  assert.equal((await asApp(b, made.json.token, "GET", "/api/session")).status, 401, "deleting signs the app out");

  const signin = await raw(b, "POST", "/api/connect/signin", { origin: "capacitor://localhost", body: { client: "mobile", method: "password", email: "invited@example.test", password: "a long enough secret" } });
  assert.equal(signin.status, 409);
  assert.equal(signin.json.error.code, "deletion_pending");
  assert.ok(signin.json.error.keepToken && signin.json.error.dueAt);
  assert.ok(b.app.db.get("SELECT 1 FROM account_deletions WHERE account_id = ?", acct), "nothing changed yet");

  const kept = await raw(b, "POST", "/api/connect/keep-account", { origin: "capacitor://localhost", body: { client: "mobile", keepToken: signin.json.error.keepToken, deviceName: "Pixel" } });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(b.app.db.get("SELECT 1 FROM account_deletions WHERE account_id = ?", acct), undefined, "the deletion is cancelled");
  assert.equal((await asApp(b, kept.json.token, "GET", "/api/session")).json.account.id, acct);
  assert.equal((await raw(b, "POST", "/api/connect/keep-account", { origin: "capacitor://localhost", body: { client: "mobile", keepToken: signin.json.error.keepToken } })).json.error.code, "cancel_expired", "the token works once");
});
