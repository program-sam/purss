import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { applySyncBatch } from "./sync.ts";
import { VISIBLE_SOURCE, insertItem, listItemIds, listItems, listTuning } from "./items.ts";
import { basketDeletePreview, createBasket, deleteBasket, deleteItemNow } from "./collections.ts";
import { bulk, keepItem, keepWithUndo, unkeepItem } from "./state.ts";
import { patchSource, unfollowSource } from "./sources.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";

/*
 * Lists sorted by when items were kept, and by source, read keys stored with the items (migration 058) instead of working each
 * one out. These tests pin that such a list is, page by page and cursor by cursor, what the keys as they were defined give: the
 * latest keep of the item's memberships ('' when none), and the source's title, char(1) and the item's date; ties go by id.
 */

const DEFINED = {
  kept: { key: "COALESCE((SELECT MAX(b.kept_at) FROM basket_items b WHERE b.item_id = i.id), '')", dir: "DESC" },
  source: { key: "COALESCE(s.title, '') || char(1) || COALESCE(i.published_at, i.discovered_at)", dir: "ASC" },
} as const;
type Sorted = keyof typeof DEFINED;

/** Every item of the list (scope all, every state), in the order the definition gives, with its key. */
function defined(app: App, p: Principal, sort: Sorted, extra = "1"): { id: string; key: string }[] {
  const { key, dir } = DEFINED[sort];
  return app.db.all<{ id: string; key: string }>(
    `SELECT i.id, ${key} AS key FROM items i JOIN item_state st ON st.item_id = i.id LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.workspace_id = ? AND ${VISIBLE_SOURCE} AND ${extra} ORDER BY key ${dir}, i.id ${dir}`, p.workspaceId).map((r) => ({ id: r.id, key: r.key }));
}

/** The list page by page, with the key each page's cursor carries. */
function paged(app: App, p: Principal, query: Parameters<typeof listItems>[2]): { ids: string[]; cursorKeys: string[] } {
  const ids: string[] = [];
  const cursorKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listItems(app, p, { ...query, cursor });
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
    if (cursor) cursorKeys.push((JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as string[])[0]!);
  } while (cursor);
  return { ids, cursorKeys };
}

function assertSorted(app: App, p: Principal, what: string, sourceId?: string): void {
  const drift = app.db.all<{ id: string }>(
    `SELECT i.id FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE i.kept_key IS NOT ${DEFINED.kept.key} OR i.source_title IS NOT COALESCE(s.title, '')`);
  assert.deepEqual(drift, [], `${what}: every stored key is what it stands for`);
  for (const sort of ["kept", "source"] as const) {
    // The whole PURSS, and one source's items (sorted from that source's rows when they are few).
    const lists: [Parameters<typeof listItems>[2], string][] = [[{ scope: "all" }, "1"]];
    if (sourceId) lists.push([{ scope: `source:${sourceId}` }, `i.source_id = '${sourceId}'`], [{ scope: "all", source: sourceId }, `i.source_id = '${sourceId}'`]);
    // Each read both ways: a few sources' items sorted from their rows, and read in order from the PURSS-wide index.
    for (const [query, extra] of lists) for (const below of [listTuning.sortFromRowsBelow, 0]) {
      const was = listTuning.sortFromRowsBelow;
      listTuning.sortFromRowsBelow = below;
      try {
        const how = `${JSON.stringify(query)} sort ${sort}${below ? "" : " (in index order)"}`;
        const want = defined(app, p, sort, extra);
        for (const limit of [1, 3, 50]) {
          const got = paged(app, p, { ...query, filter: "all", sort, limit, muted: "show" });
          assert.deepEqual(got.ids, want.map((r) => r.id), `${what}: ${how}, pages of ${limit}`);
          assert.deepEqual(got.cursorKeys, want.filter((_, i) => (i + 1) % limit === 0 && i + 1 < want.length).map((r) => r.key), `${what}: ${how}, the cursors' keys`);
        }
        assert.deepEqual(listItemIds(app, p, { ...query, filter: "all", sort, muted: "show" }).ids, want.map((r) => r.id), `${what}: Select all of ${how}`);
      } finally { listTuning.sortFromRowsBelow = was; }
    }
  }
}

