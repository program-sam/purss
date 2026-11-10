import assert from "node:assert/strict";
import { test } from "node:test";
import { neutraliseLinks } from "./preview-html.ts";

test("anchors lose their address, other tags are untouched", () => {
  const html = `<link rel="alternate" href="https://x.example/feed.atom"><p><a href="https://a.example/1" rel="noopener">One</a> <a class="k" HREF='https://b.example/2'>Two</a> <abbr title="t">x</abbr></p>`;
  assert.equal(
    neutraliseLinks(html),
    `<link rel="alternate" href="https://x.example/feed.atom"><p><a data-href="https://a.example/1" rel="noopener">One</a> <a class="k" data-href='https://b.example/2'>Two</a> <abbr title="t">x</abbr></p>`,
  );
});

test("a page with no links is returned as it was", () => {
  assert.equal(neutraliseLinks("<p>Nothing here yet.</p>"), "<p>Nothing here yet.</p>");
});
