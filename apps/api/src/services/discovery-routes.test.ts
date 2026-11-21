import assert from "node:assert/strict";
import test from "node:test";
import { DISCOVERY_ENTRIES, DISCOVERY_ROUTES, isDiscoveryEntry, isDiscoveryRoute } from "@purss/domain";
import type { DiscoveryEntry, DiscoveryRoute } from "@purss/domain";
import { BRIDGE_SERVICES } from "@purss/connectors";
import { server as copy } from "@purss/copy/server";
import type { App, Principal } from "../app.ts";
import { callTool } from "../mcp/tools.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { createDeviceToken } from "../connect/devices.ts";
import { call, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import { makeOwner, makeTestApp } from "../testing.ts";
import { generateOpml } from "./opml.ts";
import { streamExport } from "./portability.ts";
import { KEEP_DAYS, discoveryRouteStats, recordFollowed, recordOffered } from "./discovery-routes.ts";
import { adminHealth } from "./admin.ts";
import { discoverSources, followSource, presentCandidates, unfollowSource } from "./sources.ts";
import { holdCandidate } from "./discovery-cache.ts";

const follow = { collectionId: null, newCollectionName: null, markPrivate: false, fullText: false };
const DAY = 86_400_000;
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

const rows = (app: App) =>
  app.db.all<{ day: string; entry: string; route: string; offered: number; followed: number }>("SELECT day, entry, route, offered, followed FROM discovery_routes ORDER BY day, entry, route").map((r) => ({ ...r }));

/** A found feed as discovery hands it over. */
const draft = (feedUrl: string, route: DiscoveryRoute, over: Record<string, unknown> = {}) => ({
  route, feedUrl, siteUrl: "https://example.org/", title: feedUrl, kind: "feed" as const, origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null, ...over,
});

test("the routes and entries are closed lists of short, unique ids, and every bridged service has its own route", () => {
  assert.equal(new Set(DISCOVERY_ROUTES).size, DISCOVERY_ROUTES.length, "no id twice");
  assert.equal(new Set(DISCOVERY_ENTRIES).size, DISCOVERY_ENTRIES.length);
  for (const id of [...DISCOVERY_ROUTES, ...DISCOVERY_ENTRIES]) assert.match(id, /^[a-z]+(?:[-:][a-z]+)*$/, id);
  assert.ok(isDiscoveryRoute("page-list") && !isDiscoveryRoute("made-up") && !isDiscoveryRoute(null));
  assert.ok(isDiscoveryEntry("opml-import") && !isDiscoveryEntry("reconnect"), "a reconnect lookup is no entry: it follows nothing");
  assert.deepEqual(DISCOVERY_ROUTES.filter((r) => r.startsWith("bridge:")).sort(), BRIDGE_SERVICES.map((s) => `bridge:${s.id}`).sort(), "the routes name the catalogue's services, no more and no fewer");
});

test("what is shown is counted per route and entry, a reconnect lookup is not, and a count that can't be written never changes the answer", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const shown = presentCandidates(app, p, [draft("https://a.example/feed", "alternate-link"), draft("https://b.example/feed", "alternate-link"), draft("https://c.example/feed", "youtube")], { entry: "site-search" });
  assert.equal(shown.length, 3);
  presentCandidates(app, p, [draft("https://d.example/feed", "alternate-link")], { entry: "paste" });
  presentCandidates(app, p, [draft("https://e.example/feed", "alternate-link")]);
  presentCandidates(app, p, [draft("https://f.example/feed", "page-list")], { entry: "paste", count: false });
  const today = dayOf(new Date());
  assert.deepEqual(rows(app), [
    { day: today, entry: "paste", route: "alternate-link", offered: 2, followed: 0 },
    { day: today, entry: "site-search", route: "alternate-link", offered: 2, followed: 0 },
    { day: today, entry: "site-search", route: "youtube", offered: 1, followed: 0 },
  ]);

  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  app.db.exec("DROP TABLE discovery_routes");
  const again = presentCandidates(app, p, [draft("https://a.example/feed", "alternate-link")], { entry: "paste" });
  assert.equal(again.length, 1, "the person still gets the candidates");
  assert.equal(warnings.length, 1, "and the operator is told");
  assert.ok(!JSON.stringify(warnings).includes("a.example"), "without saying what was looked up");
});

