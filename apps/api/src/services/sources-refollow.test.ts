import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { Principal } from "../app.ts";
import { createBasket } from "./collections.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { listItems } from "./items.ts";
import { keepItem } from "./state.ts";
import { followSource, unfollowSource } from "./sources.ts";
import { applySyncBatch } from "./sync.ts";
import { reconcile } from "./storage.ts";

const FEED = "https://example.org/feed/1.xml";
const base = { collectionId: null, newCollectionName: null, showOnHome: true, markPrivate: false, fullText: false };

function hold(p: Principal, over: { feedUrl?: string; title?: string } = {}): string {
  const token = newId("dsc");
  holdCandidate(token, p.workspaceId, {
    feedUrl: over.feedUrl ?? FEED, siteUrl: "https://example.org/", title: over.title ?? "Herman's blog", kind: "feed",
    origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null,
  });
  return token;
}

const rows = (app: ReturnType<typeof makeTestApp>["app"], p: Principal) =>
  app.db.all<{ id: string; followed: number }>("SELECT id, followed FROM sources WHERE workspace_id = ? AND feed_url = ?", p.workspaceId, FEED).map((r) => ({ id: r.id, followed: r.followed }));

test("following an unfollowed feed again takes its source and items up again instead of storing a second copy", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "Herman's blog", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1"), entry("feed/1"), entry("feed/1")]));

  unfollowSource(app, p, src);
  assert.equal(listItems(app, p, { scope: "all" }).items.length, 0, "unfollowed items leave the lists");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM items WHERE source_id = ?", src)!.n, 3, "but they are kept");

  const again = followSource(app, p, { ...base, token: hold(p) });
  assert.equal(again.id, src, "the same source");
  assert.deepEqual(rows(app, p), [{ id: src, followed: 1 }], "no second source for the feed");
  assert.equal(listItems(app, p, { scope: `source:${src}` }).items.length, 3, "and its items are back");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM items")!.n, 3, "no second copy");
  const row = app.db.get<{ engine_stream_id: string | null; health: string; paused: number }>("SELECT engine_stream_id, health, paused FROM sources WHERE id = ?", src)!;
  assert.deepEqual([row.engine_stream_id, row.health, row.paused], [null, "pending", 0], "waiting for the engine's new subscription");
  const job = app.db.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe' AND status = 'queued' ORDER BY created_at DESC LIMIT 1")!;
  assert.equal(JSON.parse(job.payload).sourceId, src);
  assert.equal(JSON.parse(job.payload).feedUrl, FEED);

  // Unfollowing with deletion now leaves nothing of the feed behind: there is no ghost copy.
  unfollowSource(app, p, src, { deleteUnkept: true });
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) n FROM items")!.n, 0);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("a re-followed source keeps what was kept, takes the new collection, and a chosen title wins", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "Herman's blog", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "Keeper" }), entry("feed/1", { title: "Other" })]));
  const basket = createBasket(app, p, { name: "Keep", captureMode: "metadata" });
  keepItem(app, p, listItems(app, p, { scope: "all" }).items.find((i) => i.title === "Keeper")!.id, basket.id);
  app.db.run("UPDATE sources SET title = 'My name for it' WHERE id = ?", src);
  unfollowSource(app, p, src);
  const kept = followSource(app, p, { ...base, token: hold(p) });
  assert.equal(kept.title, "My name for it", "a rename made earlier is not lost");
  assert.equal(kept.id, src);
  unfollowSource(app, p, src);
  assert.equal(followSource(app, p, { ...base, token: hold(p), title: "Fresh title" }).title, "Fresh title");
  assert.equal(listItems(app, p, { scope: `basket:${basket.id}` }).total, 1);
});

test("a feed that is still followed is not followed twice, and a different feed or a private link starts its own source", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const src = makeSource(app, p, "Herman's blog", "feed/1");
  assert.equal(followSource(app, p, { ...base, token: hold(p) }).id, src);
  unfollowSource(app, p, src);
  const other = followSource(app, p, { ...base, token: hold(p, { feedUrl: "https://example.org/other.xml" }) });
  assert.notEqual(other.id, src);
  const priv = followSource(app, p, { ...base, token: hold(p), markPrivate: true });
  assert.notEqual(priv.id, src, "a private link never reuses a public source");
});
