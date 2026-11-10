import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail, listItems } from "./items.ts";
import { categories, reconcile } from "./storage.ts";
import { completeCapture, failCapture, queueCapture, retryCapture, startCaptureCheck, stepCaptureCheck } from "./captures.ts";
import { runProblemCheck } from "./notifications.ts";
import { compileQuery } from "./items.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { createBasket } from "./collections.ts";
import { keepItem } from "./state.ts";

// Captures shaped like the pages in the persona round: a journal article that came out as its reference list, a news paywall notice and a members-only notice (invented text).
const fixture = (name: string) => readFileSync(new URL(`../../../../packages/connectors/src/fixtures/captures/${name}`, import.meta.url), "utf8");
const esurf = fixture("esurf-references.txt");
const marsactu = fixture("marsactu-paywall.txt");
const kottke = fixture("kottke-members.txt");

type Owner = Principal & { engineUserId: string };

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const src = makeSource(app, p, "Journal", "feed/1");
  return { app, p, src, cleanup };
}

const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} about suspended sediment moving through a catchment in spring, with detail enough to read.`).join("\n\n");

/** An item with the feed's own summary, and a readable copy delivered the way the worker delivers it. */
function capture(app: App, p: Owner, src: string, feedSummary: string, text: string): { itemId: string; captureId: string } {
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { summaryHtml: `<p>${feedSummary}</p>`, contentHtml: null })]));
  const item = listItems(app, p, { scope: `source:${src}`, sort: "newest" }).items[0]!;
  queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item.id, url: item.url! });
  const captureId = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", item.id)!.id;
  app.db.tx(() => completeCapture(app, captureId, { ok: true, title: "T", text, html: text.split("\n\n").map((t) => `<p>${t}</p>`).join(""), finalUrl: item.url!, bytes: text.length }));
  return { itemId: item.id, captureId };
}

test("a capture that is a subscription page is kept but not called the full text: the feed's own text comes first, the capture behind a toggle", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const feed = "Des dizaines de milliers de personnes ont défilé à Marseille, manifestante après manifestante, derrière les banderoles de la CGT.";
  const { itemId, captureId } = capture(app, p, src, feed, marsactu);

  const row = app.db.get<{ status: string; quality: string; partial_reason: string }>("SELECT status, quality, partial_reason FROM captures WHERE id = ?", captureId)!;
  assert.deepEqual({ ...row }, { status: "done", quality: "partial", partial_reason: "gated" });
  const detail = getItemDetail(app, p, itemId);
  const level = detail.captures.find((c) => c.id === captureId)!;
  assert.equal(level.level, "partial");
  assert.doesNotMatch(level.label, /Full text/);
  assert.equal(level.note, "Only part of the page could be saved: it looks like a sign-in, subscription or consent page.");
  assert.match(detail.contentHtml!, /manifestante/, "the reader opens on the feed's own text");
  assert.doesNotMatch(detail.contentHtml!, /Abonnez-vous/);
  assert.equal(detail.partialCopy?.reason, "gated");
  assert.match(detail.partialCopy!.html, /Abonnez-vous/, "the capture is there for the toggle");
  assert.deepEqual(detail.partialCopy!.ref, { kind: "capture", id: captureId });
  assert.deepEqual(detail.contentRef?.kind, "version", "a highlight on the shown text records the feed's version, not the wall");
  assert.equal(detail.captures.some((c) => c.level === "fulltext"), false);
});

test("the three real failures are called partial for their own reasons; a whole article is the full text", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const reasons = (feed: string, text: string) => {
    const { captureId } = capture(app, p, src, feed, text);
    return app.db.get<{ quality: string; partial_reason: string | null }>("SELECT quality, partial_reason FROM captures WHERE id = ?", captureId)!;
  };
  assert.deepEqual({ ...reasons("This study analyzes how the seasonal variability of groundwater input controls suspended sediment dynamics.", esurf) }, { quality: "partial", partial_reason: "references" });
  assert.deepEqual({ ...reasons("Anthropic has new rules for its Opus 5.5 model.", kottke) }, { quality: "partial", partial_reason: "gated" });
  assert.deepEqual({ ...reasons("A short summary of the article.", paragraphs(20)) }, { quality: "full", partial_reason: null });
  // Shorter than the feed's own text.
  assert.deepEqual({ ...reasons(`${paragraphs(12).replace(/\n\n/g, " ")}`, paragraphs(3)) }, { quality: "partial", partial_reason: "short" });
});

test("a full capture is the article: shown first, labelled so, and it sets the reading time and the search", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} describes the erosion of a river bank near Marseille in careful, readable words and more words.`).join("\n\n");
  const { itemId } = capture(app, p, src, "A summary.", text);
  const detail = getItemDetail(app, p, itemId);
  assert.equal(detail.captures.at(-1)!.level, "fulltext");
  assert.equal(detail.captures.at(-1)!.label, "Full text captured");
  assert.match(detail.contentHtml!, /erosion of a river bank/);
  assert.equal(detail.partialCopy, null);
  assert.ok(detail.readMinutes && detail.readMinutes >= 2, "reading time follows the article");
  assert.equal(listItems(app, p, { scope: `source:${src}`, q: "erosion" }).items.length, 1);
});

