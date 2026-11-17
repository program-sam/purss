import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail, listItems } from "./items.ts";
import { deleteItemNow } from "./collections.ts";
import { reconcile, usedBytes } from "./storage.ts";
import { savePlayback } from "./media.ts";
import { createBasket } from "./collections.ts";
import { keepItem } from "./state.ts";

const MP3 = "https://cdn.example.org/episodes/ep1.mp3";

function setup() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Slow Radio", "feed/1", { kind: "podcast" });
  return { app, p, cleanup };
}

function episode(app: App, p: Principal & { engineUserId: string }, over: Parameters<typeof entry>[1] = {}): string {
  const e = entry("feed/1", { enclosures: [{ url: MP3, type: "audio/mpeg", length: 3000 }], ...over });
  applySyncBatch(app, p.engineUserId, batch([e]));
  return app.db.get<{ id: string }>("SELECT item_id AS id FROM external_ids WHERE external_id = ?", e.externalId)!.id;
}

test("an item reports the publisher's audio or video file as the feed gives it; the server keeps nothing of it", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const itemId = episode(app, p);
  assert.deepEqual(getItemDetail(app, p, itemId).media, { url: MP3, kind: "audio", type: "audio/mpeg", length: 3000 });
  const video = episode(app, p, { enclosures: [{ url: "https://cdn.example.org/v.mp4", type: null, length: null }] });
  assert.deepEqual(getItemDetail(app, p, video).media, { url: "https://cdn.example.org/v.mp4", kind: "video", type: null, length: null }, "untyped: by file extension");
  assert.equal(getItemDetail(app, p, episode(app, p, { enclosures: [] })).media, null, "an item without a file has no media");
  assert.equal(getItemDetail(app, p, episode(app, p, { enclosures: [{ url: "https://cdn.example.org/live.m3u8", type: "application/x-mpegurl", length: null }] })).media, null, "a streaming playlist is not a file");
  assert.equal(app.db.get("SELECT 1 FROM stored_objects WHERE kind = 'media'"), undefined, "no stored object is ever made for a media file");
  assert.equal(app.db.get("SELECT 1 FROM sqlite_master WHERE name = 'saved_media'"), undefined);
  assert.equal(reconcile(app, p.accountId).difference, 0);
});

test("a private source's file address is never shown", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Members feed", "feed/9", { isPrivate: true });
  applySyncBatch(app, p.engineUserId, batch([entry("feed/9", { enclosures: [{ url: "https://cdn.example.org/m.mp3?token=SECRET", type: "audio/mpeg", length: 10 }] })]));
  const priv = app.db.get<{ id: string }>("SELECT i.id FROM items i JOIN sources s ON s.id = i.source_id WHERE s.is_private = 1")!.id;
  assert.equal(getItemDetail(app, p, priv).media, null);
});

test("an item says whether its own link is its file, for a private source too, whose file addresses stay withheld", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Members feed", "feed/9", { isPrivate: true });
  // The link is the enclosure itself and names no file: no extension, only the feed's own enclosure shows it is one.
  const file = "https://cdn.example.org/play?id=7&token=SECRET";
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/9", { url: file, enclosures: [{ url: file, type: "audio/mpeg", length: 10 }] }),
    entry("feed/9", { url: "https://members.example/episodes/8", enclosures: [{ url: file, type: "audio/mpeg", length: 10 }] }),
    entry("feed/9", { url: "https://members.example/cover", enclosures: [{ url: "https://members.example/cover", type: "image/jpeg", length: 10 }] }),
  ]));
  const rows = app.db.all<{ id: string; url: string }>("SELECT i.id, i.url FROM items i JOIN sources s ON s.id = i.source_id WHERE s.is_private = 1");
  const detail = (url: string) => getItemDetail(app, p, rows.find((r) => r.url === url)!.id);
  const asFile = detail(file);
  assert.equal(asFile.linkIsMedia, true, "the server, which has the enclosures, says the link is the file");
  assert.equal(asFile.media, null, "and still withholds the file's address");
  assert.deepEqual(asFile.enclosures, [], "and the enclosures");
  assert.equal(asFile.url, null, "and its link, which is that same address");
  assert.ok(!JSON.stringify(asFile).includes("SECRET"), "nothing the reader gets carries the token");
  assert.ok(!JSON.stringify(listItems(app, p, { scope: "all", limit: 50 }).items).includes("SECRET"), "nor any list");
  assert.equal(detail("https://members.example/episodes/8").linkIsMedia, false, "a page beside the file is not the file");
  assert.equal(detail("https://members.example/cover").linkIsMedia, false, "an image enclosure is not a media file");
  // A public source says the same of its own, by the file's extension too.
  const open = episode(app, p, { url: MP3 });
  assert.equal(getItemDetail(app, p, open).linkIsMedia, true);
  assert.equal(getItemDetail(app, p, episode(app, p, { url: "https://example.org/ep/1" })).linkIsMedia, false);
});

