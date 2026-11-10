import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_CAPTURE_MAX_CHARS, browserCaptureSchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { createBasket } from "./collections.ts";
import { getItemDetail, listItems } from "./items.ts";
import { keepWithBrowserCapture, lookupUrl } from "./links.ts";
import { OPTIONAL_SECTION_NAMES, SECTION_NAMES, sha256Hex } from "./archive-format.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { reconcile, usedBytes } from "./storage.ts";
import { applySyncBatch } from "./sync.ts";

const PAGE = "https://quiet.example/essays/tides?utm_source=feed";
const HTML = '<article><h1>Tides</h1><p onclick="steal()">Neap tides follow the quarter moons.</p><script>alert(1)</script><img src="javascript:alert(1)"><a href="javascript:alert(2)">x</a></article>';

function setup(allocationBytes: number | null = null) {
  const { app, cleanup } = makeTestApp();
  const owner = makeOwner(app, { allocationBytes });
  const basket = createBasket(app, owner, { name: "Reading", captureMode: "metadata" }).id;
  return { app, owner, basket, cleanup };
}
const one = <T>(app: App, sql: string, ...args: string[]) => app.db.get<T>(sql, ...args);
const captureRows = (app: App, itemId: string) => app.db.all<{ id: string; kind: string; status: string; html: string; text: string; title: string | null; final_url: string }>(
  "SELECT id, kind, status, html, text, title, final_url FROM captures WHERE item_id = ? ORDER BY created_at", itemId);
const liveCaptureObjects = (app: App, itemId: string) => app.db.all<{ ref_id: string; bytes: number }>(
  "SELECT ref_id, bytes FROM stored_objects WHERE item_id = ? AND kind = 'capture' AND released_at IS NULL", itemId);

test("a page kept with its browser text becomes one item with a sanitized, labelled, searchable, counted capture", (t) => {
  const { app, owner, basket, cleanup } = setup();
  t.after(cleanup);
  const before = usedBytes(app, owner.accountId);
  const out = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: basket, title: "Tides", html: HTML });
  assert.deepEqual([out.existing, out.alreadyInBasket, out.textSaved, out.textReplaced, out.textNote, out.captureQueued], [false, false, true, false, null, false]);

  const [cap, ...rest] = captureRows(app, out.itemId);
  assert.equal(rest.length, 0);
  assert.deepEqual([cap!.kind, cap!.status, cap!.title, cap!.final_url], ["browser", "done", "Tides", PAGE]);
  for (const bad of ["onclick", "<script", "alert", "javascript:"]) assert.ok(!cap!.html.includes(bad), `sanitized again on the server: ${bad}`);
  assert.match(cap!.text, /Neap tides follow the quarter moons/);

  const detail = getItemDetail(app, owner, out.itemId);
  const label = detail.captures.find((c) => c.id === cap!.id)!;
  assert.deepEqual([label.level, label.label], ["browser", "Captured in your browser"]);
  assert.match(label.note!, /as your browser showed it/);
  assert.deepEqual(detail.contentRef, { kind: "capture", id: cap!.id }, "the reader shows the captured text");
  assert.match(detail.contentHtml!, /quarter moons/);

  assert.equal(listItems(app, owner, { scope: "all", filter: "all", q: "neap quarter" }).items[0]?.id, out.itemId, "search finds the captured text");
  const objects = liveCaptureObjects(app, out.itemId);
  assert.equal(objects.length, 1);
  assert.ok(usedBytes(app, owner.accountId) - before >= objects[0]!.bytes, "counted against storage");
  assert.equal(reconcile(app, owner.accountId).difference, 0);

  const lookup = lookupUrl(app, owner, "http://quiet.example/essays/tides/");
  assert.equal(lookup.item?.id, out.itemId);
  assert.equal(lookup.item?.browserCapturedAt, detail.captures.find((c) => c.level === "browser")!.createdAt);
});

test("in a 'Save readable text' basket the browser text stands in for a server fetch", (t) => {
  const { app, owner, cleanup } = setup();
  t.after(cleanup);
  const text = createBasket(app, owner, { name: "Archive", captureMode: "text" }).id;
  const out = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: text, html: HTML });
  assert.equal(out.captureQueued, false);
  assert.equal(app.db.all("SELECT 1 FROM jobs WHERE kind = 'capture.fulltext'").length, 0, "the server fetches nothing");
  assert.deepEqual(captureRows(app, out.itemId).map((c) => c.kind), ["browser"]);
});

