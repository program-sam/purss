import test from "node:test";
import assert from "node:assert/strict";
import { pickMediaEnclosure } from "./media.ts";

test("the first audio or video file is the item's media; playlists, pages and non-web addresses are not", () => {
  assert.deepEqual(pickMediaEnclosure([{ url: "https://x.org/cover.jpg", type: "image/jpeg" }, { url: "https://x.org/ep.mp3", type: "audio/mpeg", length: 1200 }]),
    { url: "https://x.org/ep.mp3", kind: "audio", type: "audio/mpeg", length: 1200 });
  assert.equal(pickMediaEnclosure([{ url: "https://x.org/v.mp4", type: "video/mp4", length: 0 }])?.length, null, "a zero length means unknown");
  assert.equal(pickMediaEnclosure([{ url: "https://x.org/ep.m4a", type: null }])?.kind, "audio", "untyped: by extension");
  assert.equal(pickMediaEnclosure([{ url: "https://x.org/ep.webm?x=1", type: "application/octet-stream" }])?.kind, "video");
  assert.equal(pickMediaEnclosure([{ url: "https://x.org/live.m3u8", type: "application/x-mpegurl" }]), null);
  assert.equal(pickMediaEnclosure([{ url: "https://x.org/live.m3u", type: "audio/x-mpegurl" }]), null, "an audio/* playlist is still a playlist");
  assert.equal(pickMediaEnclosure([{ url: "https://x.org/page", type: "text/html" }, { url: "https://x.org/doc.pdf", type: null }]), null);
  assert.equal(pickMediaEnclosure([{ url: "ftp://x.org/ep.mp3", type: "audio/mpeg" }, { url: "javascript:alert(1)", type: "audio/mpeg" }]), null);
});
