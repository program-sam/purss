import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail, listItems } from "./items.ts";
import { completeCapture, failCapture, queueCapture, retryCapture } from "./captures.ts";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  const src = makeSource(app, p, "Sediment Letters", "feed/1");
  return { app, p, src, cleanup };
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("a failed readable copy can be tried again: the new attempt replaces the failed one", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const item = listItems(app, p, { scope: `source:${src}` }).items[0]!;
  queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item.id, url: item.url! });
  const first = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", item.id)!;
  failCapture(app, first.id, "The page couldn't be read.");
  assert.equal(getItemDetail(app, p, item.id).captures.filter((c) => c.level === "failed").length, 1);

  assert.deepEqual(retryCapture(app, p, item.id), { queued: true });
  const caps = getItemDetail(app, p, item.id).captures;
  assert.deepEqual(caps.map((c) => c.level), ["pending"], "the failed attempt is gone, a new one is pending");
  assert.equal(app.db.all("SELECT 1 FROM jobs WHERE kind = 'capture.fulltext' AND status = 'queued'").length, 2, "a new job was queued");
  assert.deepEqual(retryCapture(app, p, item.id), { queued: false }, "nothing more is queued while one is pending");
});

test("trying again needs a failed copy, a page, and an item that is yours", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1", { url: null })]));
  const [a, b] = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items;
  assert.throws(() => retryCapture(app, p, a!.id), (err: unknown) => err instanceof HttpError && err.status === 400, "nothing failed here");
  const cap = (id: string) => app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at) VALUES (?, ?, ?, 'fulltext', 'failed', 'x', ?)", `cap_${id}`, p.workspaceId, id, new Date().toISOString());
  cap(b!.id);
  assert.throws(() => retryCapture(app, p, b!.id), (err: unknown) => err instanceof HttpError && /no page/.test(err.message));
  const other = makeOwner(app, { admin: false });
  assert.throws(() => retryCapture(app, other, a!.id), (err: unknown) => err instanceof HttpError && err.status === 404);
});

test("a readable copy replaces the reading time that followed the feed's summary", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { summaryHtml: `<p>${words(90)}</p>` })]));
  const item = listItems(app, p, { scope: `source:${src}` }).items[0]!;
  assert.equal(item.readMinutes, 1, "90 words of summary read as one minute");
  queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item.id, url: item.url! });
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", item.id)!;
  const text = words(2300);
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "T", text, html: `<p>${text}</p>`, finalUrl: item.url!, bytes: text.length }));
  assert.equal(listItems(app, p, { scope: `source:${src}` }).items[0]!.readMinutes, 10, "2,300 words read as ten minutes");
});

test("a video's length is never replaced by a reading time", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { url: "https://www.youtube.com/watch?v=abc123" })]));
  const item = listItems(app, p, { scope: `source:${src}` }).items[0]!;
  assert.equal(item.kind, "video");
  queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: item.id, url: item.url! });
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", item.id)!;
  const text = words(900);
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "T", text, html: `<p>${text}</p>`, finalUrl: item.url!, bytes: text.length }));
  assert.equal(listItems(app, p, { scope: `source:${src}` }).items[0]!.readMinutes, null);
});

test("an item that arrives without a feed image takes the first picture in its content", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/1", { contentHtml: '<p>Hi</p><img src="https://cdn.example.org/hero.jpg" alt="">', imageUrl: null }),
    entry("feed/1", { contentHtml: '<img src="https://cdn.example.org/inner.jpg">', imageUrl: "https://cdn.example.org/feed-image.jpg" }),
    entry("feed/1", { contentHtml: "<p>No picture.</p>", imageUrl: null }),
  ]));
  const items = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items;
  assert.deepEqual(items.map((i) => i.imageUrl), ["https://cdn.example.org/hero.jpg", "https://cdn.example.org/feed-image.jpg", null]);
});

test("the item detail says when the feed gave only a summary, and stops saying it once the text is captured", (t) => {
  const { app, p, src, cleanup } = setup();
  t.after(cleanup);
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/1", { contentHtml: null }),                                  // a short summary
    entry("feed/1", { contentHtml: `<p>${words(300)}</p>`, summaryHtml: null }), // the whole text in the feed's single content field
    entry("feed/1", { contentHtml: "<p>Just a line.</p>", summaryHtml: null }),  // the engine reports summaries as content too
    entry("feed/1", { contentHtml: null, summaryHtml: null }),               // nothing at all
  ]));
  const [summaryItem, fullItem, shortContent, empty] = listItems(app, p, { scope: `source:${src}`, sort: "oldest" }).items;
  assert.equal(getItemDetail(app, p, summaryItem!.id).summaryOnly, true);
  assert.equal(getItemDetail(app, p, fullItem!.id).summaryOnly, false, "the feed carried the whole text");
  assert.equal(getItemDetail(app, p, shortContent!.id).summaryOnly, true, "short text in the engine's single content field is still a teaser");
  assert.equal(getItemDetail(app, p, empty!.id).summaryOnly, false, "nothing shown is not a summary");
  queueCapture(app, { accountId: p.accountId, workspaceId: p.workspaceId, itemId: summaryItem!.id, url: summaryItem!.url! });
  const cap = app.db.get<{ id: string }>("SELECT id FROM captures WHERE item_id = ?", summaryItem!.id)!;
  app.db.tx(() => completeCapture(app, cap.id, { ok: true, title: "T", text: "The full article", html: "<p>The full article</p>", finalUrl: summaryItem!.url!, bytes: 20 }));
  assert.equal(getItemDetail(app, p, summaryItem!.id).summaryOnly, false);
});

test("over HTTP, a failed copy is retried through the mounted route, and only for its own PURSS", async (t) => {
  const { call, signIn, startTestServer } = await import("../features-testing.ts");
  const { extraRouters } = await import("../routes/index.ts");
  const { app, p, src, cleanup } = setup();
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1")]));
  const item = listItems(app, p, { scope: `source:${src}` }).items[0]!;
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, error, created_at) VALUES ('cap_failed', ?, ?, 'fulltext', 'failed', 'x', ?)", p.workspaceId, item.id, new Date().toISOString());
  const server = await startTestServer(app, extraRouters.api(), extraRouters.pages());
  t.after(async () => { await server.close(); cleanup(); });
  const mine = signIn(app, p.accountId);
  const out = await call(app, server.base, "POST", `/api/items/${item.id}/capture/retry`, mine, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { queued: true });
  assert.deepEqual(getItemDetail(app, p, item.id).captures.map((c) => c.level), ["pending"]);
  const stranger = signIn(app, makeOwner(app, { admin: false }).accountId);
  assert.equal((await call(app, server.base, "POST", `/api/items/${item.id}/capture/retry`, stranger, {})).status, 404);
});