test("capturing again replaces the text in place and releases the earlier copy's storage", (t) => {
  const { app, owner, basket, cleanup } = setup();
  t.after(cleanup);
  const first = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: basket, html: "<p>First version of the essay.</p>" });
  const firstId = captureRows(app, first.itemId)[0]!.id;
  const again = keepWithBrowserCapture(app, owner, { url: "https://quiet.example/essays/tides", basketId: basket, html: "<p>Second, longer version of the essay with more words.</p>" });
  assert.deepEqual([again.itemId, again.existing, again.alreadyInBasket, again.textSaved, again.textReplaced], [first.itemId, true, true, true, true]);
  const rows = captureRows(app, first.itemId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, firstId, "same capture id, so highlights made on it still name it");
  assert.match(rows[0]!.text, /Second, longer/);
  assert.equal(liveCaptureObjects(app, first.itemId).length, 1, "one live ledger object");
  assert.equal(reconcile(app, owner.accountId).difference, 0);
  assert.equal(listItems(app, owner, { scope: "all", filter: "all", q: "First version" }).items.length, 0, "the old text left the index");
});

test("a server capture and a browser capture of the same item live side by side", (t) => {
  const { app, owner, basket, cleanup } = setup();
  t.after(cleanup);
  const src = makeSource(app, owner, "Quiet Essays", "feed/1");
  applySyncBatch(app, owner.engineUserId, batch([entry("feed/1", { url: "https://quiet.example/essays/tides", title: "Tides" })]));
  const item = one<{ id: string }>(app, "SELECT id FROM items WHERE source_id = ?", src)!.id;
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, text, html, created_at, completed_at) VALUES ('cap_server', ?, ?, 'fulltext', 'done', 'server text', '<p>server text</p>', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", owner.workspaceId, item);
  const out = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: basket, html: "<p>Browser text.</p>" });
  assert.equal(out.itemId, item, "the feed item, not a duplicate");
  assert.deepEqual(getItemDetail(app, owner, item).captures.map((c) => c.level), ["metadata", "fulltext", "browser"]);
  assert.match(getItemDetail(app, owner, item).contentHtml!, /Browser text/, "the newest text is shown");
});

test("when the text doesn't fit, the link is still kept and an earlier capture stays", (t) => {
  const { app, owner, basket, cleanup } = setup(60_000);
  t.after(cleanup);
  const small = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: basket, html: "<p>Short text that fits.</p>" });
  assert.equal(small.textSaved, true);
  const huge = `<p>${"word ".repeat(40_000)}</p>`;
  const again = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: basket, html: huge });
  assert.deepEqual([again.textSaved, again.textReplaced], [false, false]);
  assert.match(again.textNote!, /text captured earlier is kept/);
  assert.match(captureRows(app, small.itemId)[0]!.text, /Short text that fits/);
  assert.equal(reconcile(app, owner.accountId).difference, 0);

  const other = keepWithBrowserCapture(app, owner, { url: "https://quiet.example/other", basketId: basket, html: huge });
  assert.deepEqual([other.existing, other.textSaved], [false, false]);
  assert.match(other.textNote!, /only the link was kept/);
  assert.equal(one<{ n: number }>(app, "SELECT COUNT(*) AS n FROM basket_items WHERE item_id = ?", other.itemId)!.n, 1, "the link is kept");
  assert.equal(captureRows(app, other.itemId).length, 0);
  assert.equal(one<{ r: string | null }>(app, "SELECT paused_reason AS r FROM storage_accounts WHERE account_id = ?", owner.accountId)?.r ?? null, null, "an optional copy doesn't pause new items");
});