test("a private episode whose file address is rotated stays a file, and the new token is withheld as the old one was", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Members feed", "feed/9", { isPrivate: true });
  const first = "https://cdn.example.org/play?id=7&token=OLDSECRET";
  const e = entry("feed/9", { url: first, enclosures: [{ url: first, type: "audio/mpeg", length: 10 }] });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = app.db.get<{ id: string }>("SELECT item_id AS id FROM external_ids WHERE external_id = ?", e.externalId)!.id;
  // The publisher hands out a new token: the same episode comes again with the new file address as its link and its file.
  const rotated = "https://cdn.example.org/play?id=7&token=NEWSECRET";
  applySyncBatch(app, p.engineUserId, batch([{ ...e, title: `${e.title} (updated)`, url: rotated, enclosures: [{ url: rotated, type: "audio/mpeg", length: 10 }] }]));
  const d = getItemDetail(app, p, id);
  assert.equal(d.title, `${e.title} (updated)`, "the revision was applied");
  assert.equal(d.linkIsMedia, true, "the rotated link is still the episode's file");
  assert.equal(d.url, null);
  assert.ok(!JSON.stringify(d).includes("SECRET"), "neither token reaches the reader");
});

test("playback positions are kept per item, apart from reading progress, and counted as one small record", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const itemId = episode(app, p);
  const before = getItemDetail(app, p, itemId);
  assert.equal(before.playback, null);
  const used = usedBytes(app, p.accountId);
  savePlayback(app, p, itemId, { positionSeconds: 61.5, durationSeconds: 1800 });
  savePlayback(app, p, itemId, { positionSeconds: 2000, durationSeconds: null });
  const after = getItemDetail(app, p, itemId);
  assert.equal(after.playback!.positionSeconds, 2000);
  assert.equal(after.playback!.durationSeconds, 1800, "a missing duration keeps the known one");
  savePlayback(app, p, itemId, { positionSeconds: 2000, durationSeconds: 1800 });
  assert.equal(getItemDetail(app, p, itemId).playback!.positionSeconds, 1800, "never past the end");
  assert.equal(after.progress, before.progress, "reading progress is untouched");
  assert.equal(after.workflow, before.workflow);
  assert.equal(after.revision, before.revision, "no revision bump, so it never conflicts with workflow changes");
  assert.equal(usedBytes(app, p.accountId) - used, 64, "one small record, however often it is saved");

  app.db.tx(() => deleteItemNow(app, p, itemId));
  assert.equal(app.db.get("SELECT 1 FROM playback_positions"), undefined);
  assert.equal(reconcile(app, p.accountId).difference, 0);
  assert.equal(usedBytes(app, p.accountId) < used, true, "deleting the item releases it");
});

