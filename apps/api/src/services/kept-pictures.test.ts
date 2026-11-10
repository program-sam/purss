import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail, listItems } from "./items.ts";
import { createBasket, deleteItemNow } from "./collections.ts";
import { keepItem, unkeepItem } from "./state.ts";
import { completeCapture, failCapture, saveBrowserCapture } from "./captures.ts";
import { expireLeases } from "./jobs.ts";
import { settleFailedJob } from "./failures.ts";
import { IMAGES_PER_ITEM, IMAGE_BYTES_PER_ITEM, completeImages, pictureAddresses, queueItemImages } from "./images.ts";
import { categories, reconcile, recountUsedBytes, summary, usedBytes } from "./storage.ts";

const PNG = (extra: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><body>Not found</body></html>");
const url = (n: number | string) => `https://pictures.example/${n}.png`;
const img = (n: number | string, attrs = "") => `<img src="${url(n)}"${attrs}>`;
const delivered = (urls: string[], bytes = PNG(100)) => ({ images: urls.map((u) => ({ url: u, contentType: "image/png", data: bytes.toString("base64") })) });

type Owner = Principal & { engineUserId: string };

function setup(allocationBytes: number | null = null) {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app, { allocationBytes });
  const src = makeSource(app, p, "Webcomic", "feed/1");
  const text = createBasket(app, p, { name: "Comics", captureMode: "text" }).id;
  const links = createBasket(app, p, { name: "Links", captureMode: "metadata" }).id;
  return { app, p, src, text, links, cleanup };
}

/**
 * An item whose feed content carries pictures; returns its id. It has no page of its own unless asked, so keeping it
 * queues no readable copy and its pictures are asked for at once (with a page, they follow the copy).
 */
function comic(app: App, p: Owner, src: string, contentHtml: string, imageUrl: string | null = url("cover"), page: string | null = null): string {
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { contentHtml, imageUrl, url: page })]));
  return listItems(app, p, { scope: `source:${src}`, sort: "newest" }).items[0]!.id;
}

const jobs = (app: App) => app.db.all<{ status: string; payload: string }>("SELECT status, payload FROM jobs WHERE kind = 'capture.images' ORDER BY created_at").map((j) => ({ status: j.status, ...JSON.parse(j.payload) as { itemId: string; urls: string[]; maxBytes: number } }));
const stored = (app: App, itemId: string) => app.db.all<{ url: string; role: string; bytes: number }>("SELECT url, role, bytes FROM item_images WHERE item_id = ? ORDER BY created_at, url", itemId);
const imageObjects = (app: App) => app.db.get<{ n: number; b: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM stored_objects WHERE kind = 'image' AND released_at IS NULL")!;

test("pictureAddresses takes the pictures in a text, once each, and leaves out pixels, emoji and tiny images", () => {
  const html = `<p>x</p>${img(1)}${img(1)}<img src="https://pictures.example/a.png?x=1&amp;y=2">${img("pixel")}<img src="https://s.w.org/images/core/emoji/14/svg/1f600.svg">`
    + `${img(2, ' width="16" height="16"')}${img(3, ' width="640" height="480"')}<img src="data:image/png;base64,AAAA"><img src="/relative.png"><img>`;
  assert.deepEqual(pictureAddresses(html), [url(1), "https://pictures.example/a.png?x=1&y=2", url(3)]);
  assert.deepEqual(pictureAddresses(null), []);
});

test("keeping an item in a basket that keeps text asks for its picture and the pictures in its text; other baskets do not", (t) => {
  const { app, p, src, text, links, cleanup } = setup();
  t.after(cleanup);
  const id = comic(app, p, src, `<p>Panel one</p>${img(1)}<p>Panel two</p>${img(2)}`);
  keepItem(app, p, id, links);
  assert.deepEqual(jobs(app), [], "a basket that keeps only the details keeps no pictures");
  keepItem(app, p, id, text);
  assert.deepEqual(jobs(app).map((j) => j.urls), [[url("cover"), url(1), url(2)]], "the item's picture first, then those in its text, no capture is on the way for this one");

  // Not for a private source, and not for an item no basket keeps.
  const secret = makeSource(app, p, "Secret", "feed/2", { isPrivate: true });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/2", { contentHtml: img(9) })]));
  const hidden = listItems(app, p, { scope: `source:${secret}` }).items[0]!.id;
  keepItem(app, p, hidden, text);
  assert.equal(jobs(app).length, 1, "the private source's pictures are not fetched");
  assert.equal(queueItemImages(app, id), true, "asking again for what is missing is allowed; the job is the same one");
  assert.equal(jobs(app).length, 1);
});

test("with a readable copy on the way the pictures wait for it; its pictures replace the feed's text, and a failed copy leaves the feed's", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const a = comic(app, p, src, img("feed-a"), url("cover-a"), "https://comic.example/a");
  keepItem(app, p, a, text);
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", a)!.id;
  assert.deepEqual(jobs(app), [], "the readable copy is pending: the pictures follow it");
  const html = `<p>${"word ".repeat(300)}</p>${img("copy-1")}${img("copy-2")}`;
  app.db.tx(() => completeCapture(app, cap, { ok: true, title: "T", text: "word ".repeat(300), html, finalUrl: "https://example.org/a", bytes: 1600 }));
  assert.deepEqual(jobs(app).map((j) => j.urls), [[url("cover-a"), url("copy-1"), url("copy-2")]], "the item's picture and the copy's; the reader shows the copy, so not the feed's");

  const b = comic(app, p, src, img("feed-b"), url("cover-b"), "https://comic.example/b");
  keepItem(app, p, b, text);
  const capB = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", b)!.id;
  app.db.tx(() => failCapture(app, capB, "The page couldn't be captured."));
  assert.deepEqual(jobs(app)[1]!.urls, [url("cover-b"), url("feed-b")], "a webcomic whose page can't be read keeps its picture and the one in its feed");
});

