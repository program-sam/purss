import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";

test("past the candidates looked at, a repeated link is ambiguous: a new post becomes its own item, never taken for another", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: null });
  makeSource(app, p, "Same link", "feed/1");
  const url = "https://example.org/always-the-same";
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: 201 }, (_, i) => entry("feed/1", { url, title: `Post ${i}` }))));
  // The last two lose their mapping, as items an import brought would have none: two candidates, so no unique match.
  const lastTwo = app.db.all<{ id: string }>("SELECT id FROM items WHERE source_id IN (SELECT id FROM sources WHERE workspace_id = ?) ORDER BY rowid DESC LIMIT 2", p.workspaceId);
  for (const { id } of lastTwo) app.db.run("DELETE FROM external_ids WHERE item_id = ?", id);
  const before = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n;
  const result = applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { url, title: "A new post" })]));
  assert.equal(result.accepted, 1, JSON.stringify(result));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, before + 1, "its content is kept as an item of its own");
});
