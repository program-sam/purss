import test from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "./api.ts";
import {
  chooseDownloads, connectionAllows, DEFAULT_DOWNLOAD_SETTINGS as DEFAULT_SETTINGS, downloadCandidate, downloadPlanRequestSchema, expectedBytes, isFinished,
  mediaExtension, mediaToDownload, parseDownloadSettings as parseSettings, removeWhenFinished, UNKNOWN_SIZE_BYTES,
} from "./downloads.ts";
import type { DownloadCandidate as Candidate, DownloadSettings } from "./downloads.ts";

const MB = 1024 * 1024;
const S = (over: Partial<DownloadSettings> = {}): DownloadSettings => ({ ...DEFAULT_SETTINGS, autoToRead: true, ...over });
const ep = (id: string, over: Partial<Candidate> = {}, mediaOver: Partial<NonNullable<Candidate["media"]>> = {}): Candidate => ({
  id, kind: "podcast", workflow: "toread", durationSeconds: null, publishedAt: `2026-11-0${id.slice(-1)}T00:00:00Z`, discoveredAt: "2026-11-01T00:00:00Z",
  media: { kind: "audio", length: 50 * MB, ...mediaOver }, ...over,
});
const ids = (list: Candidate[]) => list.map((c) => c.id);

test("sizes: the feed's, then 128 kbit/s for the length, then a cautious guess", () => {
  assert.equal(expectedBytes(ep("e1", {}, { length: 9 * MB })), 9 * MB);
  assert.equal(expectedBytes(ep("e1", { durationSeconds: 3600 }, { length: null })), 57_600_000);
  assert.equal(expectedBytes(ep("e1", {}, { length: null })), UNKNOWN_SIZE_BYTES);
  assert.equal(expectedBytes(ep("e1", { media: null })), 0);
});

test("Wi-Fi only: automatic downloads wait for Wi-Fi; never without a connection", () => {
  assert.equal(connectionAllows(S(), "wifi"), true);
  assert.equal(connectionAllows(S(), "cellular"), false);
  assert.equal(connectionAllows(S(), "unknown"), false);
  assert.equal(connectionAllows(S({ wifiOnly: false }), "cellular"), true);
  assert.equal(connectionAllows(S({ wifiOnly: false }), "none"), false);
});

test("To read podcast episodes, newest first, only what isn't here yet, and nothing past the limit", () => {
  const list = [ep("e1"), ep("e3"), ep("e2"), ep("e4", { workflow: "new" }), ep("e5", { kind: "article" }), ep("e6", { media: null })];
  assert.deepEqual(ids(chooseDownloads(S(), list, new Set(), 0)), ["e3", "e2", "e1"]);
  assert.deepEqual(ids(chooseDownloads(S(), list, new Set(["e3"]), 0)), ["e2", "e1"], "already downloaded, or failed: a failed one is retried only by hand");
  assert.deepEqual(ids(chooseDownloads(S({ limitBytes: 120 * MB }), list, new Set(), 0)), ["e3", "e2"], "the third would pass the limit");
  assert.deepEqual(ids(chooseDownloads(S({ limitBytes: 120 * MB }), list, new Set(), 100 * MB)), [], "what is already downloaded counts");
  const mixed = [ep("e1", {}, { length: 200 * MB }), ep("e2", {}, { length: 10 * MB })];
  assert.deepEqual(ids(chooseDownloads(S({ limitBytes: 100 * MB }), mixed, new Set(), 0)), ["e2"], "a big file is skipped, a smaller one still fits");
  assert.deepEqual(ids(chooseDownloads(S({ autoToRead: false }), list, new Set(), 0)), [], "off means nothing");
});