test("a copy that is only part of the page does not bring its pictures", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const a = comic(app, p, src, `<p>A feed text with a good picture.</p>${img("feed")}`, null, "https://comic.example/a");
  keepItem(app, p, a, text);
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", a)!.id;
  const wall = "Pour accéder à l’intégralité des contenus, nous vous invitons à vous identifier. Vous n’avez pas encore de compte ? Abonnez-vous";
  app.db.tx(() => completeCapture(app, cap, { ok: true, title: "T", text: wall, html: `<p>${wall}</p>${img("logo")}`, finalUrl: "https://example.org/a", bytes: 300 }));
  assert.deepEqual(jobs(app).map((j) => j.urls), [[url("feed")]], "the logo on the subscription page is not kept; the feed's text is what the reader shows");
});

test("what the worker brings is stored once per picture and counted once: item in two baskets, unkeeping, and the ledger", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const second = createBasket(app, p, { name: "More comics", captureMode: "text" }).id;
  const id = comic(app, p, src, `${img(1)}${img(2)}`);
  keepItem(app, p, id, text);
  const before = usedBytes(app, p.accountId);
  const { urls } = jobs(app)[0]!;
  app.db.tx(() => completeImages(app, { itemId: id, urls }, delivered(urls, PNG(1000))));
  assert.deepEqual(stored(app, id).map((s) => [s.url, s.role]).sort(), [[url(1), "inline"], [url(2), "inline"], [url("cover"), "cover"]].sort());
  const bytes = 3 * PNG(1000).length;
  assert.deepEqual({ ...imageObjects(app) }, { n: 3, b: bytes });
  assert.equal(usedBytes(app, p.accountId) - before, bytes);
  assert.equal(categories(app, p.accountId).kept >= bytes, true, "kept pictures are in Kept in baskets");

  // The same item in a second basket: nothing more is asked for or counted.
  keepItem(app, p, id, second);
  assert.equal(jobs(app).length, 1);
  assert.equal(imageObjects(app).b, bytes);

  // Unkept from one basket: still kept. From the last: they stay, as the readable copy does, but are no longer "kept".
  unkeepItem(app, p, id, text);
  assert.ok(categories(app, p.accountId).kept >= bytes, "still in a basket: still kept");
  assert.equal(imageObjects(app).b, bytes, "nothing is released by unkeeping");
  unkeepItem(app, p, id, second);
  assert.equal(imageObjects(app).b, bytes, "nor from the last basket: nothing is silently dropped");
  assert.ok(categories(app, p.accountId).feed >= bytes, "they join the feed's copies");
  assert.equal(categories(app, p.accountId).kept, 0);

  // A repeated answer from the worker adds nothing; the ledger agrees with the pictures.
  app.db.tx(() => completeImages(app, { itemId: id, urls }, delivered(urls, PNG(1000))));
  assert.equal(stored(app, id).length, 3);
  assert.equal(reconcile(app, p.accountId).difference, 0);
  assert.deepEqual(recountUsedBytes(app, p.accountId).tracked, recountUsedBytes(app, p.accountId).counted);

  // Deleting the item releases them.
  const released = app.db.tx(() => deleteItemNow(app, p, id));
  assert.ok(released! >= bytes);
  assert.deepEqual({ ...imageObjects(app) }, { n: 0, b: 0 });
  assert.equal(stored(app, id).length, 0);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("an item keeps at most 20 pictures and 10 MB, whatever the worker sends, and only what was asked for and really is a picture", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const urls = Array.from({ length: 25 }, (_, i) => url(i));
  const id = comic(app, p, src, urls.map((u) => `<img src="${u}">`).join(""), null);
  keepItem(app, p, id, text);
  assert.equal(jobs(app)[0]!.urls.length, IMAGES_PER_ITEM, "no more than 20 are asked for");
  assert.equal(jobs(app)[0]!.maxBytes, IMAGE_BYTES_PER_ITEM);

  // Nineteen of the twenty asked for, and one that was not asked for.
  app.db.tx(() => completeImages(app, { itemId: id, urls: urls.slice(0, 20) }, delivered([...urls.slice(0, 19), url("unasked")])));
  assert.equal(stored(app, id).length, 19, "only what was asked for is kept");
  assert.equal(stored(app, id).some((s) => s.url === url("unasked")), false);
  // A second try can fill the one place left, and no more.
  app.db.tx(() => completeImages(app, { itemId: id, urls: urls.slice(19, 22) }, delivered(urls.slice(19, 22))));
  assert.equal(stored(app, id).length, IMAGES_PER_ITEM, "the 20th fits, the 21st and 22nd do not");
  // More than twenty in one answer is not an answer from our worker.
  const other = comic(app, p, src, urls.map((u) => `<img src="${u}">`).join(""), null);
  app.db.tx(() => completeImages(app, { itemId: other, urls: urls.slice(0, 20) }, delivered(urls.slice(0, 21))));
  assert.equal(stored(app, other).length, 0);

  const big = comic(app, p, src, `${img("a")}${img("b")}${img("c")}`, null);
  keepItem(app, p, big, text);
  const six = 6 * 1024 * 1024;
  app.db.tx(() => completeImages(app, { itemId: big, urls: [url("a"), url("b"), url("c")] }, {
    images: [{ url: url("a"), contentType: "image/png", data: PNG(six).toString("base64") }, { url: url("b"), contentType: "image/png", data: PNG(six).toString("base64") },
      { url: url("c"), contentType: "image/png", data: PNG(1000).toString("base64") }] }));
  assert.deepEqual(stored(app, big).map((s) => s.url).sort(), [url("a"), url("c")], "the second 6 MB would pass 10 MB: left out; the small one after it fits");
  assert.ok(stored(app, big).reduce((n, s) => n + s.bytes, 0) <= IMAGE_BYTES_PER_ITEM);

  const odd = comic(app, p, src, `${img("svg")}${img("html")}${img("text")}`, null);
  keepItem(app, p, odd, text);
  app.db.tx(() => completeImages(app, { itemId: odd, urls: [url("svg"), url("html"), url("text")] }, { images: [
    { url: url("svg"), contentType: "image/svg+xml", data: SVG.toString("base64") }, { url: url("html"), contentType: "image/png", data: HTML.toString("base64") },
    { url: url("text"), contentType: "image/png", data: Buffer.from("just text").toString("base64") }] }));
  assert.deepEqual(stored(app, odd), [], "the type comes from the bytes: script-capable SVG, a page and text are not pictures, whatever the header says");
});

