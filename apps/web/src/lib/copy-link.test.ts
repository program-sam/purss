import assert from "node:assert/strict";
import { test } from "node:test";
import { copyLinkEntries } from "./copy-link.ts";

function run(url: string | null) {
  const copied: [string, string][] = [];
  const entries = copyLinkEntries({ url }, { workspaceLink: "https://work.example/app/?item=itm_1", copy: (text, message) => copied.push([text, message]) });
  for (const e of entries) if (e.type === undefined || e.type === "item") e.onSelect();
  return { labels: entries.map((e) => ("label" in e ? e.label : "")), copied };
}

test("Copy link copies the original address; the PURSS link is a separate entry", () => {
  const r = run("https://example.org/post?utm=x");
  assert.deepEqual(r.labels, ["Copy link", "Copy link to this item in your PURSS"]);
  assert.deepEqual(r.copied.map((c) => c[0]), ["https://example.org/post?utm=x", "https://work.example/app/?item=itm_1"]);
});

test("an item with no original address offers only the PURSS link", () => {
  assert.deepEqual(run(null).labels, ["Copy link to this item in your PURSS"]);
  assert.deepEqual(run("javascript:alert(1)").labels, ["Copy link to this item in your PURSS"], "an address that is not http(s) is not copied");
});