test("a partial capture does not set the reading time or pollute search, and does not count as full text in a filter", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const { itemId } = capture(app, p, src, "Groundwater and sediment in a Mediterranean catchment.", esurf);
  const item = listItems(app, p, { scope: `source:${src}` }).items.find((i) => i.id === itemId)!;
  assert.equal(item.readMinutes, null, "the reference list is not 20 minutes of reading");
  assert.equal(listItems(app, p, { scope: `source:${src}`, q: "Valyrakis" }).items.length, 0, "an author in the reference list does not find the paper");
  assert.equal(listItems(app, p, { scope: `source:${src}`, q: "groundwater" }).items.length, 1, "its own text still does");

  const params: never[] = [];
  const where = compileQuery({ field: "capture", value: ["fulltext"] }, params, p.workspaceId);
  assert.equal(app.db.get(`SELECT 1 FROM items i WHERE i.id = ? AND ${where}`, itemId), undefined, "not the full text");
  // It is still stored, and counted: nothing is dropped silently.
  assert.ok(categories(app, p.accountId).feed > esurf.length / 2);
});

test("copies saved before the check are checked at start-up, and a fresh database has nothing to check", async (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const { captureId: wall } = capture(app, p, src, "Feed text about a march in Marseille that is long enough to count as the feed's own words here.", marsactu);
  const { captureId: good, itemId } = capture(app, p, src, "A summary.", paragraphs(30));
  // As they were before captures were checked.
  app.db.run("UPDATE captures SET quality = NULL, partial_reason = NULL");
  assert.equal(getItemDetail(app, p, itemId).captures.at(-1)!.level, "fulltext");

  await startCaptureCheck(app);
  const states = (id: string) => ({ ...app.db.get<{ quality: string; partial_reason: string | null }>("SELECT quality, partial_reason FROM captures WHERE id = ?", id)! });
  assert.deepEqual(states(wall), { quality: "partial", partial_reason: "gated" });
  assert.deepEqual(states(good), { quality: "full", partial_reason: null });
  assert.equal(stepCaptureCheck(app), true, "nothing left to check");
  // A browser capture is the person's own browser's text, not checked.
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, text, html, created_at) VALUES ('cap_b', ?, ?, 'browser', 'done', 'x', '<p>x</p>', ?)", p.workspaceId, itemId, new Date().toISOString());
  assert.equal(stepCaptureCheck(app), true);
  assert.equal(app.db.get<{ quality: string | null }>("SELECT quality FROM captures WHERE id = 'cap_b'")!.quality, null);
});

test("the verdict travels in an export and is restored on import, with the search it earns", async (t) => {
  const a = makeTestApp();
  const b = makeTestApp();
  t.after(() => { a.cleanup(); b.cleanup(); });
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app);
  const src = makeSource(a.app, pa, "Journal", "feed/1");
  const { captureId } = capture(a.app, pa, src, "Groundwater and sediment in a Mediterranean catchment.", esurf);
  capture(a.app, pa, src, "A summary.", paragraphs(30));

  const parts: string[] = [];
  await streamExport(a.app, pa, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));
  const exported = doc.items.flatMap((i: { captures: { id: string; quality: string | null; partialReason: string | null }[] }) => i.captures);
  assert.deepEqual(exported.map((c: { quality: string | null; partialReason: string | null }) => [c.quality, c.partialReason]).sort(), [["full", null], ["partial", "references"]]);
  assert.ok(exported.some((c: { id: string }) => c.id === captureId));

  applyImport(b.app, pb, stageImport(b.app, pb, doc).token);
  const rows = b.app.db.all<{ quality: string; partial_reason: string | null }>("SELECT quality, partial_reason FROM captures ORDER BY quality");
  assert.deepEqual(rows.map((r) => [r.quality, r.partial_reason]), [["full", null], ["partial", "references"]]);
  assert.equal(listItems(b.app, pb, { scope: "all", q: "Valyrakis" }).items.length, 0, "the reference list is not searchable after import either");
  assert.equal(listItems(b.app, pb, { scope: "all", q: "groundwater" }).items.length, 1);
});

