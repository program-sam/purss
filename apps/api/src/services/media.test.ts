import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "./sync.ts";
import { getItemDetail } from "./items.ts";
import { deleteItemNow } from "./collections.ts";
import { reconcile, usedBytes } from "./storage.ts";
import { savePlayback } from "./media.ts";

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
