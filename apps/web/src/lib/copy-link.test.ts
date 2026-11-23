import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { copyLinkEntries } from "./copy-link.ts";

const t = app.lib.copyLink;

function run(url: string | null, media: ItemDTO["media"] = null, linkIsMedia?: boolean) {
  const copied: [string, string][] = [];
  const entries = copyLinkEntries({ url, media, ...(linkIsMedia === undefined ? {} : { linkIsMedia }) }, { purssLink: "https://work.example/app/?item=itm_1", copy: (text, message) => copied.push([text, message]) });
  for (const e of entries) if (e.type === undefined || e.type === "item") e.onSelect();
  return { labels: entries.map((e) => ("label" in e ? e.label : "")), copied };
}

test("Copy link copies the original address; the PURSS link is a separate entry", () => {
  const r = run("https://example.org/post?utm=x");
  assert.deepEqual(r.labels, [t.original, t.private]);
  assert.deepEqual(r.copied.map((c) => c[0]), ["https://example.org/post?utm=x", "https://work.example/app/?item=itm_1"]);
});

test("an item with no original address offers only the PURSS link", () => {
  assert.deepEqual(run(null).labels, [t.private]);
  assert.deepEqual(run("javascript:alert(1)").labels, [t.private], "an address that is not http(s) is not copied");
});

test("an episode whose link is its audio file has no original page to copy", () => {
  const file = "https://traffic.megaphone.fm/GLT2156782927.mp3";
  assert.deepEqual(run(file, { url: file, kind: "audio", type: "audio/mpeg", length: null }).labels, [t.private]);
  assert.deepEqual(run("https://shows.acast.com/offmenu/episodes/sara-cox", { url: "https://sphinx.acast.com/x.mp3", kind: "audio", type: "audio/mpeg", length: null }).labels,
    [t.original, t.private], "an episode with a page copies the page");
});

test("a private source's file link, which the server says is its file, is never offered as the original", () => {
  // No `media` and no extension: only the server, which has the enclosures, can tell this address is the file, and it carries a token.
  const file = "https://cdn.example.org/play?id=7&token=s3cr3t";
  assert.deepEqual(run(file, null, true).labels, [t.private]);
  assert.deepEqual(run(file, null, true).copied.map((c) => c[0]), ["https://work.example/app/?item=itm_1"], "the file's address is not copied");
  assert.deepEqual(run("https://example.org/post", null, false).labels, [t.original, t.private]);
});