test("an id outside the lists is not counted, and rows older than 180 days go when one is written", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const now = new Date("2026-11-21T12:00:00Z");
  recordOffered(app, "paste", ["made-up" as DiscoveryRoute], now);
  recordOffered(app, "typed-by-someone" as DiscoveryEntry, ["page-list"], now);
  recordFollowed(app, "paste", "nothing" as DiscoveryRoute, now);
  assert.deepEqual(rows(app), [], "the table holds only the closed lists");

  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
  recordOffered(app, "paste", ["page-list", "page-list"], at(KEEP_DAYS + 1));
  recordOffered(app, "paste", ["page-list"], at(KEEP_DAYS));
  assert.equal(rows(app).length, 2);
  recordOffered(app, "paste", ["youtube"], now);
  assert.deepEqual(rows(app).map((r) => [r.day, r.route, r.offered]), [[dayOf(at(KEEP_DAYS)), "page-list", 1], [dayOf(now), "youtube", 1]], "the day past the limit went with the write, the limit's own day stays");
});

test("following stores the route and the entry on the source and counts it; following again replaces them; unfollowing says when", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const hold = (feedUrl: string, route: DiscoveryRoute, entry: DiscoveryEntry) => {
    const [c] = presentCandidates(app, p, [draft(feedUrl, route)], { entry });
    return c!.token;
  };
  const row = (id: string) => app.db.get<{ discovery_route: string | null; discovery_entry: string | null; unfollowed_at: string | null; followed: number }>("SELECT discovery_route, discovery_entry, unfollowed_at, followed FROM sources WHERE id = ?", id)!;

  const src = followSource(app, p, { ...follow, token: hold("https://example.org/feed.xml", "conventional-path", "paste") });
  assert.deepEqual({ ...row(src.id) }, { discovery_route: "conventional-path", discovery_entry: "paste", unfollowed_at: null, followed: 1 });
  followSource(app, p, { ...follow, token: hold("https://other.example/feed.xml", "known:github", "assistant") });
  assert.deepEqual(rows(app).map((r) => [r.entry, r.route, r.offered, r.followed]), [["assistant", "known:github", 1, 1], ["paste", "conventional-path", 1, 1]]);

  unfollowSource(app, p, src.id);
  const gone = row(src.id);
  assert.equal(gone.followed, 0);
  assert.match(gone.unfollowed_at ?? "", /^\d{4}-\d\d-\d\dT/);
  // Followed again, this time through another way: the source is the same one, and now says how it was found this time.
  const again = followSource(app, p, { ...follow, token: hold("https://example.org/feed.xml", "page-anchor", "site-search") });
  assert.equal(again.id, src.id);
  assert.deepEqual({ ...row(src.id) }, { discovery_route: "page-anchor", discovery_entry: "site-search", unfollowed_at: null, followed: 1 });
  assert.deepEqual(rows(app).filter((r) => r.followed).map((r) => [r.entry, r.route, r.followed]), [["assistant", "known:github", 1], ["paste", "conventional-path", 1], ["site-search", "page-anchor", 1]]);
  // A follow of a source the person already has counts nothing more.
  followSource(app, p, { ...follow, token: hold("https://example.org/feed.xml", "page-anchor", "site-search") });
  assert.equal(rows(app).reduce((n, r) => n + r.followed, 0), 3);
});

test("a follow that is refused counts nothing, and sources made before the record or by an archive have no route", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app, { allocationBytes: null });
  // A token held for another PURSS is no token of this one's: following it is refused.
  holdCandidate("dsc_elsewhere", "wsp_other", { ...draft("https://example.org/feed.xml", "alternate-link"), entry: "paste" });
  assert.throws(() => followSource(app, p, { ...follow, token: "dsc_elsewhere" }), { message: copy.api.shared.lookupExpired });
  assert.deepEqual(rows(app), []);
  app.db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, health, created_at) VALUES ('src_old', ?, ?, 'feed', 'Old', 'RSS feed', 'ok', '2026-01-01T00:00:00.000Z')", p.accountId, p.workspaceId);
  assert.deepEqual({ ...app.db.get("SELECT discovery_route, discovery_entry, unfollowed_at FROM sources WHERE id = 'src_old'")! }, { discovery_route: null, discovery_entry: null, unfollowed_at: null });
});

