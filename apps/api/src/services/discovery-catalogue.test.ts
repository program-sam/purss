import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CatalogueResponse } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { extraRouters } from "../routes/index.ts";
import { publicRouter } from "../routes/public.ts";
import { OVERVIEW_PER_CATEGORY, byChance, catalogueNamed } from "./discovery-catalogue.ts";

type Row = { feed_url: string; title: string; site_url?: string | null; category: string; kind?: string; language?: string; description?: string | null; weight: number; icon?: Uint8Array | null };

/** Bytes that pass as a stored WebP icon. */
const webp = (tag: string) => Buffer.concat([Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.from(tag)]);

/** A catalogue file in the layout the hosted service puts on its server, with a table the API never reads beside it. */
function writeCatalogue(file: string, rows: Row[]): void {
  const db = new DatabaseSync(file);
  db.exec(`DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS metrics;
    CREATE TABLE sources (feed_url TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
      language TEXT NOT NULL, description TEXT, weight REAL NOT NULL, icon BLOB);
    CREATE TABLE metrics (feed_url TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, source TEXT)`);
  const put = db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) put.run(r.feed_url, r.title, r.site_url ?? null, r.category, r.kind ?? "feed", r.language ?? "en", r.description ?? null, r.weight, r.icon ?? null);
  db.close();
}

type Boot = { app: App; server: { base: string; close: () => Promise<void> }; close: () => Promise<void> };
async function boot(mode: "hosted" | "self" = "hosted"): Promise<Boot> {
  const { app, cleanup } = makeTestApp(mode === "hosted" ? { PURSS_MODE: "hosted" } : {});
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  return { app, server, close: async () => { await server.close(); cleanup(); } };
}
const get = async (b: Boot, p: Principal, path = "/api/suggestions/catalogue") => call(b.app, b.server.base, "GET", path, signIn(b.app, p.accountId));
let stream = 0;
const follow = (app: App, p: Principal, feedUrl: string) => {
  const id = makeSource(app, p, `Title ${stream}`, `c${stream++}`);
  app.db.run("UPDATE sources SET feed_url = ? WHERE id = ?", feedUrl, id);
  return id;
};