test("a copy that is only part of the page can be tried again; the new copy replaces it, and a failed try leaves it", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const { itemId, captureId } = capture(app, p, src, "Des dizaines de milliers de personnes ont défilé à Marseille, manifestante après manifestante, derrière la CGT.", marsactu);
  assert.equal(app.db.get<{ quality: string }>("SELECT quality FROM captures WHERE id = ?", captureId)!.quality, "partial");
  const used = () => app.db.get<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM stored_objects WHERE kind = 'capture' AND released_at IS NULL")!.n;
  const wallBytes = used();
  assert.ok(wallBytes > 0);

  assert.deepEqual(retryCapture(app, p, itemId), { queued: true }, "an incomplete copy can be tried again");
  assert.deepEqual(retryCapture(app, p, itemId), { queued: false }, "and not twice at once");
  assert.equal(getItemDetail(app, p, itemId).partialCopy?.reason, "gated", "until the new copy arrives, the earlier one is still there");
  // The second try fails: the earlier partial copy stays, and says so.
  const first = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", itemId)!.id;
  app.db.tx(() => failCapture(app, first, "The page couldn't be captured."));
  assert.deepEqual(getItemDetail(app, p, itemId).captures.map((c) => c.level).sort(), ["failed", "partial"]);
  assert.equal(getItemDetail(app, p, itemId).partialCopy?.reason, "gated");

  // Tried again, and this time the page gives its text: the whole article replaces the wall, and its storage with it.
  assert.deepEqual(retryCapture(app, p, itemId), { queued: true });
  const second = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", itemId)!.id;
  assert.equal(app.db.get("SELECT 1 FROM captures WHERE status = 'failed'"), undefined, "the failed try was replaced by this one");
  const article = paragraphs(30);
  app.db.tx(() => completeCapture(app, second, { ok: true, title: "T", text: article, html: article.split("\n\n").map((x) => `<p>${x}</p>`).join(""), finalUrl: "https://example.org/a", bytes: article.length }));
  const detail = getItemDetail(app, p, itemId);
  assert.deepEqual(detail.captures.map((c) => c.level), ["fulltext"], "one copy, the full text");
  assert.equal(detail.partialCopy, null);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE item_id = ?", itemId)!.n, 1);
  assert.equal(used() > 0 && app.db.get("SELECT 1 FROM stored_objects WHERE kind = 'capture' AND ref_id = ? AND released_at IS NULL", captureId) === undefined, true, "the wall's bytes are released");
  assert.equal(reconcile(app, p.accountId).difference, 0);
  assert.deepEqual(retryCapture(app, p, itemId), { queued: false }, "a full copy is not retried");
});

