import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "htmlparser2";
import { server as copy } from "@purss/translations/server";
import { appUrl } from "@purss/domain";
import { inHtml } from "../translations-testing.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import { basketDeletePreview, createBasket, createCollection, deleteBasket, deleteCollection } from "../services/collections.ts";
import { keepItem } from "../services/state.ts";
import { putAnnotation } from "../services/annotations.ts";
import { keepLink } from "../services/links.ts";
import { newId } from "@purss/domain";
import type { TestSession } from "../features-testing.ts";
import { extraRouters } from "./index.ts";
import { applySyncBatch } from "../services/sync.ts";
import { limitPublicRead, resetPublicReadLimit } from "../services/shares.ts";
import { HttpError } from "../http.ts";

const { shares, sharingRoute, publicPages } = copy.api;

async function boot(env: Record<string, string> = {}) {
  const { app, cleanup } = makeTestApp(env);
  const owner = makeOwner(app, { admin: true });
  const server = await startTestServer(app, extraRouters.api(), extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const api = (method: string, path: string, body?: unknown, s: TestSession | null = session) => call(app, server.base, method, path, s, body === undefined && method !== "GET" ? {} : body);
  const anon = (path: string, headers: Record<string, string> = {}, method = "GET") => call(app, server.base, method, path, null, undefined, { headers });
  return { app, owner, session, server, api, anon, close: async () => { await server.close(); cleanup(); } };
}

/** Find elements by tag name in a parsed XML document. */
function elements(node: any, name: string, out: any[] = []): any[] {
  if (node.type === "tag" && node.name === name) out.push(node);
  for (const c of node.children ?? []) elements(c, name, out);
  return out;
}
const childTags = (node: any, name: string): any[] => (node.children ?? []).filter((c: any) => c.type === "tag" && c.name === name);
const textOf = (node: any): string => (node.children ?? []).map((c: any) => (c.type === "text" ? c.data : textOf(c))).join("");

const ID_SHAPE = /\b(?:itm|shr|wsp|acc|src|bsk|col|ver|cap|obj|ntf|job|usr|ext)_[0-9a-z]{20,}\b/;

type Boot = Awaited<ReturnType<typeof boot>>;

/** Where a hosted installation sends visitors to learn what PURSS is (a self-hosted one has no such place). */
const homeOf = (b: Boot) => b.app.config.mode === "hosted" ? `${b.app.config.publicOrigin}/` : null;

/** What a shared page says around its list of items, as the catalog's template writes it: the markup before the list and after it. */
function around(b: Boot, page: Record<string, any>) {
  const home = homeOf(b);
  const [before, after] = shares.pageBody(inHtml(page.title), inHtml(page.curatorName), page.description ? `<p class="about">${inHtml(page.description)}</p>` : "", inHtml(page.followUrl), inHtml(page.feedUrl), "\u0000",
    home ? shares.madeWith(inHtml(home), "PURSS") : "", inHtml(`${page.publicUrl}/report`)).split("\u0000") as [string, string];
  return { before, after };
}

/** The follow page's body as the catalog writes it for `feed`, called `name`, and credited to `by` when it is a page shared from this installation. */
function followBody(b: Boot, feed: string, name: string, by: string | null) {
  const home = homeOf(b);
  return publicPages.followBody(inHtml(name), by === null ? "" : publicPages.sharedBy(inHtml(by)), "PURSS", inHtml(feed), inHtml(`${appUrl("/")}?dialog=add&url=${encodeURIComponent(feed)}`),
    home ? publicPages.newToProduct("PURSS", inHtml(home)) : "");
}

/** Set up sharing for a basket or collection and share it through the real review and confirmation. */
async function share(b: Boot, kind: "basket" | "collection", id: string, extra: Record<string, unknown> = {}, s: TestSession | null = b.session) {
  const saved = await b.api("PUT", `/api/shares/for/${kind}/${id}`, { curatorName: "Mara", ...extra }, s);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const preview = (await b.api("GET", `/api/shares/${saved.json.id}/preview`, undefined, s)).json;
  assert.ok(preview.confirmation, `shareable: ${preview.blockers?.join(" ")}`);
  const out = await b.api("POST", `/api/shares/${saved.json.id}/publish`, { confirmToken: preview.confirmation.token }, s);
  assert.equal(out.status, 200);
  return { ...out.json, preview } as Record<string, any>;
}

/** Send the public report form the way a browser does. */
async function report(b: Boot, slug: string, fields: Record<string, string>, address = "198.51.100.7", extra: Record<string, string> = {}) {
  const res = await fetch(`${b.server.base}/p/${slug}/report`, {
    method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address, origin: b.app.config.publicOrigin, ...extra },
  });
  return { status: res.status, text: await res.text(), csp: res.headers.get("content-security-policy") ?? "" };
}