const rows: Row[] = [
  { feed_url: "https://www.theverge.com/rss/index.xml", title: "The Verge", site_url: "https://www.theverge.com", category: "technology", weight: 14.2, description: "Technology news" },
  { feed_url: "https://techcrunch.com/feed/", title: "TechCrunch", site_url: "https://techcrunch.com", category: "technology", weight: 14.1 },
  { feed_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc", title: "Some Channel", category: "technology", kind: "youtube", weight: 9, icon: webp("channel") },
  { feed_url: "https://feeds.example/show.xml", title: "A Show", category: "technology", kind: "podcast", weight: 8, icon: webp("show") },
  { feed_url: "https://feeds.example/plain.xml", title: "Plain Show", category: "technology", kind: "podcast", weight: 7, icon: Buffer.from("\x89PNG\r\n\x1a\n-not-webp", "latin1") },
  { feed_url: "https://feeds.bbci.co.uk/news/rss.xml", title: "BBC News", site_url: "https://www.bbc.co.uk/news", category: "news", weight: 13 },
  { feed_url: "https://www.nu.nl/rss", title: "NU.nl", category: "news", language: "nl", weight: 12 },
  { feed_url: "https://bad.example/feed", title: "Unknown topic", category: "knitting", weight: 20 },
  { feed_url: "https://bad.example/kind", title: "Odd kind", category: "news", kind: "newsletter", weight: 20 },
  { feed_url: "http://techcrunch.com/feed", title: "TechCrunch again", category: "business", weight: 1 },
];

test("Discovery's catalogue lists each category's popular sources, most popular first, in English only, without what the reader has", async (t) => {
  const b = await boot();
  t.after(b.close);
  const reader = makeOwner(b.app, { admin: false });
  const before = await get(b, reader);
  assert.equal(before.status, 200, before.text);
  assert.deepEqual((before.json as CatalogueResponse).categories, [], "no catalogue file: no categories");

  writeCatalogue(b.app.config.catalogueFile, rows);
  const all = (await get(b, reader)).json as CatalogueResponse;
  assert.deepEqual(all.categories.map((c) => [c.id, c.total, c.sources.map((s) => s.title).sort()]), [
    ["news", 1, ["BBC News"]],
    ["technology", 5, ["A Show", "Plain Show", "Some Channel", "TechCrunch", "The Verge"]],
  ], "other languages, unknown categories and kinds, and a second address of one feed are left out");
  const named = (title: string) => all.categories[1]!.sources.find((s) => s.title === title)!;
  const [verge, channel, show, plain] = [named("The Verge"), named("Some Channel"), named("A Show"), named("Plain Show")];
  const raw = (await get(b, reader)).text;
  assert.doesNotMatch(raw, /weight|subscribers|popularity|14\.2/i, "no popularity figure reaches the browser");
  const { hueFor } = await import("./content.ts");
  assert.deepEqual(verge, { key: "www.theverge.com/rss/index.xml", title: "The Verge", host: "theverge.com", feedUrl: "https://www.theverge.com/rss/index.xml", kind: "feed", description: "Technology news", iconUrl: null, hue: hueFor("The Verge"), initials: "TV" });
  assert.match(show!.iconUrl ?? "", /^\/api\/suggestions\/catalogue\/icons\/[0-9a-f]{32}$/, "a source with an icon has it served here");
  assert.notEqual(channel!.iconUrl, show!.iconUrl);
  assert.equal(plain!.iconUrl, null, "only a WebP counts as an icon");
  // The icon itself, read from the file, cached by its digest; an unknown digest is not found.
  const icon = await call(b.app, b.server.base, "GET", show!.iconUrl!, signIn(b.app, reader.accountId));
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/webp");
  assert.match(icon.headers.get("cache-control") ?? "", /immutable/);
  assert.ok(icon.text.endsWith("show"));
  assert.equal((await call(b.app, b.server.base, "GET", "/api/suggestions/catalogue/icons/0123456789abcdef0123456789abcdef", signIn(b.app, reader.accountId))).status, 404);
  assert.equal((await call(b.app, b.server.base, "GET", show!.iconUrl!, null)).status, 401, "signed-in readers only");

  // What the reader has, followed now, once, or privately, is left out.
  follow(b.app, reader, "http://www.theverge.com/rss/index.xml?utm_source=x");
  b.app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", follow(b.app, reader, "https://techcrunch.com/feed/"));
  const { privateFeedKey } = await import("./source-identity.ts");
  const secret = makeSource(b.app, reader, "Mine", "secret", { isPrivate: true });
  b.app.db.run("UPDATE sources SET feed_key = ? WHERE id = ?", privateFeedKey(b.app, reader.accountId, "https://feeds.bbci.co.uk/news/rss.xml"), secret);
  const mine = (await get(b, reader)).json as CatalogueResponse;
  assert.deepEqual(mine.categories.map((c) => [c.id, c.total, c.sources.map((s) => s.title).sort()]), [["technology", 3, ["A Show", "Plain Show", "Some Channel"]]], "a category with nothing left is left out");

  // One category's page has all of them; an unknown category is not found.
  const many = Array.from({ length: OVERVIEW_PER_CATEGORY + 5 }, (_, i) => ({ feed_url: `https://s${i}.example/feed`, title: `Site ${i}`, category: "food", weight: 100 - i }));
  writeCatalogue(b.app.config.catalogueFile, many);
  // The file is read again once it changes on disk.
  utimesSync(b.app.config.catalogueFile, new Date(), new Date(Date.now() + 5_000));
  const overview = (await get(b, reader)).json as CatalogueResponse;
  assert.equal(overview.categories[0]!.total, OVERVIEW_PER_CATEGORY + 5);
  assert.equal(overview.categories[0]!.sources.length, OVERVIEW_PER_CATEGORY);
  const page = (await get(b, reader, "/api/suggestions/catalogue/food")).json as CatalogueResponse;
  assert.equal(page.categories[0]!.sources.length, OVERVIEW_PER_CATEGORY + 5);
  assert.deepEqual(((await get(b, reader, "/api/suggestions/catalogue/sports")).json as CatalogueResponse).categories, []);
  assert.equal((await get(b, reader, "/api/suggestions/catalogue/knitting")).status, 404);
});

test("popular sources come in a different order each time, yet the most popular usually come first", () => {
  const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) + 0.5) / 2 ** 31;
  const list = Array.from({ length: 30 }, (_, i) => ({ id: i, weight: 14 - i * 0.4 }));
  const a = byChance(list, seeded(1)).map((s) => s.id);
  assert.notDeepEqual(a, byChance(list, seeded(2)).map((s) => s.id), "chance changes the order");
  assert.deepEqual([...a].sort((x, y) => x - y), list.map((s) => s.id), "nothing lost or doubled");
  let topSix = 0;
  for (let seed = 1; seed <= 200; seed++) topSix += byChance(list, seeded(seed)).slice(0, 6).filter((s) => s.id < 6).length;
  assert.ok(topSix / 200 > 3, `on average more than half of a box is the six most popular (${topSix / 200})`);
});

