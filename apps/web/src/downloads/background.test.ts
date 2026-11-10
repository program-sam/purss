import test from "node:test";
import assert from "node:assert/strict";
import { parseBackgroundRecord } from "./background.ts";

const ok = {
  itemId: "itm_1", title: "One", sourceTitle: "Slow Radio", kind: "podcast", state: "done", status: null,
  media: { file: "acc_1/itm_1/media.mp3", bytes: 1234, type: "audio/mpeg", kind: "audio" }, textBytes: 99, savedAt: "2026-11-06T03:00:00.000Z",
};
const read = (v: unknown, account = "acc_1", item = "itm_1") => parseBackgroundRecord(JSON.stringify(v), account, item);

test("a record the background job wrote reads back as a download", () => {
  assert.deepEqual(read(ok), ok);
  assert.deepEqual(read({ ...ok, state: "failed", status: 404, media: null, textBytes: 0 }), { ...ok, state: "failed", status: 404, media: null, textBytes: 0 });
  assert.equal(read({ ...ok, kind: "hologram" })!.kind, "article", "an unknown kind is shown as an article");
});

test("records that don't belong where they are, or are damaged, are refused", () => {
  assert.equal(parseBackgroundRecord(null, "acc_1", "itm_1"), null);
  assert.equal(parseBackgroundRecord("{", "acc_1", "itm_1"), null);
  assert.equal(read(ok, "acc_1", "itm_2"), null, "another item's record");
  assert.equal(read(ok, "acc_2"), null, "another account's folder");
  assert.equal(read({ ...ok, state: "downloading" }), null);
  for (const file of ["acc_1/itm_2/media.mp3", "acc_1/itm_1/../itm_2/media.mp3", "acc_1/itm_1/sub/media.mp3", "/etc/passwd", "acc_1/itm_1media.mp3"]) {
    assert.equal(read({ ...ok, media: { ...ok.media, file } }), null, file);
  }
  assert.equal(read({ ...ok, media: { ...ok.media, bytes: -1 } }), null);
  assert.equal(read({ ...ok, media: { ...ok.media, bytes: 5 * 1024 ** 3 } }), null, "never more than the largest download");
  assert.equal(read({ ...ok, media: { ...ok.media, kind: "image" } }), null);
});