test("a retry that is partial again replaces the earlier partial copy instead of piling up", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const { itemId } = capture(app, p, src, "A feed text.", kottke);
  retryCapture(app, p, itemId);
  const pending = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", itemId)!.id;
  app.db.tx(() => completeCapture(app, pending, { ok: true, title: "T", text: kottke, html: `<p>${kottke}</p>`, finalUrl: "https://example.org/a", bytes: kottke.length }));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE item_id = ? AND status = 'done'", itemId)!.n, 1, "one copy, not two");
  assert.equal(getItemDetail(app, p, itemId).partialCopy?.reason, "gated");
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

/** An item whose copy is only part of the page, with a page of its own; returns the item and the partial copy. */
function partialCopyOf(app: App, p: Principal & { engineUserId: string }, src: string, feed: string, text: string) {
  return capture(app, p, src, feed, text);
}
const reservations = (app: App) => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reservations WHERE released_at IS NULL AND settled_at IS NULL")!.n;
const copies = (app: App, itemId: string) => app.db.all<{ id: string; status: string; quality: string | null }>("SELECT id, status, quality FROM captures WHERE item_id = ? ORDER BY created_at", itemId).map((c) => ({ ...c }));
const deliver = (app: App, itemId: string, text: string) => {
  const id = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ? AND status = 'pending'", itemId)!.id;
  app.db.tx(() => completeCapture(app, id, { ok: true, title: "T", text, html: text.split("\n\n").map((x) => `<p>${x}</p>`).join(""), finalUrl: "https://example.org/a", bytes: text.length }));
};
const COOKIE_WALL = "Checking your browser before accessing the site.";
const FEED_TEXT = `${"The feed's own text of the article, which is long enough to be a real summary of it. ".repeat(40)}`;

test("an item that already has a copy, even a partial one, is not fetched again by keeping it into another basket", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const text = createBasket(app, p, { name: "One", captureMode: "text" }).id;
  const second = createBasket(app, p, { name: "Two", captureMode: "text" }).id;
  const { itemId, captureId } = partialCopyOf(app, p, src, "Groundwater and sediment in a Mediterranean catchment.", esurf);
  const before = { copies: copies(app, itemId), reserved: reservations(app), jobs: app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'capture.fulltext' AND status = 'queued'")!.n };
  const keepOutcome = keepItem(app, p, itemId, text);
  keepItem(app, p, itemId, second);
  assert.equal(keepOutcome.captureQueued, false);
  assert.deepEqual(copies(app, itemId), before.copies, "the copy it has stays, and nothing is added next to it");
  assert.equal(reservations(app), before.reserved, "no room is held for a fetch that is not made");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'capture.fulltext' AND status = 'queued'")!.n, before.jobs);
  assert.equal(getItemDetail(app, p, itemId).partialCopy?.reason, "references");
  assert.equal(app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", itemId)!.id, captureId);
});

test("Try again keeps the copy it has unless the new one is better: full beats partial, and among partials the longer body stays", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  // A 'short' partial copy of about a thousand characters, against a long feed text.
  const middling = paragraphs(11);
  const { itemId, captureId } = partialCopyOf(app, p, src, FEED_TEXT, middling);
  assert.equal(app.db.get<{ partial_reason: string }>("SELECT partial_reason FROM captures WHERE id = ?", captureId)!.partial_reason, "short");
  const room = reservations(app);

  // A worse page (a cookie wall of 47 characters) comes back: the earlier copy stays, nothing is left pending or failed.
  assert.deepEqual(retryCapture(app, p, itemId), { queued: true });
  deliver(app, itemId, COOKIE_WALL);
  assert.deepEqual(doneCopies(app, itemId).map((c) => c.id), [captureId], "the earlier copy, alone");
  assert.equal(reservations(app), room, "the try's room is given back");
  assert.equal(getItemDetail(app, p, itemId).partialCopy!.html.includes("Paragraph 10"), true);
  assert.equal(reconcile(app, p.accountId).difference, 0);

  // The same length is not better.
  retryCapture(app, p, itemId);
  deliver(app, itemId, middling);
  assert.deepEqual(doneCopies(app, itemId).map((c) => c.id), [captureId]);

  // A longer partial copy replaces it, and the earlier one's storage goes.
  retryCapture(app, p, itemId);
  const longer = paragraphs(16);
  deliver(app, itemId, longer);
  const now = doneCopies(app, itemId);
  assert.equal(now.length, 1);
  assert.notEqual(now[0]!.id, captureId);
  assert.equal(now[0]!.quality, "partial");
  assert.equal(getItemDetail(app, p, itemId).partialCopy!.html.includes("Paragraph 15"), true);
  assert.equal(app.db.get("SELECT 1 FROM stored_objects WHERE kind = 'capture' AND ref_id = ? AND released_at IS NULL", captureId), undefined);

  // A whole article beats any partial copy.
  retryCapture(app, p, itemId);
  deliver(app, itemId, paragraphs(40));
  assert.deepEqual(copies(app, itemId).map((c) => c.quality), ["full"]);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

/** A wall that is longer than an article fragment: the same call to subscribe, over and over. */
const LONG_WALL = Array.from({ length: 18 }, () => "Subscribe to continue reading this story.\n\nAlready a subscriber? Sign in to read the full article.").join("\n\n");
const reasonOf = (app: App, id: string) => app.db.get<{ partial_reason: string | null }>("SELECT partial_reason FROM captures WHERE id = ?", id)!.partial_reason;
const doneCopies = (app: App, itemId: string) => copies(app, itemId).filter((c) => c.status === "done");

test("real text is never replaced by a wall, however long the wall is: the reason ranks before the length", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const fragment = paragraphs(10); // about 1,100 characters of the article, against a long feed text: 'short'
  const { itemId, captureId } = partialCopyOf(app, p, src, FEED_TEXT, fragment);
  assert.equal(reasonOf(app, captureId), "short");
  assert.ok(LONG_WALL.length > fragment.length + 300, `a wall of ${LONG_WALL.length} characters against ${fragment.length}`);

  retryCapture(app, p, itemId);
  deliver(app, itemId, LONG_WALL);
  assert.deepEqual(doneCopies(app, itemId).map((c) => c.id), [captureId], "the article fragment stays");
  assert.equal(getItemDetail(app, p, itemId).partialCopy!.html.includes("Paragraph 9"), true);

  // A reference list is not the article either, but it is page content: it does not replace an article fragment, and a wall does not replace it.
  const refs = Array.from({ length: 12 }, (_, i) => `Author${i}, A. B. and Other, C.: A study of rivers number ${i}, Earth Surf. Dynam., 10, 81–96, https://doi.org/10.5194/esurf-10-${i}-2022, 2022.`).join("\n\n");
  retryCapture(app, p, itemId);
  deliver(app, itemId, refs);
  assert.deepEqual(doneCopies(app, itemId).map((c) => c.id), [captureId], "a bibliography does not replace the article fragment");

  // The other way: a fragment replaces a wall even when it is shorter, and a longer wall replaces a shorter one (same reason, longer).
  const wallItem = partialCopyOf(app, p, src, FEED_TEXT, "Subscribe to continue reading. Already a subscriber? Sign in.");
  assert.equal(reasonOf(app, wallItem.captureId), "gated");
  retryCapture(app, p, wallItem.itemId);
  deliver(app, wallItem.itemId, LONG_WALL);
  assert.equal(doneCopies(app, wallItem.itemId).length, 1);
  assert.notEqual(doneCopies(app, wallItem.itemId)[0]!.id, wallItem.captureId, "longer wall over shorter wall");
  retryCapture(app, p, wallItem.itemId);
  deliver(app, wallItem.itemId, paragraphs(3));
  const now = doneCopies(app, wallItem.itemId);
  assert.equal(now.length, 1);
  assert.equal(reasonOf(app, now[0]!.id), "short", "a fragment of the article over any wall");
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("a try that is no better is recorded, so the item is still listed and told about, and the panel says what happened", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  const fragment = paragraphs(10);
  const { itemId, captureId } = partialCopyOf(app, p, src, FEED_TEXT, fragment);
  const room = reservations(app);
  retryCapture(app, p, itemId);
  deliver(app, itemId, LONG_WALL);

  assert.deepEqual(doneCopies(app, itemId).map((c) => c.id), [captureId], "the copy it had stays");
  assert.equal(reservations(app), room, "the room held for the try is given back");
  const detail = getItemDetail(app, p, itemId);
  const tried = detail.captures.find((c) => c.level === "failed")!;
  assert.equal(tried.label, "Tried again, nothing better");
  assert.match(tried.note!, /^The page still gave only part of its text: it looks like a sign-in, subscription or consent page\. The copy saved earlier stays\.$/);
  assert.equal(detail.partialCopy?.reason, "short", "the copy it had is still what the toggle shows");
  assert.deepEqual(listItems(app, p, { scope: `source:${src}`, capture: "failed" }).items.map((i) => i.id), [itemId], "still listed as failed to improve");
  runProblemCheck(app, p.workspaceId, p.accountId, new Date(Date.now() + 1000));
  assert.equal(app.db.all("SELECT 1 FROM notifications WHERE title LIKE 'Couldn''t save the text of 1 item%'").length, 1, "and told about");

  // Trying again once more replaces that record with the new attempt, and a better page ends it.
  assert.deepEqual(retryCapture(app, p, itemId), { queued: true });
  assert.equal(app.db.get("SELECT 1 FROM captures WHERE item_id = ? AND status = 'failed'", itemId), undefined);
  deliver(app, itemId, paragraphs(40));
  assert.deepEqual(copies(app, itemId).map((c) => c.quality), ["full"]);
  assert.deepEqual(listItems(app, p, { scope: `source:${src}`, capture: "failed" }).items, []);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});
