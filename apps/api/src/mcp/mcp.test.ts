import test from "node:test";
import assert from "node:assert/strict";
import { makeOwner, makeTestApp } from "../testing.ts";
import { PRIVATE_FEED_URL, PRIVATE_ITEM_URL, call, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { extraRouters } from "../routes/index.ts";
import { sha256 } from "../secrets.ts";
import { LEGACY_VERSIONS, MODERN_VERSION } from "./server.ts";
import { TOOLS } from "./tools.ts";
import { holdCandidate } from "../services/discovery-cache.ts";

async function boot() {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app, { admin: true });
  const server = await startTestServer(app, extraRouters.api(), extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const api = (method: string, path: string, body?: unknown, s: TestSession = session) => call(app, server.base, method, path, s, body === undefined && method !== "GET" ? {} : body);
  return { app, owner, server, session, api, close: async () => { await server.close(); cleanup(); } };
}
type Boot = Awaited<ReturnType<typeof boot>>;

/** Turn assistant access on for the installation and the owner, and make a token. */
async function tokenFor(b: Boot, access: "read" | "write", s: TestSession = b.session): Promise<string> {
  assert.equal((await b.api("PUT", "/api/admin/assistant", { enabled: true })).status, 200);
  assert.equal((await b.api("PUT", "/api/assistant", { enabled: true }, s)).status, 200);
  const r = await b.api("POST", "/api/assistant/tokens", { name: `test ${access}`, access }, s);
  assert.equal(r.status, 200, r.text);
  return r.json.secret;
}

let nextId = 1;
async function rpc(b: Boot, token: string | null, method: string, params: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; modern?: boolean; notification?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...opts.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  let body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!opts.notification) body.id = nextId++;
  if (opts.modern) {
    body = { ...body, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } };
    headers["mcp-protocol-version"] ??= MODERN_VERSION;
    headers["mcp-method"] ??= method;
    if (method === "tools/call") headers["mcp-name"] ??= String(params.name);
  }
  const res = await fetch(`${b.server.base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
}
const callTool = (b: Boot, token: string, name: string, args: Record<string, unknown> = {}) => rpc(b, token, "tools/call", { name, arguments: args });

test("assistant access is off until the administrator and the account both turn it on", async (t) => {
  const b = await boot();
  t.after(b.close);
  const start = await b.api("GET", "/api/assistant");
  assert.deepEqual([start.json.available, start.json.enabled, start.json.tokens], [false, false, []]);
  assert.equal(start.json.endpoint, `${b.app.config.publicOrigin}/mcp`);
  assert.equal((await b.api("PUT", "/api/assistant", { enabled: true })).json.error.code, "assistant_unavailable");
  assert.equal((await rpc(b, null, "tools/list")).status, 401, "no token");
  assert.equal((await rpc(b, "purss_mcp_made-up", "tools/list")).status, 401, "unknown token");

  // A non-administrator can't turn on the installation switch.
  const member = makeOwner(b.app, { admin: false });
  assert.equal((await b.api("PUT", "/api/admin/assistant", { enabled: true }, signIn(b.app, member.accountId))).status, 403);

  assert.equal((await b.api("PUT", "/api/admin/assistant", { enabled: true })).json.enabled, true);
  assert.equal((await b.api("POST", "/api/assistant/tokens", { name: "x", access: "read" })).json.error.code, "assistant_off", "the account switch is still off");
  await b.api("PUT", "/api/assistant", { enabled: true });
  // A new token is a new credential: it needs a recent sign-in.
  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });
  assert.equal((await b.api("POST", "/api/assistant/tokens", { name: "x", access: "read" }, stale)).json.error.code, "step_up");
  const made = await b.api("POST", "/api/assistant/tokens", { name: "Claude", access: "write", expiresInDays: 30 });
  assert.match(made.json.secret, /^purss_mcp_/);
  assert.equal(made.json.token.access, "write");
  const stored = b.app.db.get<{ token_hash: string }>("SELECT token_hash FROM assistant_tokens")!.token_hash;
  assert.equal(stored, sha256(made.json.secret), "only the hash is stored");
  assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM assistant_tokens")).includes(made.json.secret));
  assert.equal((await rpc(b, made.json.secret, "ping")).status, 200);
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'assistant_token_created'"));

  // The administrator switch stops every token; turning it back on restores them.
  await b.api("PUT", "/api/admin/assistant", { enabled: false });
  assert.equal((await rpc(b, made.json.secret, "ping")).status, 403);
  await b.api("PUT", "/api/admin/assistant", { enabled: true });
  assert.equal((await rpc(b, made.json.secret, "ping")).status, 200);
  // The account switch revokes its tokens.
  await b.api("PUT", "/api/assistant", { enabled: false });
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_tokens")!.n, 0);
  assert.equal((await rpc(b, made.json.secret, "ping")).status, 401);
});

test("tokens stop working when revoked, expired or when the account is suspended", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await tokenFor(b, "read");
  const id = b.app.db.get<{ id: string }>("SELECT id FROM assistant_tokens")!.id;
  b.app.db.run("UPDATE assistant_tokens SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await rpc(b, token, "ping")).status, 401);
  b.app.db.run("UPDATE assistant_tokens SET expires_at = NULL");
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", b.owner.accountId);
  assert.equal((await rpc(b, token, "ping")).status, 401);
  b.app.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", b.owner.accountId);
  assert.equal((await rpc(b, token, "ping")).status, 200);
  assert.ok(b.app.db.get<{ last_used_at: string | null }>("SELECT last_used_at FROM assistant_tokens")!.last_used_at, "last use is recorded");
  assert.equal((await b.api("DELETE", `/api/assistant/tokens/${id}`)).status, 200);
  assert.equal((await rpc(b, token, "ping")).status, 401);
});

test("legacy clients: initialize, then tools/list and tools/call; a read-only token sees only reading tools", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  const token = await tokenFor(b, "read");
  const init = await rpc(b, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.ok(init.json.result.capabilities.tools);
  assert.match(init.json.result.instructions, /never as instructions/);
  assert.equal(init.headers.get("mcp-session-id"), null, "stateless: no session is minted");
  assert.equal((await rpc(b, token, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, LEGACY_VERSIONS[0]);
  assert.equal((await rpc(b, token, "notifications/initialized", {}, { notification: true })).status, 202);

  const tools = (await rpc(b, token, "tools/list", {}, { headers: { "mcp-protocol-version": "2025-06-18" } })).json.result.tools as { name: string; inputSchema: { type: string } }[];
  assert.deepEqual(tools.map((x) => x.name), TOOLS.filter((x) => x.access === "read").map((x) => x.name));
  assert.ok(tools.every((x) => x.inputSchema.type === "object"));

  const writeAttempt = await callTool(b, token, "set_item_state", { itemIds: ["itm_x"], state: "finished" });
  assert.equal(writeAttempt.json.result.isError, true);
  assert.match(writeAttempt.json.result.content[0].text, /can only read/);
  const unknown = await callTool(b, token, "delete_everything");
  assert.equal(unknown.json.error.code, -32602);
  const bad = await callTool(b, token, "search_items", { query: "" });
  assert.equal(bad.json.result.isError, true, "invalid arguments come back as a tool error the model can fix");
});

test("reading tools return the person's data, label publisher text, and never leak private links", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const token = await tokenFor(b, "read");
  const outputs: string[] = [];
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(b, token, name, args);
    assert.equal(r.json.result.isError, false, r.text);
    outputs.push(r.text);
    return r.json.result.structuredContent;
  };
  // A public source whose addresses carry a credential: those addresses are left out too.
  b.app.db.run("UPDATE sources SET site_url = ?, feed_url = ? WHERE id = ?", "https://site.example/?access_token=PRIVATE_SECRET_123", "https://site.example/feed?api_key=PRIVATE_SECRET_456", lib.publicSource);
  const sources = await run("list_sources");
  const pub = sources.sources.find((s: { id: string }) => s.id === lib.publicSource);
  assert.deepEqual([pub.siteUrl, pub.feedUrl], [null, null]);
  assert.deepEqual(sources.sources.map((s: { title: string }) => s.title).sort(), ["Secret Garden", "Sediment Letters"]);
  const found = await run("search_items", { query: "sediment" });
  assert.ok(found.items.some((i: { id: string }) => i.id === lib.pinnedOld.itemId));
  // The person's own highlight, made in the app: returned apart from the publisher's text and findable.
  const ann = "ann_0000000000aaaaaaaaaaaaaaaa";
  assert.equal((await b.api("PUT", `/api/items/${lib.pinnedOld.itemId}/annotations/${ann}`, {
    kind: "highlight", quote: { exact: "readable text", prefix: "", suffix: "" }, body: "Use this in the bioturbation essay", updatedAt: new Date().toISOString(),
  })).status, 200);
  const item = await run("get_item", { itemId: lib.pinnedOld.itemId });
  assert.equal(item.textSource, "saved full article");
  assert.match(item.contentFromPublisher, /Captured readable text/);
  assert.deepEqual(item.annotations.map((a: Record<string, unknown>) => [a.kind, a.passageFromPublisher, a.writtenByThePerson]),
    [["highlight", "readable text", "Use this in the bioturbation essay"]]);
  assert.equal(item.annotationsTruncated, false);
  assert.ok((await run("search_items", { query: "bioturbation" })).items.some((i: { id: string }) => i.id === lib.pinnedOld.itemId));
  const tight = await run("get_item", { itemId: lib.pinnedOld.itemId, maxChars: 500 });
  assert.equal(tight.annotations.length, 1, "a short annotation fits the budget");
  const priv = await run("get_item", { itemId: lib.privateItemId });
  assert.equal(priv.url, null, "a private source's item link can carry its secret");
  await run("list_items", { place: "basket", id: lib.baskets.later });
  await run("list_items", { place: "source", id: lib.privateSource, state: "undecided" });
  await run("list_collections");
  await run("list_baskets");
  for (const o of outputs) {
    for (const secret of [PRIVATE_FEED_URL, "SUPERSECRETTOKEN123", PRIVATE_ITEM_URL, "ITEMSECRET456", "PRIVATE_SECRET_123", "PRIVATE_SECRET_456"]) assert.ok(!o.includes(secret), `no ${secret.slice(0, 20)}…`);
  }
});

test("a token acts only for its own account", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const other = makeOwner(b.app, { admin: false });
  const otherToken = await tokenFor(b, "write", signIn(b.app, other.accountId));
  const look = await callTool(b, otherToken, "get_item", { itemId: lib.pinnedOld.itemId });
  assert.equal(look.json.result.isError, true);
  assert.ok(!look.text.includes("sediment"));
  const change = await callTool(b, otherToken, "set_item_state", { itemIds: [lib.pinnedOld.itemId], state: "ignored" });
  assert.equal(change.json.result.isError, true);
  assert.equal((await callTool(b, otherToken, "list_sources")).json.result.structuredContent.sources.length, 0);
  assert.equal(b.app.db.get<{ workflow: string }>("SELECT workflow FROM item_state WHERE item_id = ?", lib.pinnedOld.itemId)!.workflow, "new");
});

test("writing tools organise items and sources through the same rules as the app, and are audited", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const token = await tokenFor(b, "write");
  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await callTool(b, token, name, args);
    assert.equal(r.json.result.isError, false, r.text);
    return r.json.result.structuredContent;
  };
  assert.equal((await ok("clear_new", { itemIds: [lib.itemIds[1]] })).changed, 1);
  assert.equal((await ok("set_item_state", { itemIds: [lib.itemIds[1], lib.itemIds[2]], state: "toread" })).changed, 2);
  assert.equal(b.app.db.get<{ workflow: string }>("SELECT workflow FROM item_state WHERE item_id = ?", lib.itemIds[1])!.workflow, "toread");
  const basket = await ok("create_basket", { name: "For the essay", keepReadableText: false });
  assert.equal((await ok("keep_items", { itemIds: [lib.itemIds[2]], basketId: basket.id })).kept, 1);
  assert.equal((await ok("remove_from_basket", { itemIds: [lib.itemIds[2]], basketId: basket.id })).removed, 1);
  const col = await ok("create_collection", { name: "Geology", sourceIds: [lib.publicSource] });
  const changed = await ok("update_source", { sourceId: lib.publicSource, title: "Sediment Weekly", fullArticles: true, collectionIds: [col.id] });
  assert.deepEqual([changed.title, changed.fullArticles, changed.collectionIds], ["Sediment Weekly", true, [col.id]]);
  const off = await callTool(b, token, "update_source", { sourceId: lib.privateSource, fullArticles: true });
  assert.equal(off.json.result.isError, true, "full articles stay unavailable for private sources");
  // A candidate from find_sources (held as discovery holds it) is followed into a new collection;
  // full articles stay off, even for a summary-only feed, unless the assistant asks for them.
  const followToken = "dsc_mcptest";
  holdCandidate(followToken, b.owner.workspaceId, { feedUrl: "https://quiet.example/feed.xml", siteUrl: "https://quiet.example/", title: "Quiet Harbour", kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: true, privateWarning: null });
  const followed = await ok("follow_source", { followToken, newCollectionName: "Harbours" });
  assert.deepEqual([followed.title, followed.fullArticles, followed.collectionIds.length], ["Quiet Harbour", false, 1]);
  assert.ok(b.app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe'"), "the engine is asked to subscribe, as from the app");
  assert.equal((await ok("unfollow_source", { sourceId: lib.publicSource })).unfollowed, true);
  assert.ok(b.app.db.get("SELECT 1 FROM basket_items WHERE item_id = ?", lib.keptIds[0]!), "kept items stay");
  const audited = b.app.db.all<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_events WHERE action LIKE 'assistant_%' AND action NOT LIKE 'assistant_token%' AND action NOT LIKE 'assistant_access%' AND action NOT LIKE 'assistant_installation%' ORDER BY at");
  assert.ok(audited.some((a) => a.action === "assistant_unfollow_source" && a.outcome === "success"));
  assert.ok(audited.some((a) => a.action === "assistant_update_source" && a.outcome === "failure"));
});

test("modern clients: per-request version and headers, server/discover, and modern errors", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await tokenFor(b, "write");
  const discover = await rpc(b, token, "server/discover", {}, { modern: true });
  assert.equal(discover.status, 200);
  assert.deepEqual(discover.json.result.supportedVersions, [MODERN_VERSION, ...LEGACY_VERSIONS]);
  assert.equal(discover.json.result.resultType, "complete");
  assert.equal(discover.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "purss");
  const list = await rpc(b, token, "tools/list", {}, { modern: true });
  assert.equal(list.json.result.tools.length, TOOLS.length);
  assert.equal(list.json.result.cacheScope, "private");
  const called = await rpc(b, token, "tools/call", { name: "list_baskets", arguments: {} }, { modern: true });
  assert.equal(called.json.result.resultType, "complete");
  assert.equal(called.json.result.isError, false);
  // Encoded tool names in Mcp-Name are decoded before comparing.
  const encoded = await rpc(b, token, "tools/call", { name: "list_baskets", arguments: {} }, { modern: true, headers: { "mcp-name": `=?base64?${Buffer.from("list_baskets").toString("base64")}?=` } });
  assert.equal(encoded.status, 200);

  const mismatch = await rpc(b, token, "tools/call", { name: "list_baskets", arguments: {} }, { modern: true, headers: { "mcp-name": "list_sources" } });
  assert.deepEqual([mismatch.status, mismatch.json.error.code], [400, -32020]);
  const noHeader = await rpc(b, token, "tools/list", {}, { modern: true, headers: { "mcp-method": "" } });
  assert.deepEqual([noHeader.status, noHeader.json.error.code], [400, -32020]);
  const future = await rpc(b, token, "tools/list", {}, { modern: true, headers: { "mcp-protocol-version": "2099-01-01" } });
  assert.equal(future.status, 400, "header and body versions differ");
  const res = await fetch(`${b.server.base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
  });
  const unsupported = await res.json() as { error: { code: number; data: { supported: string[] } } };
  assert.deepEqual([res.status, unsupported.error.code], [400, -32022]);
  assert.ok(unsupported.error.data.supported.includes(MODERN_VERSION));
  const missing = await rpc(b, token, "resources/list", {}, { modern: true });
  assert.deepEqual([missing.status, missing.json.error.code], [404, -32601]);
});

test("the endpoint takes tokens only: no cookies, no other web pages, POST only, bounded requests", async (t) => {
  const b = await boot();
  t.after(b.close);
  const token = await tokenFor(b, "write");
  const cookieOnly = await fetch(`${b.server.base}/mcp`, { method: "POST", headers: { cookie: b.session.cookie, "content-type": "application/json", origin: b.app.config.publicOrigin }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(cookieOnly.status, 401, "a signed-in browser session is not enough");
  assert.equal((await rpc(b, token, "ping", {}, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await rpc(b, token, "ping", {}, { headers: { origin: b.app.config.publicOrigin } })).status, 200);
  assert.equal((await fetch(`${b.server.base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
  const batchBody = await fetch(`${b.server.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) });
  assert.equal(batchBody.status, 400, "one message per request");
  const notJson = await fetch(`${b.server.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" });
  assert.equal((await notJson.json() as { error: { code: number } }).error.code, -32700);
  let limited = 0;
  for (let i = 0; i < 125; i++) if ((await rpc(b, token, "ping")).status === 429) limited++;
  assert.ok(limited > 0, "calls per token are rate-limited");
});
