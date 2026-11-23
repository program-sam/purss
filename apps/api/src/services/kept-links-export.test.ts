import test from "node:test";
import assert from "node:assert/strict";
import { server } from "@purss/translations/server";
import { escapeRegExp, inHtml } from "../translations-testing.ts";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { createBasket } from "./collections.ts";
import { listItems } from "./items.ts";
import { keptLinksChunks } from "./kept-links-export.ts";
import { keepLink } from "./links.ts";
import { keepItem } from "./state.ts";
import { applySyncBatch } from "./sync.ts";

const NOW = new Date("2026-11-05T10:00:00Z");
const { keptLinksExport } = server.api;
/** The catalogue's "kept <date>" and "published <date>" as the page and the list write them, for a regular expression (the kept date is the day the test ran). */
const KEPT = escapeRegExp(inHtml(keptLinksExport.kept("\u0000"))).replace("\u0000", String.raw`\d{4}-\d{2}-\d{2}`);
const PUBLISHED = escapeRegExp(inHtml(keptLinksExport.published("2026-10-01")));

async function fixture() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Quiet Harbour", "feed/1");
  applySyncBatch(app, p.engineUserId, batch([
    entry("feed/1", { title: "Tides & <i>currents</i>", url: "https://example.org/tides?a=1&b=2", publishedAt: "2026-10-01T08:00:00Z" }),
    entry("feed/1", { title: "مقال عن البحر", url: "https://example.org/sea (1)" }),
    entry("feed/1", { title: "Unkept", url: "https://example.org/unkept" }),
  ]));
  const items = listItems(app, p, { scope: "all" }).items;
  const read = createBasket(app, p, { name: "To read <later>", captureMode: "metadata" });
  const empty = createBasket(app, p, { name: "Empty one", captureMode: "metadata" });
  keepItem(app, p, items.find((i) => i.title.startsWith("Tides"))!.id, read.id);
  keepItem(app, p, items.find((i) => i.title === "مقال عن البحر")!.id, read.id);
  const typed = await keepLink(app, p, { url: "https://example.org/essay", basketId: read.id }, async () => ({ kind: "link", title: "An essay", siteName: "Example Times", author: null, imageUrl: null }));
  await keepLink(app, p, { url: "https://example.org/x", basketId: read.id, title: "Hand-titled" }, async () => null);
  return { app, p, read, empty, typed, cleanup };
}

test("the HTML list names every basket, links each kept item to its original and says what it is", async (t) => {
  const { app, p, cleanup } = await fixture();
  t.after(cleanup);
  const html = [...keptLinksChunks(app, p, "html", NOW)].join("");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.ok(html.includes(`<h1>${keptLinksExport.heading}</h1>`));
  assert.ok(html.includes(`${keptLinksExport.exported("2026-11-05")} ${inHtml(keptLinksExport.note)}`));
  assert.match(html, /<h2 dir="auto">To read &lt;later&gt;<\/h2>/, "basket names are escaped");
  assert.match(html, new RegExp(String.raw`<a dir="auto" href="https://example\.org/tides\?a=1&amp;b=2" rel="noopener noreferrer">Tides &amp; currents</a> <span class="meta" dir="auto">Quiet Harbour, A\. Writer · ${PUBLISHED} · ${KEPT}</span>`));
  assert.match(html, /<a dir="auto" href="https:\/\/example\.org\/sea%20\(1\)" rel="noopener noreferrer">مقال عن البحر<\/a>/, "Arabic titles keep their direction");
  assert.match(html, new RegExp(String.raw`>An essay</a> <span class="meta" dir="auto">Example Times · ${KEPT}`));
  assert.match(html, />Hand-titled<\/a>/);
  assert.ok(html.includes(`<h2 dir="auto">Empty one</h2>\n${keptLinksExport.nothingKeptHtml}`));
  assert.doesNotMatch(html, /Unkept|<script|javascript:/);
  assert.equal((html.match(/<ul>/g) ?? []).length, 1);
  assert.equal((html.match(/<\/ul>/g) ?? []).length, 1);
  assert.match(html, /<\/html>\n$/);
});

test("a title or address cannot break out of the page, and only web addresses become links", async (t) => {
  const { app, p, read, cleanup } = await fixture();
  t.after(cleanup);
  const sneaky = app.db.get<{ id: string }>("SELECT id FROM items WHERE title = 'Hand-titled'")!.id;
  app.db.run("UPDATE items SET title = ?, url = ? WHERE id = ?", `"><script>alert(1)</script>`, "javascript:alert(1)", sneaky);
  void read;
  const html = [...keptLinksChunks(app, p, "html", NOW)].join("");
  assert.doesNotMatch(html, /<script>|href="javascript/);
  assert.match(html, /<span dir="auto">&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
});

test("the Markdown list has the same content, escaped for Markdown", async (t) => {
  const { app, p, cleanup } = await fixture();
  t.after(cleanup);
  const md = [...keptLinksChunks(app, p, "md", NOW)].join("");
  assert.ok(md.startsWith(`# ${keptLinksExport.heading}\n\n${keptLinksExport.exported("2026-11-05")} `));
  assert.match(md, /\n## To read \\<later\\>\n\n/);
  assert.match(md, new RegExp(String.raw`- \[Tides & currents\]\(https://example\.org/tides\?a=1&b=2\) — Quiet Harbour, A\. Writer, ${escapeRegExp(keptLinksExport.published("2026-10-01"))}, ${escapeRegExp(keptLinksExport.kept("\u0000")).replace("\u0000", String.raw`\d{4}-\d{2}-\d{2}`)}\n`));
  assert.match(md, /\(https:\/\/example\.org\/sea%20%281%29\)/, "spaces and parentheses cannot end the link early");
  assert.ok(md.includes(`\n## Empty one\n\n${keptLinksExport.nothingKeptMarkdown}`));
  assert.doesNotMatch(md, /Unkept/);
});

test("a long list is produced in pages without losing or repeating anything, and only the account's own baskets appear", async (t) => {
  const { app, p, read, cleanup } = await fixture();
  t.after(cleanup);
  const small = [...keptLinksChunks(app, p, "html", NOW, 2)].join("");
  const whole = [...keptLinksChunks(app, p, "html", NOW)].join("");
  assert.equal(small, whole, "page size changes nothing");
  assert.equal((whole.match(/<li>/g) ?? []).length, 4);
  void read;
  const other = makeOwner(app);
  createBasket(app, other, { name: "Someone else's secret basket", captureMode: "metadata" });
  assert.doesNotMatch([...keptLinksChunks(app, p, "html", NOW)].join(""), /secret basket/);
  assert.doesNotMatch([...keptLinksChunks(app, other, "md", NOW)].join(""), /Tides|To read/);
});

test("a private source's file address, which can carry its secret, is left out of both lists", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  makeSource(app, p, "Members feed", "feed/9", { isPrivate: true });
  const file = "https://cdn.example.org/play?id=7&token=SECRET";
  applySyncBatch(app, p.engineUserId, batch([entry("feed/9", { title: "Members episode", url: file, enclosures: [{ url: file, type: "audio/mpeg", length: 10 }] })]));
  const b = createBasket(app, p, { name: "Kept", captureMode: "metadata" });
  keepItem(app, p, listItems(app, p, { scope: "all" }).items[0]!.id, b.id);
  for (const format of ["html", "md"] as const) {
    const out = [...keptLinksChunks(app, p, format, NOW)].join("");
    assert.ok(out.includes("Members episode"), `${format}: the item is listed`);
    assert.ok(!out.includes("SECRET"), `${format}: its file address is not`);
  }
});