test("the counts: per route and per entry, the sources followed in the window that are still followed, and those followed for a month", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const now = new Date("2026-11-21T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const counter = (daysAgo: number, entry: string, route: string, offered: number, followed: number) =>
    app.db.run("INSERT INTO discovery_routes (day, entry, route, offered, followed) VALUES (?, ?, ?, ?, ?)", dayOf(ago(daysAgo)), entry, route, offered, followed);
  counter(0, "paste", "alternate-link", 10, 4); counter(5, "paste", "alternate-link", 6, 2); counter(5, "site-search", "alternate-link", 4, 1);
  counter(89, "paste", "page-list", 3, 1); counter(90, "paste", "page-list", 100, 100); // the 91st day back is outside the window
  counter(10, "extension", "wikidata", 2, 0);
  const source = (id: string, route: string | null, entry: string | null, startedDaysAgo: number, unfollowedAfterDays: number | null) => {
    const started = ago(startedDaysAgo);
    app.db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, health, followed, created_at, discovery_route, discovery_entry, unfollowed_at) VALUES (?, ?, ?, 'feed', ?, 'RSS feed', 'ok', ?, ?, ?, ?, ?)",
      id, p.accountId, p.workspaceId, id, unfollowedAfterDays === null ? 1 : 0, started.toISOString(), route, entry, unfollowedAfterDays === null ? null : new Date(started.getTime() + unfollowedAfterDays * DAY).toISOString());
  };
  source("a-new", "alternate-link", "paste", 3, null); // too young to say anything about a month
  source("a-kept", "alternate-link", "paste", 60, null); // old and still followed
  source("a-dropped-early", "alternate-link", "paste", 50, 4); // dropped within days
  source("a-dropped-late", "alternate-link", "site-search", 70, 45); // followed for a month and a half, then dropped: it counts as kept for a month
  source("a-outside", "alternate-link", "paste", 120, null); // followed before the window
  source("p-kept", "page-list", "paste", 40, null);
  source("no-route", null, null, 40, null);

  const stats = discoveryRouteStats(app, now);
  assert.equal(stats.days, 90);
  assert.equal(stats.since, dayOf(ago(90)), "the counting is said to have started with the oldest counter");
  const route = (id: string) => stats.routes.find((r) => r.id === id);
  assert.deepEqual(route("alternate-link"), { id: "alternate-link", offered: 20, followed: 7, following: 2, aged: 3, agedStill: 2 });
  assert.deepEqual(route("page-list"), { id: "page-list", offered: 3, followed: 1, following: 1, aged: 1, agedStill: 1 }, "the counter of the 91st day back is outside");
  assert.deepEqual(route("wikidata"), { id: "wikidata", offered: 2, followed: 0, following: 0, aged: 0, agedStill: 0 });
  assert.deepEqual(stats.routes.map((r) => r.id), ["alternate-link", "page-list", "wikidata"], "most offered first, and only what has a count");
  const entry = (id: string) => stats.entries.find((r) => r.id === id);
  assert.deepEqual(entry("paste"), { id: "paste", offered: 19, followed: 7, following: 3, aged: 3, agedStill: 2 });
  assert.deepEqual(entry("site-search"), { id: "site-search", offered: 4, followed: 1, following: 0, aged: 1, agedStill: 1 });
  assert.ok(stats.unused.includes("youtube") && !stats.unused.includes("alternate-link") && !stats.unused.includes("wikidata"), "the routes with nothing at all are named");
  assert.equal(stats.unused.length, DISCOVERY_ROUTES.length - 3);
  assert.deepEqual(Object.keys(stats).sort(), ["days", "entries", "routes", "since", "unused"]);
});

test("the administrator's health holds the counts, and nothing in the counters names an account, a source, an address or a title", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const admin = makeOwner(app, { admin: true });
  const empty = (await adminHealth(app)).discoveryRoutes;
  assert.deepEqual([empty.routes, empty.entries, empty.since], [[], [], null]);
  assert.equal(empty.unused.length, DISCOVERY_ROUTES.length);

  const [c] = presentCandidates(app, admin, [draft("https://secret-name.example/feed.xml?key=sekrit", "alternate-link", { title: "A Very Private Title" })], { entry: "paste" });
  followSource(app, admin, { ...follow, token: c!.token });
  const health = await adminHealth(app);
  assert.deepEqual(health.discoveryRoutes.routes, [{ id: "alternate-link", offered: 1, followed: 1, following: 1, aged: 0, agedStill: 0 }]);
  const stored = JSON.stringify(app.db.all("SELECT * FROM discovery_routes"));
  for (const secret of ["secret-name", "sekrit", "Private Title", admin.accountId, admin.workspaceId]) assert.ok(!stored.includes(secret), `the counters don't hold ${secret}`);
  assert.deepEqual(app.db.all<{ name: string }>("SELECT name FROM pragma_table_info('discovery_routes') ORDER BY cid").map((c) => c.name), ["day", "entry", "route", "offered", "followed"]);
  assert.equal(app.db.all("SELECT 1 FROM pragma_foreign_key_list('discovery_routes')").length, 0, "no link to an account");
  assert.ok(!JSON.stringify(health.discoveryRoutes).includes(admin.accountId));
});

