import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeOwner, makeTestApp } from "../testing.ts";
import { call, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { extraRouters } from "../routes/index.ts";
import { loadConfig } from "../config.ts";
import { addSeconds } from "../http.ts";
import { sha256 } from "../secrets.ts";
import { TOOLS } from "../mcp/tools.ts";
import { createDeviceToken } from "../connect/devices.ts";
import { REFRESHES_PER_ACCOUNT_PER_HOUR, REFRESHES_PER_GRANT_PER_HOUR, purgeOAuth } from "./grants.ts";
import { isAcceptableRedirect, isClientIdUrl, matchRedirect, parseDocument, resolveClient } from "./clients.ts";
import { CHALLENGE, VERIFIER, startClientSite } from "./testing.ts";
import type { ClientSite } from "./testing.ts";

const HOSTED_CALLBACK = "/api/mcp/auth_callback";

async function boot(env: Record<string, string> = { PURSS_ASSISTANT_OAUTH: "on" }) {
  // A built page to serve, so the consent page's response headers can be checked.
  const web = mkdtempSync(path.join(os.tmpdir(), "purss-oauth-web-"));
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>PURSS</title>");
  const { app, cleanup } = makeTestApp({ PURSS_WEB_DIST: web, ...env });
  const owner = makeOwner(app, { admin: true });
  const server = await startTestServer(app, extraRouters.api(), extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const site = await startClientSite();
  const redirect = `${site.origin()}${HOSTED_CALLBACK}`;
  const clientId = site.document("/oauth/client.json", { client_name: "Helpful Assistant", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  const api = (method: string, p: string, body?: unknown, s: TestSession = session) => call(app, server.base, method, p, s, body === undefined && method !== "GET" ? {} : body);
  return {
    app, owner, server, session, site, redirect, clientId, api,
    close: async () => { await site.close(); await server.close(); cleanup(); rmSync(web, { recursive: true, force: true }); },
  };
}
type Boot = Awaited<ReturnType<typeof boot>>;

/** Both plan/23 switches on for the session's account. */
async function switchesOn(b: Boot, s: TestSession = b.session) {
  assert.equal((await b.api("PUT", "/api/admin/assistant", { enabled: true })).status, 200);
  assert.equal((await b.api("PUT", "/api/assistant", { enabled: true }, s)).status, 200);
}

function authorizeParams(b: Boot, over: Record<string, string | undefined> = {}): Record<string, string> {
  const p: Record<string, string | undefined> = {
    response_type: "code", client_id: b.clientId, redirect_uri: b.redirect, state: "state-from-the-assistant",
    code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "read write", resource: `${b.app.config.publicOrigin}/mcp`, ...over,
  };
  return Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => e[1] !== undefined));
}

const summary = (b: Boot, params: Record<string, string>, s?: TestSession) => b.api("GET", `/api/assistant/oauth/request?${new URLSearchParams(params)}`, undefined, s);
const approve = (b: Boot, params: Record<string, string>, access: "read" | "write" = "write", s?: TestSession) => b.api("POST", "/api/assistant/oauth/approve", { request: params, access }, s);

async function form(b: Boot, p: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${b.server.base}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
}

/** Approve on the consent page and return the code from the redirect. */
async function codeFor(b: Boot, access: "read" | "write" = "write", over: Record<string, string | undefined> = {}, s?: TestSession): Promise<string> {
  const r = await approve(b, authorizeParams(b, over), access, s);
  assert.equal(r.status, 200, r.text);
  const back = new URL(r.json.redirectTo);
  assert.equal(`${back.origin}${back.pathname}`, over.redirect_uri ?? b.redirect);
  assert.equal(back.searchParams.get("state"), "state-from-the-assistant");
  assert.equal(back.searchParams.get("iss"), b.app.config.publicOrigin);
  return back.searchParams.get("code")!;
}

const exchange = (b: Boot, code: string, over: Record<string, string> = {}) =>
  form(b, "/oauth/token", { grant_type: "authorization_code", code, redirect_uri: b.redirect, client_id: b.clientId, code_verifier: VERIFIER, resource: `${b.app.config.publicOrigin}/mcp`, ...over });
const refresh = (b: Boot, token: string, over: Record<string, string> = {}) =>
  form(b, "/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: b.clientId, ...over });

async function connect(b: Boot, access: "read" | "write" = "write", s?: TestSession) {
  const out = await exchange(b, await codeFor(b, access, {}, s));
  assert.equal(out.status, 200, out.text);
  return out.json as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
}

async function mcp(b: Boot, token: string | null, method = "tools/list", params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${b.server.base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

test("an assistant discovers the server from /mcp's 401, and the metadata describes a public-client, PKCE-only server", async (t) => {
  const b = await boot();
  t.after(b.close);
  const origin = b.app.config.publicOrigin;
  const challenge = await mcp(b, null);
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers.get("www-authenticate"), `Bearer realm="PURSS", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`);
  for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const prm = await (await fetch(`${b.server.base}${p}`)).json();
    assert.deepEqual(prm, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_name: "PURSS" });
  }
  const as = await (await fetch(`${b.server.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, origin, "the issuer is exactly the URL the metadata was found under");
  assert.equal(as.authorization_endpoint, `${origin}/app/oauth/authorize`);
  assert.deepEqual([as.code_challenge_methods_supported, as.token_endpoint_auth_methods_supported, as.grant_types_supported], [["S256"], ["none"], ["authorization_code", "refresh_token"]]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.equal(as.registration_endpoint, undefined, "no dynamic client registration");
  assert.equal((await fetch(`${b.server.base}/.well-known/oauth-authorization-server`, { method: "POST" })).status, 405);
});

test("with OAuth off (the self-hosted default) none of it exists and tokens work exactly as before", async (t) => {
  const b = await boot({});
  t.after(b.close);
  assert.equal(b.app.config.assistantOAuth, false);
  assert.equal((await mcp(b, null)).headers.get("www-authenticate"), 'Bearer realm="PURSS"');
  for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) assert.equal((await fetch(`${b.server.base}${p}`)).status, 404);
  assert.equal((await form(b, "/oauth/token", { grant_type: "refresh_token" })).status, 404);
  await switchesOn(b);
  const s = await summary(b, authorizeParams(b));
  assert.deepEqual([s.json.kind, s.json.redirectTo], ["error", null]);
  assert.equal((await approve(b, authorizeParams(b))).status, 400);
  assert.equal(b.site.hits("/oauth/client.json"), 0, "nothing was fetched");
  const access = await b.api("GET", "/api/assistant");
  assert.deepEqual([access.json.oauth, access.json.grants], [false, []]);
  // A token minted while OAuth was on stops when the operator turns it off.
  b.app.config.assistantOAuth = true;
  const tokens = await connect(b);
  assert.equal((await mcp(b, tokens.access_token)).status, 200);
  b.app.config.assistantOAuth = false;
  assert.equal((await mcp(b, tokens.access_token)).status, 401);
});

test("the full flow: consent, code, token, MCP as the account's principal, rotation, revocation", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  await switchesOn(b);

  const s = await summary(b, authorizeParams(b));
  assert.equal(s.status, 200, s.text);
  assert.deepEqual({ ...s.json, declineUrl: undefined }, {
    kind: "ask", request: authorizeParams(b), clientId: b.clientId, clientName: "Helpful Assistant", clientHost: new URL(b.clientId).host, redirectHost: new URL(b.redirect).host,
    loopbackRedirect: false, access: "write", declineUrl: undefined, available: true, enabled: true,
  });
  const decline = new URL(s.json.declineUrl);
  assert.deepEqual([decline.searchParams.get("error"), decline.searchParams.get("state"), decline.searchParams.get("iss")], ["access_denied", "state-from-the-assistant", b.app.config.publicOrigin]);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 0, "looking issues nothing");

  const code = await codeFor(b);
  assert.equal(b.app.db.get<{ code_hash: string }>("SELECT code_hash FROM connect_codes")!.code_hash, sha256(code), "only the code's hash is stored");
  const tokens = await exchange(b, code);
  assert.equal(tokens.status, 200, tokens.text);
  assert.equal(tokens.headers.get("cache-control"), "no-store");
  assert.deepEqual([tokens.json.token_type, tokens.json.expires_in, tokens.json.scope], ["Bearer", 3600, "write"]);
  assert.match(tokens.json.access_token, /^purss_oat_/);
  assert.match(tokens.json.refresh_token, /^purss_ort_/);
  const stored = JSON.stringify([b.app.db.all("SELECT * FROM oauth_access_tokens"), b.app.db.all("SELECT * FROM oauth_grants")]);
  assert.ok(!stored.includes(tokens.json.access_token) && !stored.includes(tokens.json.refresh_token), "only hashes at rest");

  const list = await mcp(b, tokens.json.access_token);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.result.tools.map((x: { name: string }) => x.name), TOOLS.map((x) => x.name));
  const found = await mcp(b, tokens.json.access_token, "tools/call", { name: "search_items", arguments: { query: "sediment" } });
  assert.equal(found.json.result.isError, false);
  assert.ok(found.json.result.structuredContent.items.length > 0);
  const grantId = b.app.db.get<{ id: string }>("SELECT id FROM oauth_grants")!.id;
  const made = await mcp(b, tokens.json.access_token, "tools/call", { name: "create_basket", arguments: { name: "From the assistant" } });
  assert.equal(made.json.result.isError, false, JSON.stringify(made.json));
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_create_basket' AND detail = ?", `token ${grantId}`), "write calls are audited with the grant");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_oauth_approve'"));
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_created' AND outcome = 'success'"));

  // Never an administrator, never a recent sign-in, never a cookie or device credential on /api.
  for (const p of ["/api/admin/assistant", "/api/assistant", "/api/session"]) {
    const r = await fetch(`${b.server.base}${p}`, { headers: { authorization: `Bearer ${tokens.json.access_token}` } });
    assert.ok(r.status === 401 || (p === "/api/session" && !(await r.json()).account), `${p} doesn't accept it`);
  }

  // Settings lists the assistant next to tokens.
  const settings = await b.api("GET", "/api/assistant");
  assert.equal(settings.json.oauth, true);
  assert.deepEqual(settings.json.grants.map((g: Record<string, unknown>) => [g.clientName, g.clientHost, g.redirectHost, g.access]),
    [["Helpful Assistant", new URL(b.clientId).host, new URL(b.redirect).host, "write"]]);

  // Rotation: a new pair each time; the old access token lives out its hour.
  const next = await refresh(b, tokens.json.refresh_token);
  assert.equal(next.status, 200, next.text);
  assert.notEqual(next.json.refresh_token, tokens.json.refresh_token);
  assert.equal((await mcp(b, next.json.access_token)).status, 200);
  assert.equal((await mcp(b, tokens.json.access_token)).status, 200);

  // Revocation (RFC 7009) ends the whole grant; unknown tokens are not an error.
  assert.equal((await form(b, "/oauth/revoke", { token: next.json.refresh_token, client_id: b.clientId })).status, 200);
  assert.equal((await mcp(b, next.json.access_token)).status, 401);
  assert.equal((await mcp(b, tokens.json.access_token)).status, 401);
  assert.equal((await refresh(b, next.json.refresh_token)).json.error, "invalid_grant");
  assert.equal((await form(b, "/oauth/revoke", { token: "purss_oat_unknown" })).status, 200);
  assert.equal((await form(b, "/oauth/revoke", {})).status, 400);
  assert.deepEqual((await b.api("GET", "/api/assistant")).json.grants, []);
});

test("a read-only grant behaves exactly like a read-only token", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const tokens = await connect(b, "read");
  assert.equal(tokens.scope, "read", "the person allowed less than the assistant asked for");
  const tools = (await mcp(b, tokens.access_token)).json.result.tools.map((x: { name: string }) => x.name);
  assert.deepEqual(tools, TOOLS.filter((x) => x.access === "read").map((x) => x.name));
  const write = await mcp(b, tokens.access_token, "tools/call", { name: "create_basket", arguments: { name: "x" } });
  assert.equal(write.json.result.isError, true);
  assert.match(write.json.result.content[0].text, /can only read/);
  // Asking again on refresh for what was never allowed doesn't widen it.
  const again = await refresh(b, tokens.refresh_token, { scope: "read write" });
  assert.equal(again.json.scope, "read");
  // The person can't allow more than the assistant asked for.
  assert.equal((await approve(b, authorizeParams(b, { scope: "read" }), "write")).json.error.code, "oauth_scope");
  assert.equal((await summary(b, authorizeParams(b, { scope: undefined }))).json.access, "read", "no scope means reading only");
});

test("redirect URIs: exact match against the client's document, never an open redirect", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const before = b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n;
  for (const bad of [
    "https://evil.example/api/mcp/auth_callback",
    `${b.site.origin("other.example")}${HOSTED_CALLBACK}`,
    `${b.redirect}/extra`,
    `${b.redirect}?x=1`,
    `${b.redirect}#frag`,
    b.redirect.toUpperCase(),
    b.redirect.replace(/:\d+\//, ":1/"),
  ]) {
    const s = await summary(b, authorizeParams(b, { redirect_uri: bad }));
    assert.deepEqual([s.json.kind, s.json.redirectTo], ["error", null], bad);
    const a = await approve(b, authorizeParams(b, { redirect_uri: bad }));
    assert.deepEqual([a.status, a.json.redirectTo], [400, undefined], bad);
  }
  const missing = await summary(b, authorizeParams(b, { redirect_uri: undefined }));
  assert.deepEqual([missing.json.kind, missing.json.redirectTo], ["error", null]);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, before, "no code was issued");

  // A code is bound to the redirect URI it was issued for.
  const code = await codeFor(b);
  assert.equal((await exchange(b, code, { redirect_uri: `${b.site.origin("other.example")}${HOSTED_CALLBACK}` })).json.error, "invalid_grant");

  // Rules on their own.
  assert.ok(matchRedirect(["http://localhost/callback"], "http://localhost:43123/callback"), "any port on loopback (RFC 8252)");
  assert.ok(matchRedirect(["http://127.0.0.1:9/cb"], "http://127.0.0.1:5555/cb"));
  assert.ok(!matchRedirect(["http://localhost/callback"], "http://localhost:43123/other"));
  assert.ok(!matchRedirect(["http://localhost/callback"], "http://127.0.0.1:43123/callback"), "the loopback host itself must match");
  assert.ok(!matchRedirect(["https://app.example/cb"], "https://app.example:8443/cb"), "only loopback gets any port");
  for (const r of ["cursor://callback", "http://lan.example/cb", "https://u:p@app.example/cb", "javascript:alert(1)", "https://app.example/cb#x"]) assert.ok(!isAcceptableRedirect(r), r);
});

test("an authorization request that repeats a protocol parameter is refused on the page; the page approves what the server read", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const raw = (extra: string) => b.api("GET", `/api/assistant/oauth/request?${new URLSearchParams(authorizeParams(b))}&${extra}`);
  for (const extra of [
    `client_id=${encodeURIComponent(`${b.site.origin()}/other.json`)}`,
    `redirect_uri=${encodeURIComponent(`${b.site.origin("other.example")}${HOSTED_CALLBACK}`)}`,
    "state=another", "scope=read", "code_challenge=" + "A".repeat(43), "code_challenge_method=S256", "response_type=code",
    `resource=${encodeURIComponent(`${b.app.config.publicOrigin}/mcp`)}`,
  ]) {
    const s = await raw(extra);
    assert.equal(s.status, 200, s.text);
    assert.deepEqual([s.json.kind, s.json.redirectTo], ["error", null], extra);
    assert.match(s.json.message, /more than once/, extra);
  }
  assert.equal(b.site.hits("/oauth/client.json"), 0, "nothing was fetched for a repeated request");
  // Parameters this server doesn't use are ignored, repeated or not; the summary carries exactly what was read.
  const s = await raw("prompt=consent&prompt=login");
  assert.equal(s.json.kind, "ask", s.text);
  assert.deepEqual(s.json.request, authorizeParams(b));
  const a = await approve(b, s.json.request);
  assert.equal(a.status, 200, a.text);
});

