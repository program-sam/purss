import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CatalogResponse } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { extraRouters } from "../routes/index.ts";
import { publicRouter } from "../routes/public.ts";
import { OVERVIEW_PER_CATEGORY, catalogNamed } from "./discover-catalog.ts";

type Row = { feed_url: string; title: string; site_url?: string | null; category: string; kind?: string; language?: string; description?: string | null; weight: number; image_url?: string | null };

/** A catalog file in the layout the hosted service puts on its server, with a table the API never reads beside it. */
function writeCatalog(file: string, rows: Row[]): void {
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS metrics;
    CREATE TABLE sources (feed_url TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
      language TEXT NOT NULL, description TEXT, weight REAL NOT NULL, image_url TEXT);
    CREATE TABLE metrics (feed_url TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, source TEXT)`);
  const put = db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) put.run(r.feed_url, r.title, r.site_url ?? null, r.category, r.kind ?? "feed", r.language ?? "en", r.description ?? null, r.weight, r.image_url ?? null);
  db.close();
}

type Boot = { app: App; server: { base: string; close: () => Promise<void> }; close: () => Promise<void> };
async function boot(mode: "hosted" | "self" = "hosted"): Promise<Boot> {
  const { app, cleanup } = makeTestApp(mode === "hosted" ? { PURSS_MODE: "hosted" } : {});
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return { app, server, close: async () => { await server.close(); cleanup(); } };
}
const get = async (b: Boot, p: Principal, path = "/api/suggestions/catalog") => call(b.app, b.server.base, "GET", path, signIn(b.app, p.accountId));
let stream = 0;
const follow = (app: App, p: Principal, feedUrl: string) => {
  const id = makeSource(app, p, `Title ${stream}`, `c${stream++}`);
  app.db.run("UPDATE sources SET feed_url = ? WHERE id = ?", feedUrl, id);
  return id;
};

const rows: Row[] = [
  { feed_url: "https://www.theverge.com/rss/index.xml", title: "The Verge", site_url: "https://www.theverge.com", category: "technology", weight: 14.2, description: "Technology news" },
  { feed_url: "https://techcrunch.com/feed/", title: "TechCrunch", site_url: "https://techcrunch.com", category: "technology", weight: 14.1 },
  { feed_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc", title: "Some Channel", category: "technology", kind: "youtube", weight: 9, image_url: "https://img.example/channel.jpg" },
  { feed_url: "https://feeds.example/show.xml", title: "A Show", category: "technology", kind: "podcast", weight: 8, image_url: "https://img.example/show.jpg" },
  { feed_url: "https://feeds.example/plain.xml", title: "Plain Show", category: "technology", kind: "podcast", weight: 7, image_url: "http://img.example/plain.jpg" },
  { feed_url: "https://feeds.bbci.co.uk/news/rss.xml", title: "BBC News", site_url: "https://www.bbc.co.uk/news", category: "news", weight: 13 },
  { feed_url: "https://www.nu.nl/rss", title: "NU.nl", category: "news", language: "nl", weight: 12 },
  { feed_url: "https://bad.example/feed", title: "Unknown topic", category: "knitting", weight: 20 },
  { feed_url: "https://bad.example/kind", title: "Odd kind", category: "news", kind: "newsletter", weight: 20 },
  { feed_url: "http://techcrunch.com/feed", title: "TechCrunch again", category: "business", weight: 1 },
];

test("Discovery's catalog lists each category's popular sources, most popular first, in English only, without what the reader has", async (t) => {
  const b = await boot();
  t.after(b.close);
  const reader = makeOwner(b.app, { admin: false });
  const before = await get(b, reader);
  assert.equal(before.status, 200, before.text);
  assert.deepEqual((before.json as CatalogResponse).categories, [], "no catalog file: no categories");

  writeCatalog(b.app.config.catalogFile, rows);
  const all = (await get(b, reader)).json as CatalogResponse;
  assert.deepEqual(all.categories.map((c) => [c.id, c.total, c.sources.map((s) => s.title)]), [
    ["news", 1, ["BBC News"]],
    ["technology", 5, ["The Verge", "TechCrunch", "Some Channel", "A Show", "Plain Show"]],
  ], "other languages, unknown categories and kinds, and a second address of one feed are left out");
  const [verge, , channel, show, plain] = all.categories[1]!.sources;
  const { hueFor } = await import("./content.ts");
  assert.deepEqual(verge, { key: "www.theverge.com/rss/index.xml", title: "The Verge", host: "theverge.com", feedUrl: "https://www.theverge.com/rss/index.xml", kind: "feed", description: "Technology news", weight: 14.2, imageUrl: null, hue: hueFor("The Verge"), initials: "TV" });
  assert.equal(show!.imageUrl, "https://img.example/show.jpg", "a podcast shows its artwork");
  assert.equal(plain!.imageUrl, null, "only over https");
  assert.equal(channel!.imageUrl, null, "only a podcast's");

  // What the reader has, followed now, once, or privately, is left out.
  follow(b.app, reader, "http://www.theverge.com/rss/index.xml?utm_source=x");
  b.app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", follow(b.app, reader, "https://techcrunch.com/feed/"));
  const { privateFeedKey } = await import("./feed-keys.ts");
  const secret = makeSource(b.app, reader, "Mine", "secret", { isPrivate: true });
  b.app.db.run("UPDATE sources SET feed_key = ? WHERE id = ?", privateFeedKey(b.app, reader.workspaceId, "https://feeds.bbci.co.uk/news/rss.xml"), secret);
  const mine = (await get(b, reader)).json as CatalogResponse;
  assert.deepEqual(mine.categories.map((c) => [c.id, c.total, c.sources.map((s) => s.title)]), [["technology", 3, ["Some Channel", "A Show", "Plain Show"]]], "a category with nothing left is left out");

  // One category's page has all of them; an unknown category is not found.
  const many = Array.from({ length: OVERVIEW_PER_CATEGORY + 5 }, (_, i) => ({ feed_url: `https://s${i}.example/feed`, title: `Site ${i}`, category: "food", weight: 100 - i }));
  writeCatalog(b.app.config.catalogFile, many);
  // The file is read again once it changes on disk.
  utimesSync(b.app.config.catalogFile, new Date(), new Date(Date.now() + 5_000));
  const overview = (await get(b, reader)).json as CatalogResponse;
  assert.equal(overview.categories[0]!.total, OVERVIEW_PER_CATEGORY + 5);
  assert.equal(overview.categories[0]!.sources.length, OVERVIEW_PER_CATEGORY);
  const page = (await get(b, reader, "/api/suggestions/catalog/food")).json as CatalogResponse;
  assert.equal(page.categories[0]!.sources.length, OVERVIEW_PER_CATEGORY + 5);
  assert.deepEqual(((await get(b, reader, "/api/suggestions/catalog/sports")).json as CatalogResponse).categories, []);
  assert.equal((await get(b, reader, "/api/suggestions/catalog/knitting")).status, 404);
});