test("a picture that does not fit the storage left is not stored and does not pause new items; nothing else is touched", (t) => {
  const { app, p, src, text, cleanup } = setup(60_000);
  t.after(cleanup);
  const id = comic(app, p, src, `${img(1)}${img(2)}${img(3)}`, null);
  keepItem(app, p, id, text);
  assert.deepEqual(jobs(app)[0]!.urls, [url(1), url(2), url(3)], "the first picture is the item's own");
  const room = 60_000 - usedBytes(app, p.accountId);
  const size = Math.floor(room * 0.4) - 8;
  const { urls } = jobs(app)[0]!;
  app.db.tx(() => completeImages(app, { itemId: id, urls }, delivered(urls, PNG(size))));
  assert.equal(stored(app, id).length, 2, "two fit, the third does not");
  assert.equal(summary(app, p.accountId).growthPaused, false, "pictures are optional: no pause");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM basket_items")!.n, 1, "the keep itself stands");
  assert.ok(usedBytes(app, p.accountId) <= 60_000);

  // With the account already full, nothing is even asked for.
  const full = comic(app, p, src, img("full"), null);
  app.db.run("UPDATE storage_accounts SET used_bytes = 60000 WHERE account_id = ?", p.accountId);
  keepItem(app, p, full, text);
  assert.equal(jobs(app).length, 1);
});

