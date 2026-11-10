import { holdCandidate } from "./discovery-cache.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { newId } from "@purss/domain";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { PRIVATE_FEED_URL, PRIVATE_ITEM_URL, seedLibrary, shareRow } from "../features-testing.ts";
import { applySyncBatch } from "./sync.ts";
import { getItem, listItems } from "./items.ts";
import { createBasket, createCollection } from "./collections.ts";
import { changeState } from "./state.ts";
import { reconcile, usedBytes } from "./storage.ts";
import { applyImport, reconnectSource, stageImport, streamExport } from "./portability.ts";
import { OPTIONAL_SECTION_NAMES, parseArchive, SECTION_NAMES, sha256Hex } from "./archive-format.ts";
import { setShareNote } from "./shares.ts";
import { HttpError } from "../http.ts";
import { deleteAnnotation, putAnnotation } from "./annotations.ts";
import { setItemReminder } from "./item-reminders.ts";

type Owner = Principal & { engineUserId: string };

async function exportDoc(app: App, p: Principal): Promise<{ text: string; doc: any; chunks: number }> {
  const parts: string[] = [];
  await streamExport(app, p, (c) => { parts.push(c); });
  const text = parts.join("");
  return { text, doc: JSON.parse(text), chunks: parts.length };
}

/** Recompute the manifest after a test edits a section, as a hostile or foreign producer could. */
function rebuild(doc: any): any {
  const sections: Record<string, { count: number; sha256: string }> = {};
  for (const n of [...SECTION_NAMES, ...OPTIONAL_SECTION_NAMES]) if (doc[n] !== undefined) sections[n] = { count: Array.isArray(doc[n]) ? doc[n].length : 1, sha256: sha256Hex(JSON.stringify(doc[n])) };
  return { ...doc, manifest: { algorithm: "sha256", sections } };
}

function twoWorkspaces(allocationB: number | null = null) {
  const a = makeTestApp();
  const b = makeTestApp();
  const pa = makeOwner(a.app);
  const pb = makeOwner(b.app, { allocationBytes: allocationB });
  return { a: a.app, b: b.app, pa, pb, cleanup: () => { a.cleanup(); b.cleanup(); } };
}

const count = (app: App, table: string) => app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