test("a name search lists the catalog's sources after the readers' and before Wikidata's", async (t) => {
  const { resetSiteSearchCache, searchSiteDirectory } = await import("./sources.ts");
  resetSiteSearchCache();
  t.after(resetSiteSearchCache);
  const b = await boot();
  t.after(b.close);
  writeCatalog(b.app.config.catalogFile, rows);
  const reader = makeOwner(b.app, { admin: false });
  assert.deepEqual(catalogNamed(b.app, "verge").map((h) => [h.name, h.address, h.site, h.from]), [["The Verge", "https://www.theverge.com/rss/index.xml", "theverge.com", "catalog"]]);
  assert.deepEqual(catalogNamed(b.app, "techcrunch.com").map((h) => h.name), ["TechCrunch"], "by site too");
  assert.deepEqual(catalogNamed(b.app, "nu"), [], "only English sources");
  const down = async (url: string) => ({ ok: true as const, response: { url, requestedUrl: url, redirects: [], status: 503, headers: { "content-type": "text/html" }, mediaType: "text/html", contentType: "text/html", body: Buffer.from("busy"), bytes: 4, truncated: false, remoteAddress: "93.184.216.34", fetchedAt: new Date().toISOString() } });
  const out = await searchSiteDirectory(b.app, reader, "the verge", { fetch: down });
  assert.ok(out.ok, "Wikidata failing still shows the catalog's sources");
  assert.deepEqual(out.hits.map((h) => h.from), ["catalog"]);

});

test("a self-hosted installation shows a catalog its administrator put there, and none without one; a broken file counts as none", async (t) => {
  const b = await boot("self");
  t.after(b.close);
  const reader = makeOwner(b.app, { admin: false });
  const session = async () => (await call(b.app, b.server.base, "GET", "/api/session", signIn(b.app, reader.accountId))).json as { installation: { catalog: boolean } };
  assert.equal((await session()).installation.catalog, false);
  assert.deepEqual(((await get(b, reader)).json as CatalogResponse).categories, []);
  assert.equal((await call(b.app, b.server.base, "GET", "/api/suggestions", signIn(b.app, reader.accountId))).status, 404, "suggestions stay hosted only");

  writeCatalog(b.app.config.catalogFile, rows);
  assert.equal((await session()).installation.catalog, true);
  assert.deepEqual(((await get(b, reader, "/api/suggestions/catalog/news")).json as CatalogResponse).categories.map((c) => c.sources.map((s) => s.title)), [["BBC News"]]);
  assert.deepEqual(catalogNamed(b.app, "verge").map((h) => h.name), ["The Verge"]);

  // Not a catalog (a table missing, then not a database at all): left out, and the rest of PURSS carries on.
  const db = new DatabaseSync(b.app.config.catalogFile);
  db.exec("DROP TABLE sources");
  db.close();
  utimesSync(b.app.config.catalogFile, new Date(), new Date(Date.now() + 10_000));
  assert.equal((await session()).installation.catalog, false);
  writeFileSync(b.app.config.catalogFile, "not sqlite");
  utimesSync(b.app.config.catalogFile, new Date(), new Date(Date.now() + 20_000));
  assert.equal((await get(b, reader)).status, 200);
  assert.deepEqual(((await get(b, reader)).json as CatalogResponse).categories, []);

  // A catalog without the optional image column still works.
  unlinkSync(b.app.config.catalogFile);
  const old = new DatabaseSync(b.app.config.catalogFile);
  old.exec(`CREATE TABLE sources (feed_url TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
    language TEXT NOT NULL, description TEXT, weight REAL NOT NULL); INSERT INTO sources VALUES ('https://feeds.example/p.xml', 'Pod', NULL, 'news', 'podcast', 'en', NULL, 3)`);
  old.close();
  assert.deepEqual(((await get(b, reader)).json as CatalogResponse).categories.map((c) => c.sources.map((s) => [s.title, s.imageUrl])), [[["Pod", null]]]);
});