test("errors after the client and redirect check go back to the client with iss; earlier ones never leave the page", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const cases: [Record<string, string | undefined>, string][] = [
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ resource: "https://elsewhere.example/mcp" }, "invalid_target"],
    [{ resource: `${b.app.config.publicOrigin}/api` }, "invalid_target"],
  ];
  for (const [over, error] of cases) {
    const s = await summary(b, authorizeParams(b, over));
    assert.equal(s.json.kind, "error", JSON.stringify(over));
    const to = new URL(s.json.redirectTo);
    assert.equal(`${to.origin}${to.pathname}`, b.redirect);
    assert.deepEqual([to.searchParams.get("error"), to.searchParams.get("state"), to.searchParams.get("iss")], [error, "state-from-the-assistant", b.app.config.publicOrigin], JSON.stringify(over));
    assert.equal((await approve(b, authorizeParams(b, over))).status, 400);
  }
  // The resource may come in any canonical spelling, or not at all.
  const o = new URL(b.app.config.publicOrigin);
  for (const resource of [`${o.protocol}//${o.host.toUpperCase()}/mcp`, `${b.app.config.publicOrigin}/mcp/`, undefined]) {
    assert.equal((await summary(b, authorizeParams(b, { resource }))).json.kind, "ask", String(resource));
  }
  // A redirect URI with its own query keeps it exactly.
  const withQuery = `${b.redirect}?tenant=a%20b`;
  b.site.document("/q.json", { client_name: "Q", redirect_uris: [withQuery] });
  const q = await approve(b, authorizeParams(b, { client_id: `${b.site.origin()}/q.json`, redirect_uri: withQuery }));
  assert.ok(q.json.redirectTo.startsWith(`${withQuery}&code=`), q.json.redirectTo);
});