/** Every live version's current-version flag agrees with the items (the storage summary reads it). */
function assertFlags(app: App): void {
  const wrong = app.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stored_objects o WHERE o.kind = 'item_version' AND o.released_at IS NULL
       AND o.is_current <> EXISTS (SELECT 1 FROM items i WHERE i.current_version_id = o.ref_id)`)!.n;
  assert.equal(wrong, 0, "current-version flags agree with the items");
}

test("export holds no secrets, no private addresses and no engine identifiers", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const lib = seedLibrary(app, p);
  // A public item whose address carries a credential, and sign-in material that must never leave.
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "Token link", url: "https://example.org/post?token=ABCDEF123456" })]));
  app.db.run("INSERT INTO sign_in_methods (id, account_id, kind, label, secret_hash, created_at) VALUES (?, ?, 'recovery', 'abcd', 'SALT$HASHVALUE', ?)", newId("sim"), p.accountId, new Date().toISOString());
  const { text, doc } = await exportDoc(app, p);

  for (const forbidden of [PRIVATE_FEED_URL, "SUPERSECRETTOKEN123", PRIVATE_ITEM_URL, "ITEMSECRET456", "feeds.example", "test-token", "SALT$HASHVALUE", "ABCDEF123456",
    "tag:google.com", '"feed/1"', '"feed/2"', p.accountId, p.workspaceId, p.engineUserId, "engine_stream", "secret_hash", "csrf"]) {
    assert.ok(!text.includes(forbidden), `export must not contain ${forbidden}`);
  }
  parseArchive(doc); // manifest, counts and hashes verify
  assert.equal(doc.format, "purss-workspace-export");
  assert.equal(doc.schemaVersion, 1);
  assert.ok(!("savedQueries" in doc), "saved searches no longer exist, so an export has no section for them");
  assert.ok(doc.omitted.length >= 5 && doc.omitted.some((o: string) => /private source/i.test(o)), "an omitted section explains the exclusions");

  const priv = doc.sources.find((s: any) => s.id === lib.privateSource);
  assert.deepEqual([priv.isPrivate, priv.reconnectRequired, priv.feedUrl, priv.siteUrl, priv.kind], [true, true, null, null, "private"]);
  const pub = doc.sources.find((s: any) => s.id === lib.publicSource);
  assert.equal(pub.feedUrl, "https://example.org/feed/1.xml");
  assert.equal(pub.reconnectRequired, false);

  const privateItem = doc.items.find((i: any) => i.id === lib.privateItemId);
  assert.equal(privateItem.url, null);
  assert.equal(privateItem.urlRedacted, true);
  assert.deepEqual(privateItem.enclosures, []);
  assert.deepEqual(privateItem.originalGuids, []);
  assert.ok(!JSON.stringify(privateItem).includes("href"), "links inside a private item's text are dropped");
  assert.ok(privateItem.versions[0].summaryHtml.includes("this"), "its words are still there");
  const tokenItem = doc.items.find((i: any) => i.title === "Token link");
  assert.deepEqual([tokenItem.url, tokenItem.urlRedacted], [null, true]);

  // The kept (old) version and the current corrected version are both there, with the capture and the pins.
  const tidal = doc.items.find((i: any) => i.id === lib.pinnedOld.itemId);
  assert.deepEqual(tidal.versions.map((v: any) => v.title), ["Tidal flats and sediment", "Tidal flats (corrected)"]);
  assert.equal(tidal.captures[0].text, "Captured readable text about sediment.");
  assert.equal(doc.memberships.length, 3);
  assert.equal(doc.baskets.length, 2);
});

test("export is a streamed snapshot, works over quota, and never touches the storage ledger", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Many", "feed/1");
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: 300 }, (_, i) => entry("feed/1", { title: `Post ${i}`, summaryHtml: `<p>${"words ".repeat(120)}</p>` }))));
  app.db.run("UPDATE storage_accounts SET allocation_bytes = 10 WHERE account_id = ?", p.accountId); // far over quota
  const before = { used: usedBytes(app, p.accountId), events: count(app, "usage_events"), paused: app.db.get("SELECT paused_reason FROM storage_accounts")!.paused_reason };
  const { doc, chunks } = await exportDoc(app, p);
  assert.ok(chunks > 3, "written in pieces, not as one string");
  assert.equal(parseArchive(doc).items.length, 300);
  assert.deepEqual({ used: usedBytes(app, p.accountId), events: count(app, "usage_events"), paused: app.db.get("SELECT paused_reason FROM storage_accounts")!.paused_reason }, before);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("a second export at the same time is refused instead of doubling the load", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "S", "feed/1");
  applySyncBatch(app, p.engineUserId, batch(Array.from({ length: 50 }, () => entry("feed/1"))));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const first = streamExport(app, p, async () => { await gate; });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(streamExport(app, p, () => {}), (e: unknown) => e instanceof HttpError && e.status === 429);
  release();
  await first;
  await streamExport(app, p, () => {}); // free again
});

test("an archive that still gives sources a share of Home imports, without it", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  seedLibrary(app, p);
  const { doc } = await exportDoc(app, p);
  const old = structuredClone(doc);
  old.sources[0].homeShare = "own";
  const parsed = parseArchive(rebuild(old)).sources[0]!;
  assert.equal(parsed.id, doc.sources[0].id);
  assert.ok(!("homeShare" in parsed));
});

test("damaged, cut-short, foreign and newer archives are rejected with plain messages", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  seedLibrary(app, p);
  const { doc, text } = await exportDoc(app, p);
  const edited = structuredClone(doc);
  edited.items[0].title = "Edited after export";
  assert.throws(() => parseArchive(edited), /damaged/);
  const noManifest = structuredClone(doc);
  delete noManifest.manifest;
  assert.throws(() => parseArchive(noManifest), /incomplete/);
  assert.throws(() => parseArchive({ ...doc, schemaVersion: 2 }), /newer version/);
  assert.throws(() => parseArchive({ ...doc, format: "something-else" }), /isn't a PURSS export/);
  assert.throws(() => parseArchive(null), /isn't a PURSS export/);
  assert.throws(() => JSON.parse(text.slice(0, text.length - 20)));
  const { app: other, cleanup: c2 } = makeTestApp();
  t.after(c2);
  const po = makeOwner(other);
  assert.throws(() => stageImport(other, po, edited), (e: unknown) => e instanceof HttpError && e.status === 400 && /damaged/.test(e.message));
});

test("import round trip into a fresh PURSS keeps everything, including kept versions and captures", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  const lib = seedLibrary(a, pa);
  changeState(a, pa, lib.pinnedOld.itemId, { workflow: "toread", progress: 0.5, expectedRevision: 0 });
  createCollection(a, pa, { name: "Letters", emoji: "✉️", mode: "sources", sourceIds: [lib.publicSource], query: null, view: "cards" });
  createCollection(a, pa, { name: "Reading filter", emoji: null, mode: "query", sourceIds: [], query: { all: [{ field: "basket", value: [lib.baskets.reading] }, { field: "source", value: [lib.publicSource] }] }, view: "list" });
  const shareId = shareRow(a, pa, "basket", lib.baskets.reading, "published", "Sam Q.");
  a.db.run("UPDATE shares SET listed = 1, description = 'good ones' WHERE id = ?", shareId);
  const noted = a.db.get<{ item_id: string }>(`SELECT b.item_id FROM basket_items b JOIN items i ON i.id = b.item_id JOIN sources s ON s.id = i.source_id
    WHERE b.basket_id = ? AND s.is_private = 0 ORDER BY b.item_id LIMIT 1`, lib.baskets.reading)!.item_id;
  setShareNote(a, pa, shareId, noted, "Worth it for the maps.");
  const { doc } = await exportDoc(a, pa);

  const before = usedBytes(b, pb.accountId);
  const preview = stageImport(b, pb, doc);
  assert.equal(preview.fits, true);
  assert.equal(preview.counts.items, 4);
  assert.equal(preview.counts.newItems, 4);
  assert.equal(preview.counts.keptItems, 3);
  assert.equal(preview.counts.sourcesToFollow, 1);
  assert.equal(preview.counts.sourcesToReconnect, 1);
  assert.ok(preview.omitted.length > 0);
  assert.equal(count(b, "items"), 0, "previewing writes nothing");

  const result = applyImport(b, pb, preview.token);
  assert.equal(result.created.items, 4);
  assert.equal(result.created.keptPins, 3);
  assert.equal(result.following, 1);
  assert.equal(result.reconnectRequired, 1);
  assert.equal(usedBytes(b, pb.accountId) - before, preview.requiredBytes, "the preview's size estimate is exactly what was admitted");
  assert.equal(reconcile(b, pb.accountId).difference, 0, "usage ledger agrees with the owned objects");
  assertFlags(b);


  // Counts match the original.
  for (const table of ["items", "item_versions", "baskets", "basket_items", "captures", "collections", "item_state"]) {
    assert.equal(count(b, table), count(a, table), `${table} count`);
  }
  // New identifiers, not the archive's.
  assert.equal(b.db.get("SELECT 1 FROM items WHERE id IN (?, ?)", lib.itemIds[0]!, lib.itemIds[1]!), undefined);

  // Kept versions are preserved: the pin points at the old text while the item shows the corrected one.
  const item = b.db.get<{ id: string; title: string }>("SELECT id, title FROM items WHERE title = 'Tidal flats (corrected)'")!;
  const pinned = b.db.get<{ title: string; content_html: string }>("SELECT v.title, v.content_html FROM basket_items bi JOIN item_versions v ON v.id = bi.version_id WHERE bi.item_id = ?", item.id)!;
  assert.equal(pinned.title, "Tidal flats and sediment");
  assert.ok(pinned.content_html.includes("transport"));
  assert.equal(b.db.get<{ text: string }>("SELECT text FROM captures WHERE item_id = ?", item.id)!.text, "Captured readable text about sediment.");
  assert.equal(listItems(b, pb, { scope: "all", filter: "all", q: "readable sediment" }).items[0]?.id, item.id, "captured text is searchable");

  // Workflow and progress came across; the private item has no address.
  const state = b.db.get<{ workflow: string; progress: number }>("SELECT workflow, progress FROM item_state WHERE item_id = ?", item.id)!;
  assert.deepEqual([state.workflow, state.progress], ["toread", 0.5]);
  const privateItem = b.db.get<{ url: string | null }>("SELECT url FROM items WHERE title = 'Private note'")!;
  assert.equal(privateItem.url, null);

  // Sources: the public one is followed through the normal job; the private one waits for the owner.
  const subs = b.db.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe'");
  assert.equal(subs.length, 1);
  assert.equal(JSON.parse(subs[0]!.payload).feedUrl, "https://example.org/feed/1.xml");
  assert.equal(JSON.parse(subs[0]!.payload).engineUserId, pb.engineUserId);
  const privSource = b.db.get<{ id: string; feed_url: string | null; paused: number; health: string; health_text: string; is_private: number }>("SELECT * FROM sources WHERE title = 'Secret Garden'")!;
  assert.deepEqual([privSource.feed_url, privSource.paused, privSource.health, privSource.is_private], [null, 1, "reconnect", 1]);
  assert.match(privSource.health_text, /Reconnect required/);
  const pubSource = b.db.get<{ health: string; engine_stream_id: string | null }>("SELECT health, engine_stream_id FROM sources WHERE title = 'Sediment Letters'")!;
  assert.deepEqual([pubSource.health, pubSource.engine_stream_id], ["pending", null]);

  // Filter collections point at the new identifiers.
  const readingB = b.db.get<{ id: string }>("SELECT id FROM baskets WHERE name = 'Reading'")!.id;
  const publicB = b.db.get<{ id: string }>("SELECT id FROM sources WHERE title = 'Sediment Letters'")!.id;
  assert.deepEqual(JSON.parse(b.db.get<{ query: string }>("SELECT query FROM collections WHERE name = 'Reading filter'")!.query), { all: [{ field: "basket", value: [readingB] }, { field: "source", value: [publicB] }] });
  assert.equal(b.db.all("SELECT 1 FROM collection_sources cs JOIN collections c ON c.id = cs.collection_id WHERE c.name = 'Letters'").length, 1);

  // Sharing settings come back switched off, on the matching basket, with a fresh address; nothing is shared.
  const shareB = b.db.get<{ status: string; slug: string; listed: number; target_id: string; curator_name: string; description: string }>("SELECT * FROM shares")!;
  assert.equal(shareB.status, "draft");
  assert.equal(shareB.target_id, readingB);
  assert.deepEqual([shareB.curator_name, shareB.description, shareB.listed], ["Sam Q.", "good ones", 1], "the settings travel, and are shown again in the review before sharing");
  assert.notEqual(shareB.slug, a.db.get<{ slug: string }>("SELECT slug FROM shares")!.slug);
  assert.equal(b.db.get<{ note: string }>("SELECT note FROM share_notes")!.note, "Worth it for the maps.", "public notes travel");

  // The staged file is gone after a successful import.
  assert.equal(count(b, "import_stages"), 0);
  assert.deepEqual(existsSync(path.join(b.config.dataDir, "staging")) ? readdirSync(path.join(b.config.dataDir, "staging")) : [], []);

  // Importing the same file again adds nothing.
  const again = stageImport(b, pb, doc);
  assert.equal(again.counts.newItems, 0);
  assert.equal(again.counts.existingItems, 4);
  assert.equal(again.requiredBytes, 0);
  const usedAfterFirst = usedBytes(b, pb.accountId);
  const second = applyImport(b, pb, again.token);
  assert.equal(second.created.items, 0);
  assert.equal(second.created.keptPins, 0);
  assert.equal(second.created.sources, 0);
  assert.equal(second.created.baskets, 0);
  assert.equal(second.following, 0);
  assert.equal(usedBytes(b, pb.accountId), usedAfterFirst);
  assert.equal(count(b, "items"), 4);
  assert.equal(count(b, "sources"), 2);
  assert.equal(count(b, "baskets"), 2);
  assert.equal(count(b, "basket_items"), 3);
  assert.equal(count(b, "collections"), 2);
  assert.equal(count(b, "shares"), 1, "a basket that already has sharing settings keeps them");
  assert.equal(b.db.all("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe'").length, 1);
});

test("an older export with hand-picked collections imports without them, says so, and keeps everything else", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  const lib = seedLibrary(a, pa);
  createCollection(a, pa, { name: "Letters", emoji: null, mode: "sources", sourceIds: [lib.publicSource], query: null, view: "list" });
  const { doc } = await exportDoc(a, pa);
  assert.ok(doc.collections.every((c: any) => c.mode !== "manual" && !("itemIds" in c)), "an export only holds source and filter collections");

  // The shape a file had when hand-picked collections existed: two of them, holding item ids.
  const legacy = rebuild({
    ...doc,
    collections: [
      ...doc.collections,
      { id: "col_old1", name: "Picks", emoji: null, mode: "manual", view: "list", query: null, showOnHome: true, position: 5, createdAt: null, sourceIds: [], itemIds: [lib.itemIds[0]] },
      { id: "col_old2", name: "More picks", emoji: null, mode: "manual", view: "list", query: null, showOnHome: true, position: 6, createdAt: null, sourceIds: [], itemIds: [] },
    ],
  });
  const preview = stageImport(b, pb, legacy);
  assert.equal(preview.counts.collections, 1, "only the restorable collection is counted");
  assert.ok(preview.conflicts.some((c) => /2 hand-picked collections weren't restored/.test(c) && /basket/.test(c)), preview.conflicts.join(" | "));
  const result = applyImport(b, pb, preview.token);
  assert.equal(result.created.collections, 1);
  assert.equal(result.created.items, 4, "the items themselves still come across");
  assert.deepEqual(b.db.all<{ name: string; mode: string }>("SELECT name, mode FROM collections").map((c) => `${c.name}:${c.mode}`), ["Letters:sources"]);
  assert.equal(reconcile(b, pb.accountId).difference, 0);
  assertFlags(b);
});

test("an older export with saved searches imports without them, says so, and keeps everything else", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  seedLibrary(a, pa);
  const { doc } = await exportDoc(a, pa);

  // The shape a file had when saved searches existed: a savedQueries section, listed in the manifest.
  const withSavedSearches = (savedQueries: unknown[]) => {
    const file = rebuild({ ...doc, savedQueries });
    file.manifest.sections.savedQueries = { count: savedQueries.length, sha256: sha256Hex(JSON.stringify(savedQueries)) };
    return file;
  };
  const two = [
    { id: "qry_old1", name: "Sediment", query: { field: "text", value: "sediment" }, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "qry_old2", name: "Tides", query: { field: "text", value: "tides" }, createdAt: null },
  ];

  const preview = stageImport(b, pb, withSavedSearches(two));
  assert.ok(preview.conflicts.some((c) => /2 saved searches weren't restored/.test(c) && /no longer exist/.test(c)), preview.conflicts.join(" | "));
  assert.ok(!("savedQueries" in preview.counts), "saved searches are not counted as something that will be imported");
  const result = applyImport(b, pb, preview.token);
  assert.ok(!("savedQueries" in result.created));
  assert.equal(result.created.items, 4, "the items themselves still come across");
  assert.equal(reconcile(b, pb.accountId).difference, 0);
  assertFlags(b);

  const one = stageImport(b, pb, withSavedSearches(two.slice(0, 1)));
  assert.ok(one.conflicts.some((c) => /1 saved search wasn't restored/.test(c)), one.conflicts.join(" | "));
  const none = stageImport(b, pb, doc);
  assert.ok(!none.conflicts.some((c) => /saved search/.test(c)), "a current export has nothing to skip");
});

test("highlights and notes round-trip: removed ones stay out, text references follow the new ids, and a second import adds none", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  const lib = seedLibrary(a, pa);
  const at = "2026-10-30T09:00:00.000Z";
  const h = newId("ann");
  putAnnotation(a, pa, lib.pinnedOld.itemId, h, {
    kind: "highlight", quote: { exact: "readable text", prefix: "Captured ", suffix: " about" }, position: { start: 9, end: 22 },
    target: { kind: "capture", id: lib.captureId }, body: "My comment on the capture", updatedAt: at,
  });
  putAnnotation(a, pa, lib.itemIds[1], newId("ann"), { kind: "note", body: "A note about bioturbation", updatedAt: at });
  const gone = newId("ann");
  putAnnotation(a, pa, lib.itemIds[2], gone, { kind: "note", body: "removed later", updatedAt: at });
  deleteAnnotation(a, pa, lib.itemIds[2], gone, "2026-10-31T09:00:00.000Z");

  const { doc } = await exportDoc(a, pa);
  assert.equal(doc.annotations.length, 2, "removed annotations are not exported");
  assert.equal(doc.manifest.sections.annotations.count, 2);
  assert.ok(!JSON.stringify(doc).includes("removed later"));
  const exported = doc.annotations.find((x: { id: string }) => x.id === h);
  assert.deepEqual(exported.target, { kind: "capture", id: lib.captureId });

  const before = usedBytes(b, pb.accountId);
  const preview = stageImport(b, pb, doc);
  assert.equal(preview.counts.annotations, 2);
  const result = applyImport(b, pb, preview.token);
  assert.equal(result.created.annotations, 2);
  assert.equal(usedBytes(b, pb.accountId) - before, preview.requiredBytes, "the preview's size includes the annotations exactly");
  assert.equal(reconcile(b, pb.accountId).difference, 0);
  const rows = b.db.all<{ id: string; item_id: string; kind: string; body: string; quote_exact: string | null; quote_prefix: string | null; target_kind: string | null; target_id: string | null; created_at: string }>(
    "SELECT * FROM annotations ORDER BY kind");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.id !== h), "new ids, not the archive's");
  const hl = rows.find((r) => r.kind === "highlight")!;
  const capB = b.db.get<{ id: string; item_id: string }>("SELECT id, item_id FROM captures WHERE status = 'done'")!;
  assert.deepEqual([hl.item_id, hl.target_kind, hl.target_id], [capB.item_id, "capture", capB.id], "the reference names the imported capture");
  assert.deepEqual([hl.quote_exact, hl.quote_prefix, hl.body, hl.created_at], ["readable text", "Captured ", "My comment on the capture", at]);
  assert.equal(listItems(b, pb, { scope: "all", filter: "all", q: "bioturbation" }).total, 1, "imported notes are searchable");

  // Times from the future in a file are capped at the import, so an imported annotation can't win every later edit.
  const { b: f, pb: pf, cleanup: cleanupF } = twoWorkspaces();
  t.after(cleanupF);
  const future = rebuild({ ...doc, annotations: doc.annotations.map((x: Record<string, unknown>) => ({ ...x, createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-02T00:00:00.000Z" })) });
  const importedAt = new Date().toISOString();
  applyImport(f, pf, stageImport(f, pf, future).token);
  for (const r of f.db.all<{ created_at: string; updated_at: string; received_at: string }>("SELECT created_at, updated_at, received_at FROM annotations")) {
    assert.ok(r.updated_at <= new Date().toISOString() && r.created_at <= r.updated_at, `${r.created_at} / ${r.updated_at}`);
    assert.ok(r.received_at >= importedAt);
  }

  const again = applyImport(b, pb, stageImport(b, pb, doc).token);
  assert.equal(again.created.annotations, 0, "the same file again adds no duplicates");
  assert.equal(count(b, "annotations"), 2);

  // An older file without the section still imports; an annotation on an item the file doesn't hold is skipped.
  const { b: c, pb: pc, cleanup: cleanupC } = twoWorkspaces();
  t.after(cleanupC);
  const old = rebuild({ ...doc, annotations: undefined });
  delete old.annotations;
  assert.equal(applyImport(c, pc, stageImport(c, pc, old).token).created.annotations, 0);
  const stray = rebuild({ ...doc, annotations: [{ ...doc.annotations[0], itemId: "itm_not_in_file" }] });
  const { b: d, pb: pd, cleanup: cleanupD } = twoWorkspaces();
  t.after(cleanupD);
  assert.equal(applyImport(d, pd, stageImport(d, pd, stray).token).created.annotations, 0);
});

test("import into an occupied PURSS reconciles by source and link, merges baskets, and keeps existing state", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  const lib = seedLibrary(a, pa);
  const { doc } = await exportDoc(a, pa);
  const firstUrl = a.db.get<{ url: string }>("SELECT url FROM items WHERE title = 'Second post'")!.url;

  // B already follows the same feed, already has "Second post" (under another title), a basket named "reading", and its own state.
  const src = makeSource(b, pb, "Sediment Letters", "feed/9");
  b.db.run("UPDATE sources SET feed_url = 'https://example.org/feed/1.xml' WHERE id = ?", src);
  applySyncBatch(b, pb.engineUserId, batch([entry("feed/9", { title: "Second post (their copy)", url: firstUrl, originalGuid: firstUrl })]));
  const existing = b.db.get<{ id: string }>("SELECT id FROM items")!;
  changeState(b, pb, existing.id, { workflow: "finished", expectedRevision: 0 });
  const mine = createBasket(b, pb, { name: "reading", captureMode: "metadata" }).id;
  const versionBefore = getItem(b, pb, existing.id).stateVersion;

  const preview = stageImport(b, pb, doc);
  assert.ok(preview.conflicts.some((c) => /already in your PURSS/.test(c) && /1 item/.test(c)), preview.conflicts.join(" | "));
  assert.ok(preview.conflicts.some((c) => /basket named “Reading” already exists/.test(c)));
  assert.ok(preview.conflicts.some((c) => /1 source is already in your PURSS/.test(c)));
  assert.equal(preview.counts.newItems, 3);
  const result = applyImport(b, pb, preview.token);

  assert.equal(count(b, "items"), 4, "no duplicate of the item that was already there");
  assert.equal(b.db.all("SELECT 1 FROM sources WHERE title = 'Sediment Letters'").length, 1, "the followed source is reused, not duplicated");
  assert.equal(b.db.all("SELECT 1 FROM jobs WHERE kind = 'engine.subscribe'").length, 0, "nothing new to follow");
  assert.equal(b.db.all("SELECT 1 FROM baskets").length, 2, "Reading merged into the existing basket");
  assert.equal(result.alreadyPresent.items, 1);
  // Their item got the kept pin (with the archived snapshot as its own version), and its state was left alone.
  const laterB = b.db.get<{ id: string }>("SELECT id FROM baskets WHERE name = 'Later'")!.id;
  const pin = b.db.get<{ version_id: string }>("SELECT version_id FROM basket_items WHERE item_id = ? AND basket_id = ?", existing.id, laterB)!;
  assert.equal(b.db.get<{ title: string }>("SELECT title FROM item_versions WHERE id = ?", pin.version_id)!.title, "Second post");
  assert.equal(b.db.get<{ workflow: string }>("SELECT workflow FROM item_state WHERE item_id = ?", existing.id)!.workflow, "finished");
  // Each pin it gained changed the copy caches hold (basketIds): the state version moved once per pin, the revision not at all.
  const pins = b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM basket_items WHERE item_id = ?", existing.id)!.n;
  assert.ok(pins >= 1);
  assert.equal(getItem(b, pb, existing.id).stateVersion, versionBefore + pins);
  assert.equal(getItem(b, pb, existing.id).revision, 1);
  assert.equal(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM basket_items WHERE basket_id = ?", mine)!.n, 1);
  assert.equal(reconcile(b, pb.accountId).difference, 0);
  assertFlags(b);
  void lib;
});

test("an import that does not fit writes nothing and stays staged until there is room", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces(400);
  t.after(cleanup);
  seedLibrary(a, pa);
  const { doc } = await exportDoc(a, pa);
  const preview = stageImport(b, pb, doc);
  assert.equal(preview.fits, false);
  assert.ok(preview.requiredBytes > 400);
  const snapshot = () => ["items", "item_versions", "sources", "baskets", "basket_items", "captures", "stored_objects", "usage_events", "jobs", "collections"].map((t) => count(b, t));
  const before = snapshot();
  assert.throws(() => applyImport(b, pb, preview.token), (e: unknown) => e instanceof HttpError && e.status === 507);
  assert.deepEqual(snapshot(), before, "not a single row was written");
  assert.equal(b.db.get("SELECT paused_reason FROM storage_accounts")!.paused_reason, null, "the service leaves pause marking to the request boundary, like every other rejected growth");
  assert.equal(count(b, "import_stages"), 1, "still staged");
  b.db.run("UPDATE storage_accounts SET allocation_bytes = NULL");
  assert.equal(applyImport(b, pb, preview.token).created.items, 4);
});

test("space is checked again when the import is applied, not only at preview time", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  seedLibrary(a, pa);
  const preview = stageImport(b, pb, (await exportDoc(a, pa)).doc);
  assert.equal(preview.fits, true);
  b.db.run("UPDATE storage_accounts SET allocation_bytes = 100"); // the quota shrank in between
  assert.throws(() => applyImport(b, pb, preview.token), (e: unknown) => e instanceof HttpError && e.status === 507);
  assert.equal(count(b, "items"), 0);
});

test("a hostile archive cannot smuggle scripts, credentials or private links into the PURSS", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  seedLibrary(a, pa);
  const doc = (await exportDoc(a, pa)).doc;
  const publicItem = doc.items.find((i: any) => i.title === "Second post");
  publicItem.versions[0].summaryHtml = `<p onclick="steal()">hi</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>`;
  publicItem.imageUrl = "https://user:pass@evil.example/img.png";
  publicItem.url = "https://example.org/ok?access_token=LEAKEDTOKEN99";
  publicItem.enclosures = [{ url: "file:///etc/passwd", type: null, length: null }, { url: "https://example.org/a.mp3?sig=LEAKEDSIG123", type: "audio/mpeg", length: null }];
  const pubSource = doc.sources.find((s: any) => s.kind === "feed");
  doc.sources.push({ ...pubSource, id: "src_evil", title: "Disguised", feedUrl: "https://feeds.example/x?token=HIDDENSECRET99", isPrivate: false, reconnectRequired: false });
  doc.sources.push({ ...pubSource, id: "src_flagged", title: "Flagged private", feedUrl: "https://flagged.example/feed.xml", isPrivate: true });
  const forged = rebuild(doc);
  const preview = stageImport(b, pb, forged);
  assert.equal(preview.counts.sourcesToReconnect, 3, "the credential-shaped and the flagged source both need reconnecting");
  applyImport(b, pb, preview.token);

  const html = b.db.get<{ summary_html: string }>("SELECT v.summary_html FROM item_versions v JOIN items i ON i.id = v.item_id WHERE i.title = 'Second post'")!.summary_html;
  assert.ok(!/script|onclick|javascript:/i.test(html), html);
  const row = b.db.get<{ url: string | null; image_url: string | null; enclosures: string }>("SELECT url, image_url, enclosures FROM items WHERE title = 'Second post'")!;
  assert.equal(row.url, null);
  assert.equal(row.image_url, null);
  assert.equal(row.enclosures, "[]");
  const dump = JSON.stringify([
    b.db.all("SELECT * FROM sources"), b.db.all("SELECT payload FROM jobs"), b.db.all("SELECT url, image_url, enclosures FROM items"), b.db.all("SELECT url FROM item_versions"),
  ]);
  for (const secret of ["HIDDENSECRET99", "LEAKEDTOKEN99", "LEAKEDSIG123", "flagged.example", "evil.example", "passwd"]) assert.ok(!dump.includes(secret), `${secret} must not be stored`);
  assert.equal(b.db.all("SELECT 1 FROM sources WHERE health = 'reconnect'").length, 3);
});

test("a private source restored as 'Reconnect required' resumes only when the owner supplies the link again", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  seedLibrary(a, pa);
  applyImport(b, pb, stageImport(b, pb, (await exportDoc(a, pa)).doc).token);
  const priv = b.db.get<{ id: string }>("SELECT id FROM sources WHERE title = 'Secret Garden'")!.id;
  const pubSrc = b.db.get<{ id: string }>("SELECT id FROM sources WHERE title = 'Sediment Letters'")!.id;
  assert.throws(() => reconnectSource(b, pb, pubSrc, "x"), (e: unknown) => e instanceof HttpError && e.status === 409);
  assert.throws(() => reconnectSource(b, pb, priv, "no-such-token"), (e: unknown) => e instanceof HttpError && e.status === 400);

  const token = newId("dsc");
  holdCandidate(token, pb.workspaceId, { feedUrl: PRIVATE_FEED_URL, siteUrl: null, title: "x", kind: "feed", origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null });
  reconnectSource(b, pb, priv, token);
  const row = b.db.get<{ paused: number; health: string; feed_url: string | null }>("SELECT paused, health, feed_url FROM sources WHERE id = ?", priv)!;
  assert.deepEqual([row.paused, row.health, row.feed_url], [0, "pending", null], "the address stays outside the database");
  const job = b.db.all<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'engine.subscribe'").map((j) => JSON.parse(j.payload)).find((j) => j.sourceId === priv)!;
  assert.equal(job.feedUrl, `secret:source-urls/${priv}`);
  assert.ok(existsSync(path.join(b.config.secretsDir, "source-urls", priv)));
  assert.throws(() => reconnectSource(b, pb, priv, token), (e: unknown) => e instanceof HttpError && e.status === 409, "no longer needs reconnecting");
});

test("a staged import belongs to its PURSS and expires", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  seedLibrary(a, pa);
  const preview = stageImport(b, pb, (await exportDoc(a, pa)).doc);
  const stranger = makeOwner(b, { admin: false });
  assert.throws(() => applyImport(b, stranger, preview.token), (e: unknown) => e instanceof HttpError && e.code === "expired");
  b.db.run("UPDATE import_stages SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.throws(() => applyImport(b, pb, preview.token), (e: unknown) => e instanceof HttpError && e.code === "expired");
  assert.equal(count(b, "items"), 0);
  // A new preview clears the expired one.
  stageImport(b, pb, (await exportDoc(a, pa)).doc);
  assert.equal(count(b, "import_stages"), 1);
});

test("imported items are searchable in their folded form, like collected ones", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  makeSource(a, pa, "حبر", "feed/arabic");
  applySyncBatch(a, (pa as Owner).engineUserId, batch([entry("feed/arabic", { title: "الكِتَابُ الجديد في عمّان", url: "https://example.org/kitab" })]));
  const { doc } = await exportDoc(a, pa);
  applyImport(b, pb, stageImport(b, pb, doc).token);
  const found = listItems(b, pb, { scope: "all", q: "كتاب" }).items.map((i) => i.title);
  assert.deepEqual(found, ["الكِتَابُ الجديد في عمّان"], "typed without vowel marks or the article, the imported title is found");
});

test("Remind me days round-trip with their notes; days gone by, items not kept and days already set are left alone", async (t) => {
  const { a, b, pa, pb, cleanup } = twoWorkspaces();
  t.after(cleanup);
  const lib = seedLibrary(a, pa);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  setItemReminder(a, pa, lib.keptIds[0]!, { remindOn: day(5), note: "Book the train" });
  setItemReminder(a, pa, lib.keptIds[1]!, { remindOn: day(9), note: null });

  const { doc } = await exportDoc(a, pa);
  assert.deepEqual(doc.itemReminders.map((r: { remindOn: string; note: string | null }) => [r.remindOn, r.note]).sort(), [[day(5), "Book the train"], [day(9), null]].sort());
  assert.equal(doc.manifest.sections.itemReminders.count, 2);
  const none = await exportDoc(b, pb);
  assert.equal(none.doc.itemReminders, undefined, "a PURSS without reminders exports no section, as before");

  const preview = stageImport(b, pb, doc);
  assert.equal(preview.counts.itemReminders, 2);
  assert.equal(applyImport(b, pb, preview.token).created.reminders, 2);
  const titleOf = (app: App, id: string) => app.db.get<{ title: string }>("SELECT title FROM items WHERE id = ?", id)!.title;
  const landed = b.db.all<{ item_id: string; remind_on: string; note: string | null }>("SELECT item_id, remind_on, note FROM item_reminders ORDER BY remind_on");
  assert.deepEqual(landed.map((r) => [titleOf(b, r.item_id), r.remind_on, r.note]), [[titleOf(a, lib.keptIds[0]!), day(5), "Book the train"], [titleOf(a, lib.keptIds[1]!), day(9), null]]);
  assert.equal(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM item_reminders WHERE notified_at IS NOT NULL")!.n, 0, "they are still to be told");
  assert.equal(applyImport(b, pb, stageImport(b, pb, doc).token).created.reminders, 0, "the same file again adds none");

  // A day that has gone by, and a reminder on an item the file doesn't hold, are skipped.
  const { b: c, pb: pc, cleanup: cleanupC } = twoWorkspaces();
  t.after(cleanupC);
  const odd = rebuild({ ...doc, itemReminders: [{ itemId: doc.itemReminders[0].itemId, remindOn: day(-3), note: "too late" }, { itemId: "itm_not_in_file", remindOn: day(4), note: null }] });
  assert.equal(applyImport(c, pc, stageImport(c, pc, odd).token).created.reminders, 0);
  // A hostile file's bad day is refused as an invalid export.
  const bad = rebuild({ ...doc, itemReminders: [{ itemId: doc.itemReminders[0].itemId, remindOn: "next week", note: null }] });
  assert.throws(() => stageImport(c, pc, bad), (e: unknown) => e instanceof HttpError);
});