test("the reader shows the stored copy of a picture and the original address for any that is not stored", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const id = comic(app, p, src, `<p>Panel</p>${img(1)}<img src="https://pictures.example/a.png?x=1&amp;y=2">${img(2)}`);
  keepItem(app, p, id, text);
  const { urls } = jobs(app)[0]!;
  const keep = [url("cover"), url(1), "https://pictures.example/a.png?x=1&y=2"];
  app.db.tx(() => completeImages(app, { itemId: id, urls }, delivered(keep)));
  const ids = new Map(app.db.all<{ id: string; url: string }>("SELECT id, url FROM item_images WHERE item_id = ?", id).map((r) => [r.url, r.id]));
  const detail = getItemDetail(app, p, id);
  assert.ok(detail.contentHtml!.includes(`src="/api/items/${id}/images/${ids.get(url(1))}"`), "stored: product storage");
  assert.ok(detail.contentHtml!.includes(`src="/api/items/${id}/images/${ids.get("https://pictures.example/a.png?x=1&y=2")}"`), "an address with & is found too");
  assert.ok(detail.contentHtml!.includes(`src="${url(2)}"`), "not stored: the original address");
  assert.equal(detail.keptPicture, `/api/items/${id}/images/${ids.get(url("cover"))}`, "the item's own picture, as stored");
  assert.equal(detail.imageUrl, url("cover"), "its own address is left as it is");
  assert.equal(listItems(app, p, { scope: `source:${src}` }).items[0]!.imageUrl, url("cover"), "lists are unchanged: feed items and cards keep their addresses");
});

test("pictures are in the export, and only when there are any", async (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const { streamExport } = await import("./portability.ts");
  const { parseArchive } = await import("./archive-format.ts");
  const dump = async () => { let out = ""; await streamExport(app, p, (c) => { out += c; }); return JSON.parse(out) as Record<string, unknown>; };
  const id = comic(app, p, src, img(1));
  keepItem(app, p, id, text);
  assert.equal("images" in await dump(), false, "nothing kept, no section");
  app.db.tx(() => completeImages(app, { itemId: id, urls: [url(1)] }, delivered([url(1)], PNG(50))));
  const doc = await dump();
  const archive = parseArchive(doc);
  assert.equal(archive.images.length, 1);
  assert.deepEqual({ itemId: archive.images[0]!.itemId, url: archive.images[0]!.url, role: archive.images[0]!.role, contentType: archive.images[0]!.contentType }, { itemId: id, url: url(1), role: "inline", contentType: "image/png" });
  assert.deepEqual(Buffer.from(archive.images[0]!.data, "base64"), PNG(50));
});