test("codes: single use, PKCE-bound, client-bound, short-lived; a replayed code revokes what it made", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);

  // Wrong verifier: refused, and the code is burned for the real client too.
  const c1 = await codeFor(b);
  assert.equal((await exchange(b, c1, { code_verifier: "x".repeat(43) })).json.error, "invalid_grant");
  assert.equal((await exchange(b, c1)).json.error, "invalid_grant");
  assert.equal((await exchange(b, await codeFor(b), { code_verifier: "short" })).json.error, "invalid_grant");
  const missing = await exchange(b, await codeFor(b), { code_verifier: "" });
  assert.equal(missing.json.error, "invalid_request");

  // Another client can't redeem it.
  const otherId = b.site.document("/other.json", { client_name: "Other", redirect_uris: [b.redirect] });
  assert.equal((await exchange(b, await codeFor(b), { client_id: otherId })).json.error, "invalid_grant");

  // Expired.
  const c2 = await codeFor(b);
  b.app.db.run("UPDATE connect_codes SET expires_at = ?", addSeconds(-1));
  assert.equal((await exchange(b, c2)).json.error, "invalid_grant");

  // Wrong resource at the token endpoint: refused before the code is touched.
  const c3 = await codeFor(b);
  assert.equal((await exchange(b, c3, { resource: "https://elsewhere.example/mcp" })).json.error, "invalid_target");
  const ok = await exchange(b, c3);
  assert.equal(ok.status, 200);
  assert.equal((await mcp(b, ok.json.access_token)).status, 200);

  // Replay of a code that was exchanged: refused, and the grant it made is revoked.
  const replay = await exchange(b, c3);
  assert.equal(replay.json.error, "invalid_grant");
  assert.equal((await mcp(b, ok.json.access_token)).status, 401);
  assert.equal((await refresh(b, ok.json.refresh_token)).json.error, "invalid_grant");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked' AND detail = 'authorization code used twice'"));
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_created' AND outcome = 'failure' AND detail = 'verifier'"));
});

