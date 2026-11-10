import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail, listItems } from "./items.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Long reads", "feed/1");
  return { app, p, cleanup };
}

const versions = (app: ReturnType<typeof setup>["app"], url: string) =>
  app.db.all<{ content_html: string | null; content_omitted: number }>("SELECT v.content_html, v.content_omitted FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.url = ? ORDER BY v.created_at, v.rowid", url);

test("an entry whose full text was too large is stored with its summary and the item says so", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Very long essay", contentHtml: null, summaryHtml: "<p>The start of a very long essay.</p>", contentOmitted: true });
  assert.equal(applySyncBatch(app, p.engineUserId, batch([e])).accepted, 1);
  const item = listItems(app, p, { scope: "all" }).items[0]!;
  assert.equal(item.title, "Very long essay");
  assert.equal(item.url, e.url);
  assert.equal(item.excerpt, "The start of a very long essay.");
  const detail = getItemDetail(app, p, item.id);
  assert.equal(detail.contentOmitted, true);
  assert.match(detail.contentHtml!, /The start of a very long essay/);

  const normal = entry("feed/1", { title: "Short", contentHtml: "<p>All of it.</p>" });
  applySyncBatch(app, p.engineUserId, batch([normal]));
  const short = listItems(app, p, { scope: "all" }).items.find((i) => i.title === "Short")!;
  assert.equal(getItemDetail(app, p, short.id).contentOmitted, false);
});

test("an update whose text is too large does not replace text the item already has", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Grows", contentHtml: "<p>The whole text, as first delivered.</p>" });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = listItems(app, p, { scope: "all" }).items[0]!.id;

  // The same entry comes back too large to send: only its start arrives. Nothing changes.
  const huge = { ...e, contentHtml: null, summaryHtml: "<p>The whole text…</p>", contentOmitted: true };
  assert.equal(applySyncBatch(app, p.engineUserId, batch([huge])).updated, 0);
  assert.equal(versions(app, e.url!).length, 1);
  const detail = getItemDetail(app, p, id);
  assert.equal(detail.contentOmitted, false);
  assert.match(detail.contentHtml!, /The whole text, as first delivered/);

  // Its title is corrected at the same time: the correction applies and the text stays.
  applySyncBatch(app, p.engineUserId, batch([{ ...huge, title: "Grows (corrected)" }]));
  const after = getItemDetail(app, p, id);
  assert.equal(after.title, "Grows (corrected)");
  assert.match(after.contentHtml!, /The whole text, as first delivered/);
  assert.equal(after.contentOmitted, false);
});

test("when a too-large entry later arrives in full, the item gets its text and loses the notice", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const e = entry("feed/1", { title: "Was huge", contentHtml: null, summaryHtml: "<p>Start.</p>", contentOmitted: true });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = listItems(app, p, { scope: "all" }).items[0]!.id;
  assert.equal(getItemDetail(app, p, id).contentOmitted, true);
  applySyncBatch(app, p.engineUserId, batch([{ ...e, contentOmitted: undefined, summaryHtml: null, contentHtml: "<p>Trimmed and complete.</p>" }]));
  const detail = getItemDetail(app, p, id);
  assert.equal(detail.contentOmitted, false);
  assert.match(detail.contentHtml!, /Trimmed and complete/);
  assert.deepEqual(versions(app, e.url!).map((v) => v.content_omitted), [0], "the version with the notice was replaced, not kept");
});