test("nothing is kept when no readable text survives, or the basket isn't the person's", (t) => {
  const { app, owner, cleanup } = setup();
  t.after(cleanup);
  const other = makeOwner(app, { admin: false });
  const theirs = createBasket(app, other, { name: "Theirs", captureMode: "metadata" }).id;
  assert.throws(() => keepWithBrowserCapture(app, owner, { url: PAGE, basketId: createBasket(app, owner, { name: "Mine", captureMode: "metadata" }).id, html: "<script>x()</script><style>p{}</style>" }),
    (e) => e instanceof HttpError && e.status === 400 && e.code === "no_text");
  assert.throws(() => keepWithBrowserCapture(app, owner, { url: PAGE, basketId: theirs, html: HTML }), (e) => e instanceof HttpError && e.status === 404);
  assert.throws(() => keepWithBrowserCapture(app, owner, { url: "ftp://quiet.example/x", basketId: theirs, html: HTML }), (e) => e instanceof HttpError && e.status === 400);
  for (const table of ["captures", "basket_items"]) assert.equal(one<{ n: number }>(app, `SELECT COUNT(*) AS n FROM ${table}`)!.n, 0, table);
  assert.equal(one<{ n: number }>(app, "SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?", owner.workspaceId)!.n, 0, "no stray item");
});

test("another PURSS's copy of the page is never touched", (t) => {
  const { app, owner, basket, cleanup } = setup();
  t.after(cleanup);
  const other: Principal = makeOwner(app, { admin: false });
  const theirBasket = createBasket(app, other, { name: "Theirs", captureMode: "metadata" }).id;
  const theirs = keepWithBrowserCapture(app, other, { url: PAGE, basketId: theirBasket, html: "<p>Their private text.</p>" });
  const mine = keepWithBrowserCapture(app, owner, { url: PAGE, basketId: basket, html: "<p>My text.</p>" });
  assert.notEqual(mine.itemId, theirs.itemId);
  assert.equal(mine.existing, false);
  assert.match(captureRows(app, theirs.itemId)[0]!.text, /Their private text/);
  assert.equal(listItems(app, owner, { scope: "all", filter: "all", q: "private" }).items.length, 0);
});

test("the request schema caps the HTML", () => {
  assert.equal(browserCaptureSchema.safeParse({ url: PAGE, basketId: "bsk_x", html: "x".repeat(BROWSER_CAPTURE_MAX_CHARS) }).success, true);
  assert.equal(browserCaptureSchema.safeParse({ url: PAGE, basketId: "bsk_x", html: "x".repeat(BROWSER_CAPTURE_MAX_CHARS + 1) }).success, false);
  assert.equal(browserCaptureSchema.safeParse({ url: PAGE, basketId: "bsk_x", html: "" }).success, false);
});

/** Recompute the manifest after the test edits a section, as a hostile or foreign producer could. */
function rebuildManifest(doc: any): any {
  const sections: Record<string, { count: number; sha256: string }> = {};
  for (const n of [...SECTION_NAMES, ...OPTIONAL_SECTION_NAMES]) if (doc[n] !== undefined) sections[n] = { count: Array.isArray(doc[n]) ? doc[n].length : 1, sha256: sha256Hex(JSON.stringify(doc[n])) };
  return { ...doc, manifest: { algorithm: "sha256", sections } };
}

test("export carries the capture's kind and import restores it as a browser capture", async (t) => {
  const a = setup();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  keepWithBrowserCapture(a.app, a.owner, { url: PAGE, basketId: a.basket, html: "<p>Neap tides, as I saw them.</p>" });
  const parts: string[] = [];
  await streamExport(a.app, a.owner, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));
  const exported = doc.items.flatMap((i: { captures: { kind: string }[] }) => i.captures);
  assert.deepEqual(exported.map((c: { kind: string }) => c.kind), ["browser"]);
  // A crafted archive with two browser captures for one item imports only the newer one.
  const item = doc.items[0];
  item.captures.push({ ...item.captures[0], id: "cap_00000000000000000000000000", text: "older", completedAt: "2020-01-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" });
  const pb = makeOwner(b.app);
  applyImport(b.app, pb, stageImport(b.app, pb, rebuildManifest(doc)).token);
  const rows = b.app.db.all<{ kind: string; text: string }>("SELECT kind, text FROM captures");
  assert.deepEqual(rows.map((r) => [r.kind, r.text]), [["browser", "Neap tides, as I saw them."]]);
  const itemId = b.app.db.get<{ id: string }>("SELECT id FROM items")!.id;
  assert.equal(getItemDetail(b.app, pb, itemId).captures.at(-1)?.level, "browser");
  assert.equal(reconcile(b.app, pb.accountId).difference, 0);
});