test("the token request may leave out redirect_uri (OAuth 2.1); the code stays bound to its client, redirect URI and verifier", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const without = (code: string, over: Record<string, string> = {}) =>
    form(b, "/oauth/token", { grant_type: "authorization_code", code, client_id: b.clientId, code_verifier: VERIFIER, ...over });
  const ok = await without(await codeFor(b));
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await mcp(b, ok.json.access_token)).status, 200);
  assert.equal(b.app.db.get<{ redirect_uri: string }>("SELECT redirect_uri FROM oauth_grants")!.redirect_uri, b.redirect, "the grant records the redirect URI the code was issued for");
  // The other bindings still hold without it.
  assert.equal((await without(await codeFor(b), { code_verifier: "x".repeat(43) })).json.error, "invalid_grant");
  const otherId = b.site.document("/other.json", { client_name: "Other", redirect_uris: [b.redirect] });
  assert.equal((await without(await codeFor(b), { client_id: otherId })).json.error, "invalid_grant");
  // When present it must match exactly, and an empty one is not an omission.
  assert.equal((await exchange(b, await codeFor(b), { redirect_uri: `${b.redirect}/` })).json.error, "invalid_grant");
  assert.equal((await exchange(b, await codeFor(b), { redirect_uri: "" })).json.error, "invalid_grant");
  // Replaying a code that made a grant revokes the grant, with or without redirect_uri.
  const c = await codeFor(b);
  const first = await without(c);
  assert.equal(first.status, 200);
  assert.equal((await exchange(b, c)).json.error, "invalid_grant");
  assert.equal((await mcp(b, first.json.access_token)).status, 401);
});

test("token endpoint input: public clients only, form-encoded, each parameter once", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const code = await codeFor(b);
  const secret = await exchange(b, code, { client_secret: "s" });
  assert.deepEqual([secret.status, secret.json.error], [401, "invalid_client"]);
  const basic = await form(b, "/oauth/token", { grant_type: "authorization_code", code, client_id: b.clientId }, { authorization: "Basic eDp5" });
  assert.deepEqual([basic.status, basic.json.error], [401, "invalid_client"]);
  assert.equal((await exchange(b, code)).status, 200, "a refused client authentication doesn't touch the code");
  const json = await fetch(`${b.server.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code }) });
  assert.equal((await json.json()).error, "invalid_request");
  const dup = await fetch(`${b.server.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=a&refresh_token=b&client_id=x" });
  assert.equal((await dup.json()).error, "invalid_request");
  assert.equal((await form(b, "/oauth/token", { grant_type: "password", client_id: b.clientId })).json.error, "unsupported_grant_type");
  assert.equal((await form(b, "/oauth/token", { grant_type: "refresh_token", refresh_token: "x" })).json.error, "invalid_request", "client_id is required");
  const big = await form(b, "/oauth/token", { grant_type: "refresh_token", refresh_token: "x".repeat(9000), client_id: b.clientId });
  assert.equal(big.status, 400);
  assert.equal((await fetch(`${b.server.base}/oauth/token`)).status, 405);
});

test("refresh tokens rotate; using one twice revokes the grant", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const first = await connect(b);
  const second = await refresh(b, first.refresh_token);
  assert.equal(second.status, 200);
  // Someone presents the first refresh token again: one of the two holders is not the assistant.
  const reuse = await refresh(b, first.refresh_token);
  assert.equal(reuse.json.error, "invalid_grant");
  assert.equal((await mcp(b, second.json.access_token)).status, 401, "the whole grant is gone");
  assert.equal((await refresh(b, second.json.refresh_token)).json.error, "invalid_grant");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked' AND detail = 'refresh token used twice'"));

  // A refresh token is bound to its client, and refused once expired or once the grant is past its end.
  const third = await connect(b);
  const otherId = b.site.document("/other.json", { client_name: "Other", redirect_uris: [b.redirect] });
  assert.equal((await refresh(b, third.refresh_token, { client_id: otherId })).json.error, "invalid_grant");
  assert.equal((await refresh(b, third.refresh_token, { resource: "https://elsewhere.example/mcp" })).json.error, "invalid_target");
  // Expired access tokens get 401 so the assistant refreshes.
  b.app.db.run("UPDATE oauth_access_tokens SET expires_at = ?", addSeconds(-1));
  const expired = await mcp(b, third.access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("www-authenticate")!, /error="invalid_token", resource_metadata=/);
  purgeOAuth(b.app);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_access_tokens")!.n, 0, "expired access tokens are purged");
  b.app.db.run("UPDATE oauth_grants SET expires_at = ?", addSeconds(-1));
  assert.equal((await refresh(b, third.refresh_token)).json.error, "invalid_grant");
  purgeOAuth(b.app);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 0, "and so are grants past their end");
});