test("a name search lists the catalogue's sources after the readers' and before Wikidata's", async (t) => {
  const { resetSiteSearchCache, searchSiteDirectory } = await import("./sources.ts");
  resetSiteSearchCache();
  t.after(resetSiteSearchCache);
  const b = await boot();
  t.after(b.close);
  writeCatalogue(b.app.config.catalogueFile, rows);
  const reader = makeOwner(b.app, { admin: false });
  assert.deepEqual(catalogueNamed(b.app, "verge").map((h) => [h.name, h.address, h.site, h.from]), [["The Verge", "https://www.theverge.com/rss/index.xml", "theverge.com", "catalogue"]]);
  assert.deepEqual(catalogueNamed(b.app, "techcrunch.com").map((h) => h.name), ["TechCrunch"], "by site too");
  assert.deepEqual(catalogueNamed(b.app, "nu"), [], "only English sources");
  const down = async (url: string) => ({ ok: true as const, response: { url, requestedUrl: url, redirects: [], status: 503, headers: { "content-type": "text/html" }, mediaType: "text/html", contentType: "text/html", body: Buffer.from("busy"), bytes: 4, truncated: false, remoteAddress: "93.184.216.34", fetchedAt: new Date().toISOString() } });
  const out = await searchSiteDirectory(b.app, reader, "the verge", { fetch: down });
  assert.ok(out.ok, "Wikidata failing still shows the catalogue's sources");
  assert.deepEqual(out.hits.map((h) => h.from), ["catalogue"]);

});

test("a self-hosted installation shows a catalogue its administrator put there, and none without one; a broken file counts as none", async (t) => {
  const b = await boot("self");
  t.after(b.close);
  const reader = makeOwner(b.app, { admin: false });
  const session = async () => (await call(b.app, b.server.base, "GET", "/api/session", signIn(b.app, reader.accountId))).json as { installation: { catalogue: boolean } };
  assert.equal((await session()).installation.catalogue, false);
  assert.deepEqual(((await get(b, reader)).json as CatalogueResponse).categories, []);
  assert.equal((await call(b.app, b.server.base, "GET", "/api/suggestions", signIn(b.app, reader.accountId))).status, 404, "suggestions stay hosted only");

  writeCatalogue(b.app.config.catalogueFile, rows);
  assert.equal((await session()).installation.catalogue, true);
  assert.deepEqual(((await get(b, reader, "/api/suggestions/catalogue/news")).json as CatalogueResponse).categories.map((c) => c.sources.map((s) => s.title)), [["BBC News"]]);
  assert.deepEqual(catalogueNamed(b.app, "verge").map((h) => h.name), ["The Verge"]);

  // Not a catalogue (a table missing, then not a database at all): left out, and the rest of PURSS carries on.
  const db = new DatabaseSync(b.app.config.catalogueFile);
  db.exec("DROP TABLE sources");
  db.close();
  utimesSync(b.app.config.catalogueFile, new Date(), new Date(Date.now() + 10_000));
  assert.equal((await session()).installation.catalogue, false);
  writeFileSync(b.app.config.catalogueFile, "not sqlite");
  utimesSync(b.app.config.catalogueFile, new Date(), new Date(Date.now() + 20_000));
  assert.equal((await get(b, reader)).status, 200);
  assert.deepEqual(((await get(b, reader)).json as CatalogueResponse).categories, []);

  // A catalogue without the optional icon column still works.
  unlinkSync(b.app.config.catalogueFile);
  const old = new DatabaseSync(b.app.config.catalogueFile);
  old.exec(`CREATE TABLE sources (feed_url TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT, category TEXT NOT NULL, kind TEXT NOT NULL,
    language TEXT NOT NULL, description TEXT, weight REAL NOT NULL); INSERT INTO sources VALUES ('https://feeds.example/p.xml', 'Pod', NULL, 'news', 'podcast', 'en', NULL, 3)`);
  old.close();
  assert.deepEqual(((await get(b, reader)).json as CatalogueResponse).categories.map((c) => c.sources.map((s) => [s.title, s.iconUrl])), [[["Pod", null]]]);
});