test("a playback position sent late wins only if it was recorded after the stored one", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const itemId = episode(app, p);
  const at = (iso: string) => new Date(iso);
  // Played online to 3:41 at 10:00.
  savePlayback(app, p, itemId, { positionSeconds: 221, durationSeconds: 300 }, at("2026-11-06T10:00:00.000Z"));
  // Played offline to 4:01, recorded on the device at 10:05, and sent when the connection came back at 10:30.
  let out = savePlayback(app, p, itemId, { positionSeconds: 241, durationSeconds: 300, recordedAt: "2026-11-06T10:05:00.000Z" }, at("2026-11-06T10:30:00.000Z"));
  assert.equal(out.positionSeconds, 241, "the newer offline position replaces the older one");
  assert.equal(out.updatedAt, "2026-11-06T10:05:00.000Z", "kept with the time it was recorded");
  // A stale write (recorded at 10:02, before the stored one) doesn't overwrite it; the answer is the newer position.
  out = savePlayback(app, p, itemId, { positionSeconds: 100, durationSeconds: 300, recordedAt: "2026-11-06T10:02:00+00:00" }, at("2026-11-06T10:31:00.000Z"));
  assert.equal(out.positionSeconds, 241);
  assert.equal(getItemDetail(app, p, itemId).playback!.positionSeconds, 241);
  // Another device playing online later wins over a position recorded earlier.
  savePlayback(app, p, itemId, { positionSeconds: 30, durationSeconds: 300 }, at("2026-11-06T11:00:00.000Z"));
  out = savePlayback(app, p, itemId, { positionSeconds: 250, durationSeconds: 300, recordedAt: "2026-11-06T10:59:00.000Z" }, at("2026-11-06T11:01:00.000Z"));
  assert.equal(out.positionSeconds, 30, "listening elsewhere afterwards is newer");
  // A device clock ahead of the server's counts as now: it can't block later writes.
  out = savePlayback(app, p, itemId, { positionSeconds: 60, durationSeconds: 300, recordedAt: "2027-01-01T00:00:00.000Z" }, at("2026-11-06T11:02:00.000Z"));
  assert.equal(out.updatedAt, "2026-11-06T11:02:00.000Z");
  out = savePlayback(app, p, itemId, { positionSeconds: 70, durationSeconds: 300 }, at("2026-11-06T11:03:00.000Z"));
  assert.equal(out.positionSeconds, 70);
});

test("another account can't save a playback position on an item that isn't theirs", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  const itemId = episode(app, p);
  const other = makeOwner(app);
  assert.throws(() => savePlayback(app, other, itemId, { positionSeconds: 1, durationSeconds: null }), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(app.db.get("SELECT 1 FROM playback_positions"), undefined);
});

test("a kept private episode never shows an older file address, even after the feed moves it to a page", (t) => {
  const { app, p, cleanup } = setup();
  t.after(cleanup);
  makeSource(app, p, "Members feed", "feed/9", { isPrivate: true });
  const file = "https://cdn.example.org/play?id=7&token=KEPTSECRET";
  const e = entry("feed/9", { url: file, enclosures: [{ url: file, type: "audio/mpeg", length: 10 }] });
  applySyncBatch(app, p.engineUserId, batch([e]));
  const id = app.db.get<{ id: string }>("SELECT item_id AS id FROM external_ids WHERE external_id = ?", e.externalId)!.id;
  keepItem(app, p, id, createBasket(app, p, { name: "Kept", captureMode: "metadata" }).id);
  // The feed now gives the episode a page and a new file: the kept version still has the old file address as its link.
  const rotated = "https://cdn.example.org/play?id=7&token=NEWSECRET";
  applySyncBatch(app, p.engineUserId, batch([{ ...e, title: `${e.title} (updated)`, url: "https://members.example/episodes/7", enclosures: [{ url: rotated, type: "audio/mpeg", length: 10 }] }]));
  const d = getItemDetail(app, p, id);
  assert.ok(!JSON.stringify(d).includes("SECRET"), "no token, old or new, reaches the reader");
  assert.equal(d.url, null, "the kept link that can't be told apart from the file is withheld");
  assert.equal(d.linkIsMedia, true, "and treated as the file, so the show's website is offered instead");
});