/** Rows in every OAuth table: what the server keeps about its grants and tokens. */
function oauthRows(b: Boot): number {
  const tables = b.app.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth\\_%' ESCAPE '\\'");
  return tables.reduce((n, t) => n + b.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name}`)!.n, 0);
}

test("any earlier refresh token of a live grant revokes it, however many renewals ago, while the grant's storage stays the same", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const first = await connect(b);
  const start = Date.now();
  // 200 days of an assistant renewing once a day, with the maintenance tick running in between.
  let current = first.refresh_token;
  const rows: number[] = [];
  for (let day = 1; day <= 200; day++) {
    t.mock.timers.enable({ apis: ["Date"], now: start + day * 86_400_000 });
    const r = await refresh(b, current);
    assert.equal(r.status, 200, `day ${day}: ${r.text}`);
    current = r.json.refresh_token;
    purgeOAuth(b.app);
    rows.push(oauthRows(b));
    t.mock.timers.reset();
  }
  assert.deepEqual(new Set(rows), new Set([3]), "the grant, its live access token and the last hour's refresh, every day");
  const grant = b.app.db.get<{ id: string; refresh_generation: number; refresh_hash: string }>("SELECT id, refresh_generation, refresh_hash FROM oauth_grants")!;
  assert.deepEqual([grant.refresh_generation, grant.refresh_hash], [200, sha256(current)], "only the current refresh token, by hash");
  assert.ok(current.startsWith(`purss_ort_${grant.id}.200.`));

  // The token from the code, 200 renewals ago, presented again: someone else holds a copy.
  t.mock.timers.enable({ apis: ["Date"], now: start + 201 * 86_400_000 });
  assert.equal((await refresh(b, first.refresh_token)).json.error, "invalid_grant");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 0, "the replay revoked the grant");
  assert.equal((await refresh(b, current)).json.error, "invalid_grant", "and with it the current token");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked' AND detail = 'refresh token used twice'"));
});

test("a refresh token this server didn't issue can't end a grant: forged generations, borrowed grant ids and garbage are only refused", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const r0 = await connect(b);
  const r1 = (await refresh(b, r0.refresh_token)).json;
  const r2 = (await refresh(b, r1.refresh_token)).json;
  const [grantId, , nonce, mac] = r2.refresh_token.slice("purss_ort_".length).split(".");
  const random = () => randomBytes(32).toString("base64url");
  const forged = [
    `purss_ort_${grantId}.0.${nonce}.${mac}`, // the current token's nonce and mac with an earlier generation
    `purss_ort_${grantId}.1.${random()}.${random()}`, // a known grant id with a made-up signature
    `purss_ort_${grantId}.1.${r1.refresh_token.split(".")[2]}.${random()}`, // a real earlier nonce, wrong signature
    `purss_ort_${grantId}.3.${nonce}.${mac}`, // a generation the grant hasn't reached
    `purss_ort_${grantId}.01.${nonce}.${mac}`,
    `purss_ort_${grantId}.1.${nonce}`,
    "purss_ort_garbage",
    r2.refresh_token.slice(0, -1) + (r2.refresh_token.endsWith("A") ? "B" : "A"),
  ];
  for (const token of forged) {
    assert.equal((await refresh(b, token)).json.error, "invalid_grant", token);
    assert.equal((await form(b, "/oauth/revoke", { token, client_id: b.clientId })).status, 200);
  }
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 1, "nothing forged ended the grant");
  assert.ok(!b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked'"));
  const r3 = await refresh(b, r2.refresh_token);
  assert.equal(r3.status, 200, "the current token still works");

  // A real earlier token ends it, at the token endpoint or the revocation endpoint (RFC 7009).
  assert.equal((await form(b, "/oauth/revoke", { token: r1.refresh_token, client_id: b.clientId })).status, 200);
  assert.equal((await refresh(b, r3.json.refresh_token)).json.error, "invalid_grant");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked' AND detail = 'revoked by the assistant'"));
});

test("when the refresh key is lost or replaced, the grant ends at the next token presented: a thief who refreshes first can't keep it", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const r0 = await connect(b);
  const stolen = (await refresh(b, r0.refresh_token)).json;
  const key = path.join(b.app.config.secretsDir, "oauth-refresh-key");
  const before = readFileSync(key, "utf8");
  rmSync(key); // e.g. a restore without the secrets folder makes a new key
  // The thief refreshes the current token first: refused, and the grant ends.
  assert.equal((await refresh(b, stolen.refresh_token)).json.error, "invalid_grant");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 0, "a grant made under another key ends");
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked' AND detail LIKE '%refresh key changed%'"));
  assert.notEqual(readFileSync(key, "utf8"), before, "a new key was made");
  // Connecting again works under the new key, with replay detection back.
  const n0 = await connect(b);
  const n1 = (await refresh(b, n0.refresh_token)).json;
  assert.equal((await refresh(b, n0.refresh_token)).json.error, "invalid_grant");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 0, "the spent token ended the new grant too");
  assert.equal((await refresh(b, n1.refresh_token)).json.error, "invalid_grant");
});

test("refreshes are limited per grant and per account, a refused refresh doesn't spend the token, and rows stay bounded", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const start = Date.now();
  let current = (await connect(b)).refresh_token;
  for (let i = 0; i < REFRESHES_PER_GRANT_PER_HOUR; i++) {
    const r = await refresh(b, current);
    assert.equal(r.status, 200, `refresh ${i + 1}: ${r.text}`);
    current = r.json.refresh_token;
  }
  const over = await refresh(b, current);
  assert.deepEqual([over.status, over.json.error], [429, "temporarily_unavailable"]);
  assert.ok(Number(over.headers.get("retry-after")) > 0 && Number(over.headers.get("retry-after")) <= 3600);
  assert.equal(b.app.db.get<{ refresh_hash: string }>("SELECT refresh_hash FROM oauth_grants")!.refresh_hash, sha256(current), "the refused refresh token isn't spent");
  assert.ok(!b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked'"), "refusing is not a replay");

  // Later the same token works; meanwhile the expired access tokens and counted refreshes are purged.
  t.mock.timers.enable({ apis: ["Date"], now: start + 2 * 3600_000 });
  purgeOAuth(b.app);
  assert.equal(oauthRows(b), 1, "only the grant is left");
  assert.equal((await refresh(b, current)).status, 200);
  t.mock.timers.reset();

  // The account's limit covers all its assistants together: hosted traffic comes from a few shared addresses, so the limit can't be per address.
  const member = signIn(b.app, makeOwner(b.app, { admin: false }).accountId);
  await b.api("PUT", "/api/assistant", { enabled: true }, member);
  const tokens: string[] = [];
  const grants = Math.ceil(REFRESHES_PER_ACCOUNT_PER_HOUR / REFRESHES_PER_GRANT_PER_HOUR) + 1;
  for (let g = 0; g < grants; g++) tokens.push((await connect(b, "write", member)).refresh_token);
  let refused = 0;
  for (let i = 0; i < REFRESHES_PER_ACCOUNT_PER_HOUR + 1; i++) {
    const g = i % grants;
    const r = await refresh(b, tokens[g]!);
    if (r.status === 200) tokens[g] = r.json.refresh_token;
    else { assert.deepEqual([r.status, r.json.error], [429, "temporarily_unavailable"]); refused++; }
  }
  assert.equal(refused, 1, "the account's limit is reached before any one grant's");
});

/** refreshTokens in a separate Node process on the same database: another server process, or this one after a restart. */
function refreshInAnotherProcess(b: Boot, refreshToken: string): { error?: string; refresh_token?: string } {
  const url = (f: string) => pathToFileURL(path.join(import.meta.dirname, f)).href;
  const code = `
    import { EventEmitter } from "node:events";
    const { openDatabase } = await import(${JSON.stringify(url("../db/database.ts"))});
    const { refreshTokens } = await import(${JSON.stringify(url("./grants.ts"))});
    const [config, refreshToken, clientId] = JSON.parse(process.argv[1]);
    const db = openDatabase(config.dbFile);
    console.log(JSON.stringify(refreshTokens({ db, config, events: new EventEmitter(), serviceToken: "" }, { refreshToken, clientId })));
    db.close();`;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code, JSON.stringify([b.app.config, refreshToken, b.clientId])], { encoding: "utf8" });
  return JSON.parse(out);
}

test("the refresh limits hold across processes and restarts: they are counted in the database", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  let current = (await connect(b)).refresh_token;
  for (let i = 0; i < REFRESHES_PER_GRANT_PER_HOUR; i++) {
    const r = await refresh(b, current);
    assert.equal(r.status, 200, `refresh ${i + 1}: ${r.text}`);
    current = r.json.refresh_token;
  }
  assert.equal((await refresh(b, current)).status, 429, "this process has used up the grant's hour");
  // A second process on the same database (or this one restarted) has counted nothing in memory.
  assert.equal(refreshInAnotherProcess(b, current).error, "temporarily_unavailable", "the other process refuses too");
  assert.equal((await refresh(b, current)).status, 429, "and the refused attempt didn't spend the token");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3600_000 + 1000 });
  purgeOAuth(b.app);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_refreshes")!.n, 0, "an hour on, the counted refreshes are purged");
  assert.equal((await refresh(b, current)).status, 200, "and the same token works");
  t.mock.timers.reset();
});

test("the plan/23 switches gate OAuth exactly like tokens; revoking in Settings and account events end grants", async (t) => {
  const b = await boot();
  t.after(b.close);
  // Neither switch on: the page shows it, and nothing can be approved.
  const s = await summary(b, authorizeParams(b));
  assert.deepEqual([s.json.kind, s.json.available, s.json.enabled], ["ask", false, false]);
  assert.equal((await approve(b, authorizeParams(b))).json.error.code, "assistant_unavailable");
  await b.api("PUT", "/api/admin/assistant", { enabled: true });
  assert.equal((await approve(b, authorizeParams(b))).json.error.code, "assistant_off");
  await b.api("PUT", "/api/assistant", { enabled: true });
  const tokens = await connect(b);

  // Installation off: 403 at /mcp, refresh refused but kept; back on, both work again.
  await b.api("PUT", "/api/admin/assistant", { enabled: false });
  assert.equal((await mcp(b, tokens.access_token)).status, 403);
  assert.equal((await refresh(b, tokens.refresh_token)).json.error, "invalid_grant");
  await b.api("PUT", "/api/admin/assistant", { enabled: true });
  assert.equal((await mcp(b, tokens.access_token)).status, 200);
  const rotated = await refresh(b, tokens.refresh_token);
  assert.equal(rotated.status, 200, "the refresh token was kept while the switch was off");
  assert.equal((await b.api("GET", "/api/admin/assistant")).json.grants, 1);

  // A code approved just before the account switch went off can't be exchanged, even once the switch
  // is back on within the code's five minutes: turning it off dropped the code with the grants.
  const pending = await codeFor(b);
  // Account off: revokes its grants with its tokens.
  await b.api("PUT", "/api/assistant", { enabled: false });
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 0);
  assert.equal((await mcp(b, rotated.json.access_token)).status, 401);
  await b.api("PUT", "/api/assistant", { enabled: true });
  assert.equal((await exchange(b, pending)).json.error, "invalid_grant");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_grants")!.n, 0);

  // Suspension stops tokens at once.
  const again = await connect(b);
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", b.owner.accountId);
  assert.equal((await mcp(b, again.access_token)).status, 401);
  b.app.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", b.owner.accountId);

  // Settings → Assistants → Disconnect.
  const id = (await b.api("GET", "/api/assistant")).json.grants[0].id;
  assert.equal((await b.api("DELETE", `/api/assistant/grants/${id}`)).status, 200);
  assert.equal((await mcp(b, again.access_token)).status, 401);
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_grant_revoked' AND target = ? AND detail = 'revoked in Settings'", id));
});

test("grants belong to one account: tools, listing and revoking never cross tenants", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  await switchesOn(b);
  const ownerTokens = await connect(b);
  const member = makeOwner(b.app, { admin: false });
  const memberSession = signIn(b.app, member.accountId);
  await b.api("PUT", "/api/assistant", { enabled: true }, memberSession);
  const memberTokens = await connect(b, "write", memberSession);

  const look = await mcp(b, memberTokens.access_token, "tools/call", { name: "get_item", arguments: { itemId: lib.pinnedOld.itemId } });
  assert.equal(look.json.result.isError, true);
  assert.equal((await mcp(b, memberTokens.access_token, "tools/call", { name: "list_sources", arguments: {} })).json.result.structuredContent.sources.length, 0);
  assert.ok((await mcp(b, ownerTokens.access_token, "tools/call", { name: "list_sources", arguments: {} })).json.result.structuredContent.sources.length > 0);

  const ownerGrant = (await b.api("GET", "/api/assistant")).json.grants[0].id;
  assert.equal((await b.api("GET", "/api/assistant", undefined, memberSession)).json.grants.length, 1);
  assert.equal((await b.api("DELETE", `/api/assistant/grants/${ownerGrant}`, undefined, memberSession)).status, 404);
  assert.equal((await mcp(b, ownerTokens.access_token)).status, 200);
  // The member's refresh token can't be used to reach the owner's grant either way.
  const r = await refresh(b, memberTokens.refresh_token);
  assert.equal((await mcp(b, r.json.access_token, "tools/call", { name: "list_sources", arguments: {} })).json.result.structuredContent.sources.length, 0);
});

test("a token is only good for this server's /mcp address (audience)", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const tokens = await connect(b);
  assert.equal((await mcp(b, tokens.access_token)).status, 200);
  // The PURSS moves to another public address: tokens issued for the old /mcp stop.
  b.app.config.publicOrigin = "https://moved.example";
  assert.equal((await mcp(b, tokens.access_token)).status, 401);
  assert.equal((await refresh(b, tokens.refresh_token)).json.error, "invalid_grant");
  // OAuth tokens are not device tokens: /api never accepts them.
  const r = await fetch(`${b.server.base}/api/assistant`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(r.status, 401);
});

test("client metadata documents: fetched safely, validated, cached; private addresses, oversized, slow and redirected documents are refused", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const ask = async (clientId: string) => (await summary(b, authorizeParams(b, { client_id: clientId }))).json;

  // Cached: the second look doesn't fetch again; no-store documents are fetched every time.
  await ask(b.clientId);
  await ask(b.clientId);
  assert.equal(b.site.hits("/oauth/client.json"), 1);
  const fresh = b.site.document("/fresh.json", { client_name: "Fresh", redirect_uris: [b.redirect] }, { "cache-control": "no-store" });
  await ask(fresh);
  await ask(fresh);
  assert.equal(b.site.hits("/fresh.json"), 2);

  const refused = async (clientId: string, pattern: RegExp) => {
    const s = await ask(clientId);
    assert.deepEqual([s.kind, s.redirectTo], ["error", null], clientId);
    assert.match(s.message, pattern, clientId);
  };
  // Private and special-use addresses are never fetched (safeFetch's rules).
  await refused("https://internal.example/client.json", /isn't on the public internet/);
  await refused("https://169.254.169.254/latest/meta-data", /isn't on the public internet/);
  await refused("https://[::1]/client.json", /isn't on the public internet/);
  // Not an https URL with a path, or not in normal form.
  for (const id of ["http://assistant.example/client.json", `${b.site.origin()}/`, `${b.site.origin()}`, `${b.site.origin()}/a/../client.json`, `${b.site.origin()}/client.json#x`, `${b.site.origin().toUpperCase()}/client.json`]) {
    await refused(id, /client_id/);
  }
  // Oversized (5 kB), redirected, non-200, invalid JSON, wrong client_id inside, secrets: refused, and failures aren't cached.
  b.site.route("/big.json", (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ client_id: `${b.site.origin()}/big.json`, redirect_uris: [b.redirect], pad: "x".repeat(6000) })));
  await refused(`${b.site.origin()}/big.json`, /larger than 5 kB/);
  b.site.route("/moved.json", (_req, res) => res.writeHead(302, { location: `${b.site.origin()}/oauth/client.json` }).end());
  await refused(`${b.site.origin()}/moved.json`, /redirect/i);
  b.site.route("/gone.json", (_req, res) => res.writeHead(404).end());
  await refused(`${b.site.origin()}/gone.json`, /status 404/);
  await refused(`${b.site.origin()}/gone.json`, /status 404/);
  assert.equal(b.site.hits("/gone.json"), 2, "failures are not cached");
  b.site.route("/html.json", (_req, res) => res.writeHead(200).end("<html>"));
  await refused(`${b.site.origin()}/html.json`, /valid JSON/);
  b.site.route("/liar.json", (_req, res) => res.writeHead(200).end(JSON.stringify({ client_id: b.clientId, redirect_uris: [b.redirect] })));
  await refused(`${b.site.origin()}/liar.json`, /doesn't match/);
  await refused(b.site.document("/secret.json", { redirect_uris: [b.redirect], client_secret: "s" }), /secret/);
  await refused(b.site.document("/jwt.json", { redirect_uris: [b.redirect], token_endpoint_auth_method: "private_key_jwt" }), /without a secret/);
  await refused(b.site.document("/noredirect.json", { redirect_uris: ["cursor://cb", "http://lan.example/cb"] }), /no usable return addresses/);

  // Slow: the site accepts the connection and never answers.
  const started = Date.now();
  b.site.route("/slow.json", () => { /* never answers */ });
  await refused(`${b.site.origin()}/slow.json`, /too long/);
  assert.ok(Date.now() - started < 9000, "bounded by the fetch's time limits");

  // Names are cleaned, and the host is what the page shows next to them.
  const named = await ask(b.site.document("/named.json", { client_name: "Claude\u202e\u0007 official   assistant", redirect_uris: [b.redirect] }));
  assert.deepEqual([named.clientName, named.clientHost], ["Claude official assistant", new URL(b.clientId).host]);
  // A document must name the client (the MCP profile requires client_name); the host is still shown beside it.
  await refused(b.site.document("/unnamed.json", { redirect_uris: [b.redirect] }), /don't name the assistant/);
  // A loopback-only client (a program on this computer) is flagged for a warning.
  const local = b.site.document("/local.json", { client_name: "Local", redirect_uris: ["http://localhost/callback"] });
  const localAsk = (await summary(b, authorizeParams(b, { client_id: local, redirect_uri: "http://localhost:51234/callback" }))).json;
  assert.deepEqual([localAsk.kind, localAsk.loopbackRedirect, localAsk.redirectHost], ["ask", true, "localhost:51234"]);
});