test("the lookup's answer to the browser and to an assistant carries neither the route nor the entry, and the assistant's lookups are counted as its own", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const news = `${app.config.publicOrigin}/news`;
  const found = await discoverSources(app, p, news, "assistant");
  assert.ok(found.ok);
  for (const c of found.candidates) {
    assert.deepEqual(Object.keys(c).filter((k) => /route|entry/i.test(k)), [], "no route or entry among the candidate's fields");
  }
  assert.ok(!/route|entry|installation-news/.test(JSON.stringify(found)), JSON.stringify(found));
  assert.deepEqual(rows(app).map((r) => [r.entry, r.route, r.offered]), [["assistant", "installation-news", 1]]);

  const tool = await callTool(app, p, "write", "tok_test", "find_sources", { url: news });
  assert.ok(tool?.ok === true, JSON.stringify(tool));
  assert.ok(!/route|entry|installation-news/i.test(JSON.stringify(tool)), JSON.stringify(tool));
  assert.deepEqual(rows(app).map((r) => [r.entry, r.route, r.offered]), [["assistant", "installation-news", 2]]);
});

test("a lookup from the browser says how the person got there; the extension's token decides for itself; an unknown entry is refused", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_TRUST_PROXY: "1" });
  const owner = makeOwner(app, { admin: false });
  const srv = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  t.after(async () => { await srv.close(); cleanup(); });
  const s = signIn(app, owner.accountId);
  const news = `${app.config.publicOrigin}/news`;
  const ask = (entry?: string) => call(app, srv.base, "POST", "/api/discover", s, { url: news, ...(entry === undefined ? {} : { entry }) }, { headers: { "x-forwarded-for": "198.51.100.7" } });
  const counted = () => rows(app).map((r) => `${r.entry}:${r.offered}`);

  assert.equal((await ask()).status, 200);
  assert.equal((await ask("site-search")).status, 200);
  assert.equal((await ask("podcast-search")).status, 200);
  assert.equal((await ask("suggestion")).status, 200);
  assert.equal((await ask("shared-link")).status, 200);
  const reconnect = await ask("reconnect");
  assert.equal(reconnect.status, 200);
  assert.ok(!/route|entry/.test(JSON.stringify(reconnect.json)), "nothing of it in the answer");
  assert.deepEqual(counted(), ["paste:1", "podcast-search:1", "shared-link:1", "site-search:1", "suggestion:1"], "a reconnect lookup follows nothing and is not counted");
  for (const refused of ["opml-import", "extension", "assistant", "Paste", ""]) assert.equal((await ask(refused)).status, 400, `${refused || "empty"}: the browser cannot name an entry the server decides`);

  const token = createDeviceToken(app, owner.accountId, "extension", "Firefox").secret;
  const viaExtension = await fetch(`${srv.base}/api/discover`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "moz-extension://abc-123", "content-type": "application/json", "x-forwarded-for": "198.51.100.8" }, body: JSON.stringify({ url: news, entry: "site-search" }) });
  assert.equal(viaExtension.status, 200);
  assert.ok(!/route|entry/.test(await viaExtension.text()));
  assert.ok(counted().includes("extension:1") && counted().includes("site-search:1"), counted().join(" "));
});

test("an export and an OPML list leave out how a source was found", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  seedLibrary(app, p);
  const [c] = presentCandidates(app, p, [draft("https://found.example/feed.xml", "known:github")], { entry: "extension" });
  followSource(app, p, { ...follow, token: c!.token });
  const parts: string[] = [];
  await streamExport(app, p, (chunk) => { parts.push(chunk); });
  const archive = parts.join("");
  assert.ok(archive.includes("found.example"), "the source itself is exported");
  for (const word of ["discovery_route", "discovery_entry", "unfollowed_at", "discoveryRoute", "known:github", "\"extension\""]) assert.ok(!archive.includes(word), `${word} is not in the archive`);
  const opml = generateOpml(app, p).xml;
  assert.ok(opml.includes("found.example"));
  for (const word of ["known:github", "extension", "discovery"]) assert.ok(!opml.includes(word), `${word} is not in the OPML`);
});