test("finished means marked Finished or Ignored, or played to the end; cleanup only when asked and only finished downloads", () => {
  assert.equal(isFinished({ workflow: "finished", playback: null }), true);
  assert.equal(isFinished({ workflow: "ignored", playback: null }), true);
  assert.equal(isFinished({ workflow: "toread", playback: { positionSeconds: 590, durationSeconds: 600 } }), true);
  assert.equal(isFinished({ workflow: "toread", playback: { positionSeconds: 500, durationSeconds: 600 } }), false);
  assert.equal(isFinished({ workflow: "inprogress", playback: { positionSeconds: 500, durationSeconds: null } }), false);
  const done = { workflow: "finished", playback: null };
  assert.equal(removeWhenFinished(S({ removeFinished: false }), "done", done), false);
  assert.equal(removeWhenFinished(S({ removeFinished: true }), "done", done), true, "every download, automatic or by hand");
  assert.equal(removeWhenFinished(S({ removeFinished: true }), "downloading", done), false);
});

test("settings read back field by field, with the defaults for anything damaged", () => {
  assert.deepEqual(parseSettings(null, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("{", DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('{"autoToRead":true,"limitBytes":-4,"wifiOnly":"no"}', DEFAULT_SETTINGS), { ...DEFAULT_SETTINGS, autoToRead: true });
  assert.equal(DEFAULT_SETTINGS.wifiOnly, true, "Wi-Fi only until the person says otherwise");
  assert.equal(DEFAULT_SETTINGS.autoToRead || DEFAULT_SETTINGS.removeFinished, false, "nothing automatic until chosen");
});

const item = (media: ItemDTO["media"]): ItemDTO => ({
  id: "itm_1", sourceId: "src_1", sourceTitle: "Slow Radio", kind: "podcast", title: "One", url: null, author: null, excerpt: null, imageUrl: null,
  durationSeconds: 600, readMinutes: null, doi: null, publishedAt: null, discoveredAt: "2026-11-01T00:00:00Z", workflow: "toread", revision: 1, stateVersion: 1,
  fresh: false, progress: 0, opened: false, basketIds: [], curatorNote: null, media, annotatedAt: null,
});
test("a publisher's file over plain http is never a candidate", () => {
  const plain = { url: "http://pub.example/a.mp3", kind: "audio" as const, type: "audio/mpeg", length: 5 * MB };
  assert.equal(downloadCandidate(item(plain)).media, null);
  assert.equal(downloadCandidate(item({ ...plain, url: "https://pub.example/a.mp3" })).media?.length, 5 * MB);
  assert.equal(downloadCandidate(item(null)).media, null);
});

test("what a device fetches: the publisher's file, its type, size and a name for it", () => {
  const media = { url: "https://pub.example/a.mp3?x=1", kind: "audio" as const, type: "audio/mpeg", length: 5 * MB };
  assert.deepEqual(mediaToDownload(media), { url: media.url, type: "audio/mpeg", declaredBytes: 5 * MB, file: "media.mp3" });
  assert.deepEqual(mediaToDownload({ ...media, type: null, url: "https://pub.example/b.m4a" }), { url: "https://pub.example/b.m4a", type: null, declaredBytes: 5 * MB, file: "media.m4a" });
});

test("file extensions come from the type, else the address", () => {
  assert.equal(mediaExtension("audio/mpeg", "https://x/a"), ".mp3");
  assert.equal(mediaExtension("audio/x-m4a; codecs=x", "https://x/a"), ".m4a");
  assert.equal(mediaExtension(null, "https://x/ep.OGG?t=1"), ".ogg");
  assert.equal(mediaExtension("application/octet-stream", "https://x/ep"), "");
});

test("a plan request is bounded", () => {
  const ok = { autoToRead: true, limitBytes: 2 * 1024 ** 3, usedBytes: 0, have: ["itm_1"] };
  assert.equal(downloadPlanRequestSchema.safeParse(ok).success, true);
  assert.equal(downloadPlanRequestSchema.safeParse({ ...ok, limitBytes: 0 }).success, false);
  assert.equal(downloadPlanRequestSchema.safeParse({ ...ok, usedBytes: -1 }).success, false);
  assert.equal(downloadPlanRequestSchema.safeParse({ ...ok, have: Array.from({ length: 5001 }, (_, i) => `i${i}`) }).success, false);
  assert.equal(downloadPlanRequestSchema.safeParse({ ...ok, have: ["x".repeat(65)] }).success, false);
});