test("without the test hooks, loopback and private addresses are refused before any connection", async () => {
  const { app, cleanup } = makeTestApp({ PURSS_ASSISTANT_OAUTH: "on" });
  try {
    const owner = makeOwner(app);
    for (const id of ["https://127.0.0.1/client.json", "https://localhost/client.json", "https://10.1.2.3/client.json", "https://[fd00::1]/client.json"]) {
      const r = await resolveClient(id, owner.accountId);
      assert.equal(r.ok, false, id);
      assert.match((r as { message: string }).message, /public internet|couldn't read/, id);
    }
  } finally {
    cleanup();
  }
});

test("client metadata rules on their own", () => {
  assert.ok(isClientIdUrl("https://claude.ai/oauth/mcp-oauth-client-metadata"));
  assert.ok(isClientIdUrl("https://chatgpt.com/oauth/client.json"));
  for (const bad of ["https://claude.ai", "https://claude.ai/", "http://claude.ai/x", "https://u:p@claude.ai/x", "https://claude.ai/x#y", "https://Claude.ai/x", "https://claude.ai:443/x", "https://claude.ai/a/./x", "not a url"]) {
    assert.ok(!isClientIdUrl(bad), bad);
  }
  const id = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const doc = (d: Record<string, unknown>) => parseDocument(id, JSON.stringify({ client_id: id, ...d }));
  assert.deepEqual(doc({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"] }),
    { ok: true, client: { id, name: "Claude", host: "claude.ai", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] } });
  assert.equal(doc({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }).ok, false);
  assert.equal(doc({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] }).ok, false);
  assert.equal(doc({ redirect_uris: [] }).ok, false);
  assert.equal(doc({ redirect_uris: Array.from({ length: 21 }, (_, i) => `https://a.example/${i}`) }).ok, false);
  assert.deepEqual((doc({ client_name: "A", redirect_uris: ["cursor://x", "https://a.example/cb"] }) as { client: { redirectUris: string[] } }).client.redirectUris, ["https://a.example/cb"]);
  for (const client_name of [undefined, "", "   ", "\u202e\u0007", 7, ["Claude"], null]) {
    const r = doc({ client_name, redirect_uris: ["https://a.example/cb"] });
    assert.equal(r.ok, false, JSON.stringify(client_name));
    assert.match((r as { message: string }).message, /don't name the assistant/);
  }
});

test("client authentication in the metadata document: the methods it declares must include none, and the singular must agree with the plural (CIMD §5)", () => {
  const id = "https://assistant.example/client.json";
  const doc = (d: Record<string, unknown>) => parseDocument(id, JSON.stringify({ client_id: id, client_name: "A", redirect_uris: ["https://assistant.example/cb"], ...d }));
  const ok = (d: Record<string, unknown>) => assert.equal(doc(d).ok, true, JSON.stringify(d));
  const refused = (d: Record<string, unknown>, pattern: RegExp) => {
    const r = doc(d);
    assert.equal(r.ok, false, JSON.stringify(d));
    assert.match((r as { message: string }).message, pattern, JSON.stringify(d));
  };
  ok({});
  ok({ token_endpoint_auth_method: "none" });
  ok({ token_endpoint_auth_methods_supported: ["none"] });
  ok({ token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] });
  ok({ token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] });
  ok({ token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] });
  for (const d of [
    { token_endpoint_auth_method: "private_key_jwt" },
    { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
    { token_endpoint_auth_methods_supported: [] },
  ]) refused(d, /without a secret/);
  for (const d of [
    { token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["private_key_jwt"] },
    { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none"] },
    { token_endpoint_auth_methods_supported: "none" },
    { token_endpoint_auth_methods_supported: ["none", 7] },
    { token_endpoint_auth_method: ["none"] },
  ]) refused(d, /authentication methods don't agree|aren't a list/);
  // CIMD §4.1: a shared-secret method is not allowed in either property, even next to "none".
  for (const method of ["client_secret_basic", "client_secret_post", "client_secret_jwt"]) {
    for (const d of [
      { token_endpoint_auth_method: method },
      { token_endpoint_auth_methods_supported: [method] },
      { token_endpoint_auth_methods_supported: [method, "none"] },
      { token_endpoint_auth_methods_supported: ["none", method] },
      { token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["none", method] },
      { token_endpoint_auth_method: method, token_endpoint_auth_methods_supported: [method, "none"] },
    ]) refused(d, /client secret/);
  }
});

test("the consent page can't be framed, and approving needs the same origin, the CSRF header and a recent sign-in", async (t) => {
  const b = await boot();
  t.after(b.close);
  await switchesOn(b);
  const page = await fetch(`${b.server.base}/app/oauth/authorize?${new URLSearchParams(authorizeParams(b))}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const body = JSON.stringify({ request: authorizeParams(b), access: "write" });
  const post = (headers: Record<string, string>) => fetch(`${b.server.base}/api/assistant/oauth/approve`, { method: "POST", headers: { "content-type": "application/json", cookie: b.session.cookie, ...headers }, body });
  assert.equal((await post({ origin: b.app.config.publicOrigin })).status, 403, "no CSRF header");
  assert.equal((await post({ origin: b.app.config.publicOrigin, "x-purss-csrf": "wrong" })).status, 403);
  assert.equal((await post({ origin: "https://evil.example", "x-purss-csrf": b.session.csrf })).status, 403, "another site");
  assert.equal((await post({ "x-purss-csrf": b.session.csrf })).status, 403, "no origin");
  assert.equal((await approve(b, authorizeParams(b), "write", signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 }))).json.error.code, "step_up");
  assert.equal((await approve(b, authorizeParams(b), "write", null as unknown as TestSession)).status, 401, "signed out");
  // An assistant's sign-in is approved on the page the assistant opened, not from the phone app.
  const phone = createDeviceToken(b.app, b.owner.accountId, "mobile", "Phone").secret;
  const viaApp = await fetch(`${b.server.base}/api/assistant/oauth/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${phone}`, origin: "capacitor://localhost" }, body });
  assert.equal(viaApp.status, 403);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 0, "nothing was issued");
});

test("PURSS_ASSISTANT_OAUTH: on in hosted mode, opt-in when self-hosted, and only over https or localhost", () => {
  const base = { PURSS_DATA_DIR: "/tmp/x" };
  assert.equal(loadConfig(base).assistantOAuth, false);
  assert.equal(loadConfig({ ...base, PURSS_ASSISTANT_OAUTH: "" }).assistantOAuth, false);
  assert.equal(loadConfig({ ...base, PURSS_ASSISTANT_OAUTH: "on" }).assistantOAuth, true, "localhost is fine for trying it");
  assert.equal(loadConfig({ ...base, PURSS_ASSISTANT_OAUTH: "on", PURSS_PUBLIC_ORIGIN: "https://ws.example" }).assistantOAuth, true);
  assert.throws(() => loadConfig({ ...base, PURSS_ASSISTANT_OAUTH: "on", PURSS_PUBLIC_ORIGIN: "http://192.168.1.5:8940" }), /https/);
  assert.throws(() => loadConfig({ ...base, PURSS_ASSISTANT_OAUTH: "yes" }), /on or off/);
  assert.equal(loadConfig({ ...base, PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://ws.example" }).assistantOAuth, true);
  assert.equal(loadConfig({ ...base, PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://ws.example", PURSS_ASSISTANT_OAUTH: "off" }).assistantOAuth, false);
  assert.equal(loadConfig({ ...base, PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "http://lan.example" }).assistantOAuth, false, "never over plain http");
});