function looseItem(app: App, p: Principal, title: string, publishedAt: string | null): string {
  return insertItem(app, {
    accountId: p.accountId, workspaceId: p.workspaceId, sourceId: null, kind: "link", title, url: `https://example.org/${newId("x")}`, author: null,
    summaryHtml: null, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null, publishedAt,
    discoveredAt: "2026-10-02T00:00:00.000Z", enclosures: [], fresh: false, reason: "test",
  }).id;
}

test("lists by kept time and by source follow the keys' definitions through every change to them, ties and odd titles included", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: null });
  const other = makeOwner(app, { admin: false });
  // Titles that sort in surprising ways: the same title twice, an empty one (which sorts with items that have no source), a control
  // character right where the key puts its separator, uppercase before lowercase, letters outside ASCII.
  const titles = ["Beta", "Alpha", "Alpha", "", "Alpha\u0001x", "Al", "zebra", "Zebra", "Ärger"];
  const sources = titles.map((title, i) => makeSource(app, p, title, `feed/${i}`));
  makeSource(app, other, "Alpha", "feed/other");
  const same = "2026-10-05T10:00:00.000Z";
  applySyncBatch(app, p.engineUserId, batch(titles.flatMap((_, i) => [
    entry(`feed/${i}`), entry(`feed/${i}`, { publishedAt: same }), entry(`feed/${i}`, { publishedAt: same }), entry(`feed/${i}`, { publishedAt: null }),
  ])));
  applySyncBatch(app, other.engineUserId, batch([entry("feed/other"), entry("feed/other", { publishedAt: same })]));
  looseItem(app, p, "Loose one", same);
  looseItem(app, p, "Loose two", null);
  const ids = app.db.all<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? ORDER BY seq", p.workspaceId).map((r) => r.id);
  assertSorted(app, p, "as synced", sources[1]);

  // Keeps at the same instant (ties go by id), and an item kept again later in another basket.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T09:00:00.000Z") });
  const a = createBasket(app, p, { name: "A", captureMode: "metadata" }).id;
  const b = createBasket(app, p, { name: "B", captureMode: "text" }).id;
  for (const id of ids.slice(0, 12)) keepItem(app, p, id, a);
  t.mock.timers.tick(60_000);
  for (const id of ids.slice(6, 9)) keepWithUndo(app, p, id, b, true);
  t.mock.timers.tick(60_000);
  bulk(app, p, [...ids.slice(12, 18), ids[3]!], { type: "keep", basketId: b });
  assertSorted(app, p, "kept, many at the same time", sources[1]);

  unkeepItem(app, p, ids[7]!, b);
  keepWithUndo(app, p, ids[4]!, a, false);
  bulk(app, p, ids.slice(0, 3), { type: "unkeep", basketId: a });
  assertSorted(app, p, "taken out of baskets", sources[1]);
  deleteBasket(app, p, b, basketDeletePreview(app, p, b).confirmToken);
  assertSorted(app, p, "a basket deleted", sources[1]);
  app.db.tx(() => { deleteItemNow(app, p, ids[5]!); deleteItemNow(app, p, ids[13]!); });
  assertSorted(app, p, "items deleted", sources[1]);
  t.mock.timers.reset();

  patchSource(app, p, sources[0]!, { title: "Alpha" });
  patchSource(app, p, sources[3]!, { title: "Omega" });
  assertSorted(app, p, "sources renamed", sources[0]);
  unfollowSource(app, p, sources[6]!);
  assertSorted(app, p, "a source unfollowed (its kept items stay listed)", sources[6]);
  assert.ok(listItems(app, other, { scope: "all", filter: "all", sort: "source", muted: "show" }).items.every((i) => i.sourceTitle === "Alpha"), "never another PURSS's items");

  // The other writer of items and memberships: an import into a new PURSS.
  const parts: string[] = [];
  await streamExport(app, p, (c) => { parts.push(c); });
  const { app: second, cleanup: cleanupSecond } = makeTestApp();
  t.after(cleanupSecond);
  const q = makeOwner(second, { allocationBytes: null });
  applyImport(second, q, stageImport(second, q, JSON.parse(parts.join(""))).token);
  assert.ok(second.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM basket_items")!.n > 0 && second.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source_title <> ''")!.n > 0, "the import brought kept items and sources");
  assertSorted(second, q, "imported");
});