const path = (url: string) => new URL(url).pathname + new URL(url).search;

test("sharing a basket: a draft is invisible, the review shows the page and what becomes public, and the page stays live", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  b.app.db.run("UPDATE accounts SET display_name = 'Real Name real@example.com' WHERE id = ?", b.owner.accountId);
  const before = (await b.api("GET", `/api/shares/for/basket/${lib.baskets.later}`)).json;
  assert.deepEqual(before, { share: null, blocked: null }, "self-hosted: anyone can share");
  assert.equal((await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { description: "x" })).status, 400, "the name shown is chosen, never defaulted");

  const draft = (await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { curatorName: "Sam Q.", description: "Things about <sediment> & silt." })).json;
  assert.equal(draft.status, "draft");
  assert.equal(draft.title, "Later", "the page is titled after the basket");
  assert.match(draft.slug, /^later-[a-km-z2-9]{12}$/);
  const drafted = await b.anon(`/p/${draft.slug}`);
  assert.equal(drafted.status, 404);
  assert.equal(drafted.text, (await b.anon("/p/does-not-exist-12345678")).text, "a draft looks exactly like a page that doesn't exist");

  // A link saved by hand into the basket, and markup in a title.
  b.app.db.run("UPDATE items SET title = '<script>alert(1)</script> Second post' WHERE id = ?", lib.itemIds[1]);
  await keepLink(b.app, b.owner, { url: "https://notes.example/my-own-find", basketId: lib.baskets.later, title: "My own find" }, async () => null);

  const preview = (await b.api("GET", `/api/shares/${draft.id}/preview`)).json;
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.itemCount, 2, "the kept items, minus the one from a private source");
  assert.ok(preview.warnings.includes(shares.basketShows("Later")));
  assert.ok(preview.warnings.includes(shares.ownLinksPublic(1)), "links saved by hand are pointed out");
  assert.equal(preview.confirmation.statement, shares.statementIntro + shares.statementNotListed + shares.statementOutro);
  assert.ok(!preview.html.includes("Private note") && !preview.html.includes("token="), "private-source items never show");

  // A settings change after the review voids the confirmation; the items are live, so new ones don't.
  await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { curatorName: "Sam", description: "Things about <sediment> & silt." });
  const stale = await b.api("POST", `/api/shares/${draft.id}/publish`, { confirmToken: preview.confirmation.token });
  assert.equal(stale.json.error.message, shares.settingsChanged);
  const again = (await b.api("GET", `/api/shares/${draft.id}/preview`)).json;
  keepItem(b.app, b.owner, lib.itemIds[2]!, lib.baskets.later);
  const shared = await b.api("POST", `/api/shares/${draft.id}/publish`, { confirmToken: again.confirmation.token });
  assert.equal(shared.status, 200);
  assert.equal(shared.json.status, "published");

  const page = await b.anon(`/p/${draft.slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.text, (await b.api("GET", `/api/shares/${draft.id}/preview`)).json.html, "the preview is the page, byte for byte");
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.ok(!/<script/i.test(page.text) && page.text.includes("&lt;script&gt;alert(1)&lt;/script&gt; Second post"));
  assert.ok(page.text.includes("Third post"), "what was kept after the review shows: the page is live");
  const { before: pageStart, after: pageEnd } = around(b, shared.json);
  assert.ok(page.text.includes("My own find") && page.text.includes(pageStart) && page.text.includes(pageEnd), "the page is the catalog's page around its items, shared by the chosen name");
  assert.ok(!ID_SHAPE.test(page.text), `no internal identifiers: ${page.text.match(ID_SHAPE)?.[0]}`);
  for (const absent of ["Real Name", "real@example.com", "Private note", "Reading", "workflow"]) assert.ok(!page.text.includes(absent), `page must not include ${absent}`);

  // Atom: valid, stable public identifiers, the chosen name, no email; the same entries every fetch.
  const feed = await b.anon(`/p/${draft.slug}/feed.atom`);
  const doc = parseDocument(feed.text, { xmlMode: true });
  const entries = elements(doc, "entry");
  assert.equal(entries.length, 3);
  assert.ok(entries.every((e) => /^urn:uuid:[0-9a-f-]{36}$/.test(textOf(childTags(e, "id")[0]))));
  assert.equal((await b.anon(`/p/${draft.slug}/feed.atom`)).text, feed.text);
  assert.equal(textOf(elements(elements(doc, "author")[0], "name")[0]), "Sam");
  assert.ok(!feed.text.includes("@") && !ID_SHAPE.test(feed.text));
  assert.equal((await b.anon(`/p/${draft.slug}/feed.atom`, { "if-none-match": feed.headers.get("etag")! })).status, 304);

  // A link with a secret in its path never shows, even from a public source.
  b.app.db.run("UPDATE items SET url = 'https://example.org/feed/private/a8F3kQ9zLm2Xw7Rt5YbN0' WHERE id = ?", lib.itemIds[2]);
  assert.ok(!(await b.anon(`/p/${draft.slug}`)).text.includes("Third post"), "a secret-looking path keeps the item off the page");
  b.app.db.run("UPDATE items SET url = 'https://example.org/third' WHERE id = ?", lib.itemIds[2]);
  // Taking an item out of the basket takes it off the page; a source turned private drops its items.
  b.app.db.run("DELETE FROM basket_items WHERE basket_id = ? AND item_id = ?", lib.baskets.later, lib.itemIds[2]);
  assert.ok(!(await b.anon(`/p/${draft.slug}`)).text.includes("Third post"));
  b.app.db.run("UPDATE sources SET is_private = 1 WHERE id = ?", lib.publicSource);
  assert.ok(!(await b.anon(`/p/${draft.slug}`)).text.includes("Second post"));
  b.app.db.run("UPDATE sources SET is_private = 0 WHERE id = ?", lib.publicSource);

  // Pause ends it at once; sharing again asks for the review again; stopping removes the address.
  assert.equal((await b.api("POST", `/api/shares/${draft.id}/pause`)).json.notice, shares.revocationNotice);
  assert.equal((await b.anon(`/p/${draft.slug}`)).status, 404);
  assert.equal((await b.anon(`/p/${draft.slug}/feed.atom`)).status, 404);
  assert.ok((await b.api("GET", `/api/shares/${draft.id}/preview`)).json.confirmation, "sharing again needs the review again");
  const listed = (await b.api("GET", "/api/shares")).json;
  assert.deepEqual(listed.map((s: { title: string; targetKind: string; status: string }) => [s.title, s.targetKind, s.status]), [["Later", "basket", "paused"]]);
  assert.equal((await b.api("DELETE", `/api/shares/${draft.id}`)).status, 200);
  assert.deepEqual((await b.api("GET", "/api/shares")).json, []);
  const actions = b.app.db.all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'share_%' ORDER BY at, id").map((r) => r.action);
  assert.deepEqual(actions, ["share_create", "share_publish", "share_pause", "share_stop"]);
});

test("sharing a collection: a source collection shows its sources' items; a filter needs to leave reading state alone", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const col = (input: Record<string, unknown>) => createCollection(b.app, b.owner, { emoji: null, sourceIds: [], query: null, view: "list", mode: "query", ...input } as unknown as Parameters<typeof createCollection>[2]);
  const letters = col({ name: "Letters", mode: "sources", sourceIds: [lib.publicSource, lib.privateSource] });
  const shared = await share(b, "collection", letters.id);
  const page = (await b.anon(`/p/${shared.slug}`)).text;
  assert.ok(page.includes("Second post") && page.includes("Third post") && !page.includes("Private note"));
  assert.ok(shared.preview.warnings.includes(shares.newItemsShow));

  // Rules on reading state make a filter unshareable, and switch off one that was shared.
  const toRead = col({ name: "To read soon", query: { all: [{ field: "workflow", value: ["toread"] }] } });
  const blocked = (await b.api("GET", `/api/shares/for/collection/${toRead.id}`)).json;
  assert.equal(blocked.blocked, shares.usesReadingState);
  const words = col({ name: "Mud", query: { all: [{ field: "text", value: "secretword" }] } });
  const mud = await share(b, "collection", words.id);
  b.app.db.run("UPDATE collections SET query = ? WHERE id = ?", JSON.stringify({ all: [{ field: "fresh", value: true }] }), words.id);
  assert.equal((await b.anon(`/p/${mud.slug}`)).status, 404, "its rules now read reading state: not shown");
  assert.equal((await b.api("GET", "/api/shares")).json.find((s: { id: string }) => s.id === mud.id).problem, "rules");

  // A text rule matches the items' own text, never the person's highlights and notes.
  b.app.db.run("UPDATE collections SET query = ? WHERE id = ?", JSON.stringify({ all: [{ field: "text", value: "secretword" }] }), words.id);
  putAnnotation(b.app, b.owner, lib.itemIds[1]!, newId("ann"), { kind: "note", body: "my secretword note", updatedAt: new Date().toISOString() });
  assert.ok(!(await b.anon(`/p/${mud.slug}`)).text.includes("Second post"), "an item found only through a private note isn't shown");

  // Rules on baskets are allowed, and the review says the page shows what is kept.
  const kept = col({ name: "Kept letters", query: { all: [{ field: "basket", value: [lib.baskets.reading] }] } });
  const k = await share(b, "collection", kept.id);
  assert.ok(k.preview.warnings.includes(shares.collectionUsesBaskets));

  // Deleting a collection that is shared removes its page.
  deleteCollection(b.app, b.owner, letters.id);
  assert.equal((await b.anon(`/p/${shared.slug}`)).status, 404);
  assert.equal(b.app.db.get("SELECT 1 FROM shares WHERE id = ?", shared.id), undefined);
});

test("on hosted installations sharing is part of Plus: Free can't share, and a page stops showing when the plan no longer includes it", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const member = makeOwner(b.app, { admin: false });
  const s = signIn(b.app, member.accountId);
  const lib = seedLibrary(b.app, member);
  b.app.db.run("UPDATE accounts SET plan = 'free' WHERE id = ?", member.accountId);
  const free = (await b.api("GET", `/api/shares/for/basket/${lib.baskets.later}`, undefined, s)).json;
  assert.equal(free.blocked, shares.plusOnly);
  const refused = await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { curatorName: "Kim" }, s);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "plan_sharing");

  b.app.db.run("UPDATE accounts SET plan = 'plus' WHERE id = ?", member.accountId);
  const shared = await share(b, "basket", lib.baskets.later, {}, s);
  const page = await b.anon(`/p/${shared.slug}`);
  assert.equal(page.status, 200);
  const { before, after } = around(b, shared);
  assert.ok(after.includes(shares.madeWith(`${b.app.config.publicOrigin}/`, "PURSS")), "hosted pages lead visitors to the product");
  assert.ok(page.text.includes(before) && page.text.includes(after), "one small Follow button, with the feed beside it, and the way to report the page");
  assert.ok(page.text.includes(`href="${shared.followUrl.replace(/&/g, "&amp;")}"`));
  const follow = await b.anon(path(shared.followUrl));
  assert.ok(follow.text.includes(followBody(b, shared.feedUrl, "Later", "Mara")), "its own pages are named on the follow page");
  assert.ok(follow.text.includes('<link rel="alternate" type="application/atom+xml" title="Later"'), "and announced as the Atom feeds they are");

  b.app.db.run("UPDATE accounts SET plan = 'free' WHERE id = ?", member.accountId);
  assert.equal((await b.anon(`/p/${shared.slug}`)).status, 404, "back on Free: not shown, nothing deleted");
  const mine = (await b.api("GET", "/api/shares", undefined, s)).json[0];
  assert.equal(mine.problem, "plan");
  assert.equal(mine.status, "published");
  assert.ok((await b.anon(path(shared.followUrl))).text.includes(followBody(b, shared.feedUrl, new URL(shared.feedUrl).host, null)), "a page that doesn't show isn't named");
});

test("a self-hosted page has no product link, but can still be followed and reported", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const shared = await share(b, "basket", lib.baskets.later);
  const page = await b.anon(`/p/${shared.slug}`);
  const { before, after } = around(b, shared);
  assert.ok(!page.text.includes(shares.madeWith(`${b.app.config.publicOrigin}/`, "PURSS")));
  assert.ok(page.text.includes(before) && page.text.includes(after), "the Follow button and the way to report it, without the product link");
});

test("a public note shows on the page and in the feed, changes live, and the person is told it is public", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const draft = (await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { curatorName: "Mara <M>" })).json;
  const items = (await b.api("GET", `/api/shares/${draft.id}/items`)).json;
  assert.deepEqual(items.map((i: { title: string }) => i.title), ["Second post"], "the items the page shows, for writing notes");
  const noted = await b.api("PUT", `/api/shares/${draft.id}/items/${lib.itemIds[1]}/note`, { note: "  Read the <b>second</b> half.\n Really. " });
  assert.equal(noted.json.note, "Read the <b>second</b> half. Really.", "one line of plain text");
  assert.equal(noted.json.notice, null, "not public yet");
  const preview = (await b.api("GET", `/api/shares/${draft.id}/preview`)).json;
  assert.ok(preview.warnings.includes(shares.publicNotesShow(1)), "the review points out the note");
  await b.api("POST", `/api/shares/${draft.id}/publish`, { confirmToken: preview.confirmation.token });

  const page = await b.anon(`/p/${draft.slug}`);
  assert.ok(page.text.includes('<p class="note"><b>Mara &lt;M&gt;:</b> Read the &lt;b&gt;second&lt;/b&gt; half. Really.</p>'));
  const entries = elements(parseDocument((await b.anon(`/p/${draft.slug}/feed.atom`)).text, { xmlMode: true }), "entry");
  const content = childTags(entries[0], "content")[0];
  assert.equal(content.attribs.type, "html");
  assert.ok(textOf(content).startsWith("<p><b>Mara &lt;M&gt;:</b> Read the &lt;b&gt;second&lt;/b&gt; half. Really.</p>"));

  const live = await b.api("PUT", `/api/shares/${draft.id}/items/${lib.itemIds[1]}/note`, { note: "" });
  assert.equal(live.json.notice, shares.notePublic);
  assert.equal(live.json.note, null);
  assert.ok(!(await b.anon(`/p/${draft.slug}`)).text.includes('class="note"'));
  assert.equal((await b.api("PUT", `/api/shares/${draft.id}/items/${lib.itemIds[0]}/note`, { note: "x" })).status, 404, "only items the page shows");
  assert.equal((await b.api("PUT", `/api/shares/${draft.id}/items/${lib.privateItemId}/note`, { note: "x" })).status, 404, "never on a private-source item");
});

test("search engines list a page only when the person chose it, with a separate yes once it is public", async (t) => {
  const b = await boot();
  t.after(b.close);
  const lib = seedLibrary(b.app, b.owner);
  const hidden = await share(b, "basket", lib.baskets.later);
  assert.equal(hidden.preview.confirmation.statement, shares.statementIntro + shares.statementNotListed + shares.statementOutro);
  const page = await b.anon(`/p/${hidden.slug}`);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
  const refused = await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { curatorName: "Mara", listed: true });
  assert.equal(refused.json.error.code, "confirm");
  assert.equal(refused.json.error.message, shares.listingStatement);
  assert.equal((await b.api("PUT", `/api/shares/for/basket/${lib.baskets.later}`, { curatorName: "Mara", listed: true, confirmListed: true })).json.listed, true);
  const listed = await b.anon(`/p/${hidden.slug}`);
  assert.equal(listed.headers.get("x-robots-tag"), null);
  assert.ok(!listed.text.includes('name="robots"') && listed.text.includes('rel="noopener noreferrer nofollow"'), "links stay nofollow, so pages are no use for link spam");
  assert.equal((await b.anon(`/p/${hidden.slug}/feed.atom`)).headers.get("x-robots-tag"), "noindex, nofollow", "the feed is never for search results");
  const chosen = await share(b, "basket", lib.baskets.reading, { listed: true });
  assert.equal(chosen.preview.confirmation.statement, shares.statementIntro + shares.statementListed + shares.statementOutro);
});

test("the follow page accepts plain feed addresses only, never runs scripts, and opens Add source in this PURSS", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const feed = "https://blog.example/feed.xml?lang=en&x=<y>";
  const page = await b.anon(`/follow?url=${encodeURIComponent(feed)}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'.*form-action 'none'/);
  assert.ok(!/<script/i.test(page.text));
  assert.ok(page.text.includes(followBody(b, new URL(feed).href, "blog.example", null)));
  assert.ok(page.text.includes(`<link rel="alternate" type="application/rss+xml" title="blog.example" href="https://blog.example/feed.xml?lang=en&amp;x=%3Cy%3E">`), "a reader given the follow link finds the feed");
  // The Follow button maker gets its link from the same check.
  const owner = await b.api("GET", `/api/follow-link?url=${encodeURIComponent(feed)}`);
  assert.equal(owner.json.followUrl, `${b.app.config.publicOrigin}/follow?url=${encodeURIComponent(new URL(feed).href)}`);
  assert.equal((await b.api("GET", `/api/follow-link?url=${encodeURIComponent("https://x.example/feed?token=ABCDEF123456")}`)).json.error.code, "private_link");
  assert.equal((await b.api("GET", "/api/follow-link?url=nope")).json.error.code, "not_a_link");
  assert.equal((await b.anon("/api/follow-link?url=https%3A%2F%2Fx.example%2Ff")).status, 401, "signed in only");
  assert.ok(page.text.includes(`href="/app/?dialog=add&amp;url=${encodeURIComponent(new URL(feed).href)}"`), "the same deep link the bookmarklet uses; nothing is followed until Find");
  assert.ok(page.text.includes("<code>https://blog.example/feed.xml?lang=en&amp;x=%3Cy%3E</code>") && !page.text.includes("<y>"), "the normalised address, shown as text");
  assert.ok(page.text.includes(`href="${b.app.config.publicOrigin}/"`), "hosted: a way to learn what this is");
  for (const bad of ["", "javascript:alert(1)", "ftp://x.example/feed", "https://user:pw@x.example/feed", "https://x.example/feed?token=ABCDEF123456", "https://x.example/private/a8F3kQ9zLm2Xw7Rt5Yb", "not a url"]) {
    const res = await b.anon(`/follow?url=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.ok(!res.text.includes("dialog=add"), bad);
  }
  assert.equal((await b.anon("/follow")).status, 400);
});

test("anyone can report a public page; administrators review it, take it down with a reason, and the owner is told", async (t) => {
  const b = await boot({ PURSS_MODE: "hosted", PURSS_TRUST_PROXY: "1" });
  t.after(b.close);
  resetPublicReadLimit();
  const member = makeOwner(b.app, { admin: false });
  const memberSession = signIn(b.app, member.accountId);
  const lib = seedLibrary(b.app, member);
  b.app.db.run("UPDATE accounts SET plan = 'plus' WHERE id = ?", member.accountId);
  const asMember = (method: string, path: string, body?: unknown) => b.api(method, path, body, memberSession);
  b.app.db.run("UPDATE baskets SET name = 'Dubious picks' WHERE id = ?", lib.baskets.later);
  const pub = await share(b, "basket", lib.baskets.later, { curatorName: "Kim" }, memberSession);
  const preview = pub.preview;

  // The form is a plain page that may post only to itself.
  const form = await b.anon(`/p/${pub.slug}/report`);
  assert.equal(form.status, 200);
  assert.match(form.headers.get("content-security-policy")!, /form-action 'self'/);
  assert.ok(form.text.includes(`action="/p/${pub.slug}/report"`) && !/<script/i.test(form.text));
  assert.equal((await b.anon("/p/nothing-here-123/report")).status, 404);

  // Invalid reports keep what was typed and say why; nothing is stored.
  const noReason = await report(b, pub.slug, { reason: "boring", details: "This copies my photo essay without asking.", contact: "me@example.net" });
  assert.equal(noReason.status, 400);
  assert.ok(noReason.text.includes(inHtml(shares.chooseWhatsWrong)));
  assert.ok(noReason.text.includes("This copies my photo essay without asking.") && noReason.text.includes('value="me@example.net"'));
  assert.equal((await report(b, pub.slug, { reason: "copyright", details: "bad" })).status, 400);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_reports")!.n, 0);

  // Only this site's own form can send one: a post from another site is refused and stores nothing.
  for (const extra of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    assert.equal((await report(b, pub.slug, { reason: "spam", details: "Sent from somewhere else." }, "198.51.100.6", extra)).status, 403);
  }
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_reports")!.n, 0);
  const sent = await report(b, pub.slug, { reason: "copyright", details: "The second link copies my <photo> essay.", contact: "me@example.net" });
  assert.equal(sent.status, 200);
  assert.ok(sent.text.includes(sharingRoute.reportThanksBody(inHtml("Dubious picks"), pub.slug)));
  const row = b.app.db.get<Record<string, unknown>>("SELECT * FROM share_reports")!;
  assert.equal(row.details, "The second link copies my <photo> essay.");
  assert.ok(!JSON.stringify(row).includes("198.51.100.7"), "the reporter's address isn't kept");
  // Every administrator gets one bell entry per page per day, however many reports arrive; the owner gets none.
  await report(b, pub.slug, { reason: "spam", details: "Also it is spam, honestly." }, "198.51.100.8");
  const adminBell = b.app.db.all<{ title: string }>("SELECT title FROM notifications WHERE account_id = ? AND dedup_key LIKE 'share-report:%'", b.owner.accountId);
  assert.deepEqual(adminBell.map((n) => n.title), [shares.reportedTitle("Dubious picks")]);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND dedup_key LIKE 'share-report:%'", member.accountId)!.n, 0);

  // Five reports an hour from one address; then a polite refusal.
  for (let i = 0; i < 3; i++) assert.equal((await report(b, pub.slug, { reason: "other", details: `Report number ${i} here.` }, "198.51.100.9")).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await report(b, pub.slug, { reason: "other", details: `More reports ${i} here.` }, "198.51.100.9")).status, 200);
  assert.equal((await report(b, pub.slug, { reason: "other", details: "One report too many." }, "198.51.100.9")).status, 429);

  // Administrators see the reports and the page; members can't.
  assert.equal((await asMember("GET", "/api/admin/reports")).status, 403);
  const open = (await b.api("GET", "/api/admin/reports")).json;
  assert.equal(open.length, 7);
  assert.equal(open[0].share.title, "Dubious picks");
  assert.equal(open[0].share.openReports, 7);
  assert.equal((await b.api("GET", `/api/admin/shares/${pub.id}/page`)).json.html, (await b.anon(`/p/${pub.slug}`)).text);
  const unreported = (await b.api("PUT", `/api/shares/for/basket/${createBasket(b.app, b.owner, { name: "Mine", captureMode: "metadata" }).id}`, { curatorName: "Admin" })).json;
  assert.equal((await b.api("GET", `/api/admin/shares/${unreported.id}/page`)).status, 404, "only reported pages are visible to administrators");

  const dismissed = await b.api("POST", `/api/admin/reports/${open[6].id}/dismiss`);
  assert.equal(dismissed.status, 200);
  assert.equal((await b.api("POST", `/api/admin/reports/${open[6].id}/dismiss`)).status, 404, "only open reports");

  // Taking down needs a recent strong sign-in and a reason.
  const stale = signIn(b.app, b.owner.accountId, { authAgeSeconds: 3600 });
  for (const action of ["takedown", "restore"]) {
    const denied = await b.api("POST", `/api/admin/shares/${pub.id}/${action}`, { reason: "Copies a photographer's work." }, stale);
    assert.equal(denied.json.error.code, "step_up", action);
  }
  assert.equal((await b.api("POST", `/api/admin/shares/${pub.id}/takedown`, { reason: "no" })).status, 400);
  assert.equal((await b.api("POST", `/api/admin/shares/${pub.id}/takedown`, { reason: "Copies a photographer's work." })).status, 200);
  assert.equal((await b.anon(`/p/${pub.slug}`)).status, 404, "gone at once");
  assert.equal((await b.anon(`/p/${pub.slug}/feed.atom`)).status, 404);
  assert.equal((await b.anon(`/p/${pub.slug}/report`)).status, 404);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_reports WHERE resolved_at IS NULL")!.n, 0, "its open reports are closed");
  assert.equal((await b.api("GET", "/api/admin/reports")).json.length, 0);
  const down = (await b.api("GET", "/api/admin/reports?status=taken_down")).json;
  assert.deepEqual(down.map((r: { share: { id: string } }) => r.share.id), [pub.id], "one row per taken-down page, to restore it from");

  // The owner sees why, can't publish it again, and is told in the bell.
  const mine = (await asMember("GET", "/api/shares")).json[0];
  assert.equal(mine.status, "paused");
  assert.deepEqual(mine.takenDown && mine.takenDown.reason, "Copies a photographer's work.");
  const ownerPreview = (await asMember("GET", `/api/shares/${pub.id}/preview`)).json;
  assert.equal(ownerPreview.blockers[0], shares.takenDownHosted);
  assert.equal(ownerPreview.confirmation, null);
  const refused = await asMember("POST", `/api/shares/${pub.id}/publish`, { confirmToken: preview.confirmation.token });
  assert.equal(refused.status, 403);
  assert.equal((await asMember("DELETE", `/api/shares/${pub.id}`)).json.error.code, "taken_down", "a taken-down page can't be removed to share it afresh");
  const { confirmToken } = basketDeletePreview(b.app, member, lib.baskets.later);
  assert.throws(() => deleteBasket(b.app, member, lib.baskets.later, confirmToken), (e: unknown) => e instanceof HttpError && e.code === "taken_down", "nor can its basket be deleted to get rid of it");
  const told = b.app.db.get<{ title: string; body: string }>("SELECT title, body FROM notifications WHERE account_id = ? AND dedup_key LIKE 'share-takedown:%'", member.accountId)!;
  assert.equal(told.title, shares.takenDownTitle("Dubious picks"));
  assert.match(told.body, /Copies a photographer's work\./);

  // Restoring lets the owner publish again after a fresh review; it doesn't publish by itself.
  assert.equal((await b.api("POST", `/api/admin/shares/${pub.id}/restore`)).status, 200);
  assert.equal((await b.anon(`/p/${pub.slug}`)).status, 404, "still paused");
  const fresh = (await asMember("GET", `/api/shares/${pub.id}/preview`)).json;
  assert.ok(fresh.confirmation);
  assert.equal((await asMember("POST", `/api/shares/${pub.id}/publish`, { confirmToken: fresh.confirmation.token })).status, 200);
  assert.equal((await b.anon(`/p/${pub.slug}`)).status, 200);
  const actions = b.app.db.all<{ action: string }>("SELECT action FROM audit_events WHERE action IN ('share_report', 'share_report_dismiss', 'share_takedown', 'share_restore') ORDER BY at, id").map((r) => r.action);
  assert.deepEqual(actions, [...Array(7).fill("share_report"), "share_report_dismiss", "share_takedown", "share_restore"]);
});

test("a flood of reports about one page stops being stored", async (t) => {
  const b = await boot({ PURSS_TRUST_PROXY: "1" });
  t.after(b.close);
  resetPublicReadLimit();
  const lib = seedLibrary(b.app, b.owner);
  const pub = await share(b, "basket", lib.baskets.later);
  for (let i = 0; i < 60; i++) assert.equal((await report(b, pub.slug, { reason: "spam", details: `Report ${i} about this.` }, `203.0.113.${i}`)).status, 200);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_reports")!.n, 50, "past 50 open reports a page, more are thanked but not stored");
});

test("public reads are rate-limited per address", () => {
  resetPublicReadLimit();
  for (let i = 0; i < 120; i++) limitPublicRead("203.0.113.9");
  assert.throws(() => limitPublicRead("203.0.113.9"), (e: unknown) => e instanceof HttpError && e.status === 429);
  limitPublicRead("203.0.113.10");
  resetPublicReadLimit();
  limitPublicRead("203.0.113.9");
});