test("pictures come back with an import, once, within the limits, and only if they are what the file says", async (t) => {
  const a = setup();
  const b = setup();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const { streamExport, stageImport, applyImport } = await import("./portability.ts");
  const dump = async () => { let out = ""; await streamExport(a.app, a.p, (c) => { out += c; }); return JSON.parse(out) as { images: { itemId: string; url: string; role: string; contentType: string; sha256: string; data: string }[] };};
  // An item with a page of its own, so that importing the file again finds the item it made the first time.
  const id = comic(a.app, a.p, a.src, `${img(1)}${img(2)}`, url("cover"), "https://comic.example/1");
  keepItem(a.app, a.p, id, a.text);
  const urls = [url("cover"), url(1), url(2)];
  a.app.db.tx(() => completeImages(a.app, { itemId: id, urls }, delivered(urls, PNG(300))));
  const doc = await dump();
  assert.equal(doc.images.length, 3);

  // A damaged picture and one that isn't a picture are left out; the others come back.
  doc.images[0]!.sha256 = "0".repeat(64);
  doc.images[1]!.data = SVG.toString("base64");
  const text = doc as Record<string, unknown>;
  // The manifest covers the section as written, so it is made again for the edited file.
  const { createHash } = await import("node:crypto");
  const manifest = (text.manifest as { sections: Record<string, { count: number; sha256: string }> }).sections;
  manifest.images = { count: doc.images.length, sha256: createHash("sha256").update(JSON.stringify(doc.images)).digest("hex") };
  const before = usedBytes(b.app, b.p.accountId);
  applyImport(b.app, b.p, stageImport(b.app, b.p, text).token);
  const imported = b.app.db.all<{ url: string; bytes: number }>("SELECT url, bytes FROM item_images").map((r) => r.url);
  assert.equal(imported.length, 1, "one of three was good");
  assert.equal(imageObjects(b.app).n, 1);
  assert.equal(usedBytes(b.app, b.p.accountId) - before >= PNG(300).length, true);
  assert.equal(reconcile(b.app, b.p.accountId).difference, 0);

  // The same file again adds nothing.
  applyImport(b.app, b.p, stageImport(b.app, b.p, text).token);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_images")!.n, 1);
});

const longCover = `https://pictures.example/${"a".repeat(3000)}.png`;

test("an item picture address too long for a job never breaks keeping, a readable copy completing or failing, or lease recovery", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  // A page-less item: keeping it queues its pictures at once. A page of its own: they follow its readable copy.
  const bare = comic(app, p, src, img(1), longCover);
  keepItem(app, p, bare, text);
  assert.equal(app.db.get("SELECT 1 FROM basket_items WHERE item_id = ?", bare) !== undefined, true, "the keep stands");
  assert.deepEqual(jobs(app).map((j) => j.urls), [[url(1)]], "the picture in its text is asked for; the address that is too long is not");

  const done = comic(app, p, src, img(2), longCover, "https://comic.example/done");
  const failing = comic(app, p, src, img(3), longCover, "https://comic.example/failing");
  keepItem(app, p, done, text);
  keepItem(app, p, failing, text);
  const cap = (id: string) => app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", id)!.id;
  const doneCap = cap(done), failingCap = cap(failing);
  app.db.tx(() => completeCapture(app, doneCap, { ok: true, title: "T", text: "word ".repeat(300), html: `<p>${"word ".repeat(300)}</p>`, finalUrl: "https://comic.example/done", bytes: 1600 }));
  app.db.tx(() => failCapture(app, failingCap, "The page couldn't be captured."));
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM captures WHERE id = ?", failingCap)!.status, "failed");

  // The capture job runs out of attempts while other jobs wait in the same recovery pass: the pass goes through whole.
  const pending = comic(app, p, src, img(4), longCover, "https://comic.example/dying");
  keepItem(app, p, pending, text);
  const dying = cap(pending);
  const unrelated = app.db.get<{ id: string }>("SELECT id FROM jobs WHERE kind = 'capture.images'")!.id;
  app.db.run("UPDATE jobs SET status = 'leased', lease_id = 'l', lease_expires_at = '2000-01-01T00:00:00.000Z', attempts = max_attempts WHERE kind = 'capture.fulltext' AND json_extract(payload, '$.captureId') = ?", dying);
  app.db.run("UPDATE jobs SET status = 'leased', lease_id = 'l2', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", unrelated);
  expireLeases(app, (job) => settleFailedJob(app, job, { finalFailure: true }));
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM captures WHERE id = ?", dying)!.status, "failed");
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", unrelated)!.status, "queued", "an unrelated job in the same pass is put back");
});

test("whatever goes wrong queueing pictures, the keep, the copy and the recovery pass stand", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  t.mock.method(console, "error", () => {}); // the failure is logged, which is the point
  app.db.exec("CREATE TRIGGER pictures_fail BEFORE INSERT ON jobs WHEN NEW.kind = 'capture.images' BEGIN SELECT RAISE(ABORT, 'queue is broken'); END");
  const bare = comic(app, p, src, img(1));
  assert.doesNotThrow(() => keepItem(app, p, bare, text));
  assert.ok(app.db.get("SELECT 1 FROM basket_items WHERE item_id = ?", bare), "kept");
  const withPage = comic(app, p, src, img(2), url("cover"), "https://comic.example/p");
  keepItem(app, p, withPage, text);
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", withPage)!.id;
  assert.doesNotThrow(() => app.db.tx(() => failCapture(app, cap, "x")));
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM captures WHERE id = ?", cap)!.status, "failed");
});

test("replacement text from the browser brings the pictures it is missing, also for an item already in the basket", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  const id = comic(app, p, src, "<p>Feed text</p>", url("cover"), "https://comic.example/b");
  keepItem(app, p, id, text);
  assert.deepEqual(jobs(app), [], "the server's own copy is pending: pictures wait for it");
  // The person's browser sends the text it showed, for an item that is already kept.
  const first = saveBrowserCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: id, url: "https://comic.example/b", title: "T", html: `<p>${"word ".repeat(100)}</p>${img("browser-1")}`, text: "word ".repeat(100) });
  assert.equal(first.saved, true);
  assert.deepEqual(jobs(app).map((j) => j.urls), [[url("cover"), url("browser-1")]]);
  // Replacing it with a text that has another picture asks for that one only.
  app.db.tx(() => completeImages(app, { itemId: id, urls: [url("cover"), url("browser-1")] }, delivered([url("cover"), url("browser-1")])));
  saveBrowserCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: id, url: "https://comic.example/b", title: "T", html: `<p>${"word ".repeat(100)}</p>${img("browser-1")}${img("browser-2")}`, text: "word ".repeat(100) });
  assert.deepEqual(jobs(app).at(-1)!.urls, [url("browser-2")]);
});

test("when SQLite ends the caller's whole transaction, asking for pictures does not let the caller carry on outside it", (t) => {
  const { app, p, src, text, cleanup } = setup();
  t.after(cleanup);
  t.mock.method(console, "error", () => {});
  const dying = comic(app, p, src, img(1), url("cover"), "https://comic.example/dying");
  keepItem(app, p, dying, text);
  const capture = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", dying)!.id;
  const other = comic(app, p, src, img(2), null);
  app.db.run("UPDATE jobs SET status = 'leased', lease_id = 'l', lease_expires_at = '2000-01-01T00:00:00.000Z', attempts = max_attempts WHERE kind = 'capture.fulltext'");
  const jobsBefore = app.db.all("SELECT id, status, attempts FROM jobs ORDER BY id");
  // A rollback the database decides on (as when the disk is full or the file can't be written) the moment a picture job is added.
  app.db.exec("CREATE TRIGGER pictures_end_it BEFORE INSERT ON jobs WHEN NEW.kind = 'capture.images' BEGIN SELECT RAISE(ROLLBACK, 'the database ended the transaction'); END");

  // Keeping: the keep is undone with it, and says why, not "no such savepoint".
  assert.throws(() => keepItem(app, p, other, text), /the database ended the transaction/);
  assert.equal(app.db.get("SELECT 1 FROM basket_items WHERE item_id = ?", other), undefined, "nothing of the keep was committed on its own");
  assert.equal(app.db.raw.isTransaction, false);

  // Lease recovery: the whole pass is undone, not just its first statements committed one by one.
  assert.throws(() => expireLeases(app, (job) => settleFailedJob(app, job, { finalFailure: true })), /the database ended the transaction/);
  assert.deepEqual(app.db.all("SELECT id, status, attempts FROM jobs ORDER BY id"), jobsBefore, "every job is as it was");
  assert.equal(app.db.get<{ status: string }>("SELECT status FROM captures WHERE id = ?", capture)!.status, "pending");
  assert.equal(app.db.raw.isTransaction, false);
});
