import assert from "node:assert/strict";
import test from "node:test";
import { makeOwner, makeTestApp } from "../testing.ts";
import { discoverSources } from "./sources.ts";
import { KEEP_DAYS, MISS_REASONS, recordDiscoveryMiss, registrableDomain, siteOfPasted, topDiscoveryMisses } from "./discovery-misses.ts";

const rows = (app: ReturnType<typeof makeTestApp>["app"]) =>
  app.db.all<{ day: string; site: string; reason: string; count: number }>("SELECT day, site, reason, count FROM discovery_misses ORDER BY day, site, reason").map((r) => ({ ...r }));

test("the site is the registrable domain: two labels, three under a country code's second-level label, lower-case, no www", () => {
  const cases: [string, string | null][] = [
    ["https://example.com/some/path?x=1#y", "example.com"],
    ["https://WWW.Example.COM", "example.com"],
    ["example.com", "example.com"],
    ["//example.com/feed", "example.com"],
    ["http://blog.deep.example.org:8080/a", "example.org"],
    // a subdomain-per-creator site counts as the site, never as the creator
    ["https://nilsfrahm.bandcamp.com/album/spaces", "bandcamp.com"],
    ["https://someone.substack.com", "substack.com"],
    // country-code second-level labels keep three
    ["https://www.bbc.co.uk/news", "bbc.co.uk"],
    ["https://feeds.bbc.co.uk/news/rss.xml", "bbc.co.uk"],
    ["https://example.com.au/", "example.com.au"],
    ["https://x.example.org.nz", "example.org.nz"],
    ["https://news.example.ac.uk", "example.ac.uk"],
    ["https://a.example.gov.uk", "example.gov.uk"],
    ["https://a.example.edu.au", "example.edu.au"],
    ["https://www.nhk.or.jp/rss", "nhk.or.jp"],
    ["https://foo.example.ne.jp", "example.ne.jp"],
    // only under a two-letter code, and only for those labels
    ["https://blog.example.co.com", "co.com"],
    ["https://blog.example.com.org", "com.org"],
    ["https://foo.bar.co.de", "bar.co.de"], // any two-letter code takes the labels in the list
    ["https://blog.example.co", "example.co"],
    ["https://co.uk", "co.uk"],
    // pasted as people paste: quotes, brackets, trailing punctuation, feed schemes, host:port
    ["<https://www.example.com/feed>", "example.com"],
    ["(https://example.com/feed).", "example.com"],
    ["feed://example.com/rss", "example.com"],
    ["feed:https://blog.example.com/rss", "example.com"],
    ["example.com:8443/feed", "example.com"],
    ["https://user:secret@example.com/private?token=abc", "example.com"],
    ["https://bücher.example/feed", "xn--bcher-kva.example"],
    ["https://example.com./", "example.com"],
    // handles: the server, or the handle's own domain
    ["@alice@Mastodon.Social", "mastodon.social"],
    ["alice@fosstodon.org", "fosstodon.org"],
    ["acct:alice@hachyderm.io", "hachyderm.io"],
    ["@alice.bsky.social", "bsky.social"],
    ["@alice.example.co.uk", "example.co.uk"],
    ["https://mastodon.social/@alice", "mastodon.social"],
    ["https://bsky.app/profile/alice.bsky.social", "bsky.app"],
    // not an address: nothing at all
    ["", null], ["   ", null], ["durov", null], ["@durov", null], ["localhost", null], ["http://localhost:8080/x", null], ["intranet/feed", null],
    ["Nils Frahm", null], ["https://example.com/a https://example.org/b", null],
    ["http://192.168.1.10/feed", null], ["https://8.8.8.8/", null], ["http://[::1]:8080/", null], ["http://[2001:db8::1]/feed", null],
    ["mailto:someone@example.com", null], ["javascript:alert(1)", null], ["ftp://example.com/feed", null], ["data:text/html,hi", null],
    ["bridge:telegram/durov", null], ["https://exa_mple.com", null], ["https://example.123", null],
    [`https://${"a".repeat(64)}.com`, null], [`https://example.com/${"x".repeat(2100)}`, null],
  ];
  for (const [pasted, site] of cases) assert.equal(siteOfPasted(pasted), site, JSON.stringify(pasted.slice(0, 80)));
  assert.equal(registrableDomain("www.com"), "www.com");
  assert.equal(registrableDomain("WWW.Example.Com"), "example.com");
});

test("a failed lookup counts once per day, site and reason, and stores nothing but those", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const at = new Date("2026-11-07T23:59:59.000Z");
  recordDiscoveryMiss(app, "https://nilsfrahm.bandcamp.com/album/spaces?secret=KEY123", "nofeed", at);
  recordDiscoveryMiss(app, "https://www.bandcamp.com/", "nofeed", at);
  recordDiscoveryMiss(app, "https://other.bandcamp.com/track/x", "unreachable", at);
  recordDiscoveryMiss(app, "https://example.com/feed", "timeout", at);
  recordDiscoveryMiss(app, "https://example.com/other", "unsupported", at);
  recordDiscoveryMiss(app, "https://example.com/third", "unsupported", new Date("2026-11-08T00:00:00.000Z")); // the next UTC day
  assert.deepEqual(rows(app), [
    { day: "2026-11-07", site: "bandcamp.com", reason: "nofeed", count: 2 },
    { day: "2026-11-07", site: "bandcamp.com", reason: "unreachable", count: 1 },
    { day: "2026-11-07", site: "example.com", reason: "timeout", count: 1 },
    { day: "2026-11-07", site: "example.com", reason: "unsupported", count: 1 },
    { day: "2026-11-08", site: "example.com", reason: "unsupported", count: 1 },
  ]);
  const everything = JSON.stringify(app.db.all("SELECT * FROM discovery_misses"));
  for (const leak of ["nilsfrahm", "other.", "album", "spaces", "KEY123", "/feed", "/track"]) assert.ok(!everything.includes(leak), `must not store ${leak}`);
});

test("only the four failures about a site are counted, and only for an address", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  assert.deepEqual([...MISS_REASONS], ["nofeed", "unsupported", "unreachable", "timeout"]);
  for (const reason of ["invalid", "blocked", "toolarge", "aborted", "", "NOFEED"]) recordDiscoveryMiss(app, "https://example.com/", reason);
  for (const pasted of ["", "durov", "Nils Frahm", "alice@", "http://10.0.0.5/feed", "bridge:telegram/durov"]) recordDiscoveryMiss(app, pasted, "nofeed");
  assert.deepEqual(rows(app), []);
  for (const reason of MISS_REASONS) recordDiscoveryMiss(app, "https://example.com/", reason);
  assert.deepEqual(rows(app).map((r) => r.reason), ["nofeed", "timeout", "unreachable", "unsupported"]);
});

test("rows older than 180 days are deleted when a new one is written", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const now = new Date("2026-11-08T12:00:00.000Z");
  const cutoff = "2026-05-12"; // 180 days before the 8th of November: kept
  app.db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES (?, 'old.example', 'nofeed', 5), (?, 'old.example', 'nofeed', 7), (?, 'older.example', 'timeout', 1)", "2026-05-11", cutoff, "2025-01-01");
  assert.equal(KEEP_DAYS, 180);
  assert.equal(rows(app).length, 3, "nothing is deleted by reading");
  topDiscoveryMisses(app, { now });
  assert.equal(rows(app).length, 3);
  recordDiscoveryMiss(app, "https://new.example/", "nofeed", now);
  assert.deepEqual(rows(app).map((r) => `${r.day} ${r.site}`), [`${cutoff} old.example`, "2026-11-08 new.example"], "the day 180 days back stays, the one before it goes");
});

test("a day holds at most 1,000 distinct site and reason rows; counting what is already there goes on", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const now = new Date("2026-11-08T12:00:00.000Z");
  for (let i = 0; i < 1000; i++) recordDiscoveryMiss(app, `https://site${i}.example/`, "nofeed", now);
  recordDiscoveryMiss(app, "https://one-too-many.example/", "nofeed", now);
  recordDiscoveryMiss(app, "https://site7.example/again", "nofeed", now);
  assert.equal(rows(app).length, 1000);
  assert.equal(rows(app).find((r) => r.site === "site7.example")!.count, 2);
  assert.equal(rows(app).find((r) => r.site === "one-too-many.example"), undefined);
  recordDiscoveryMiss(app, "https://one-too-many.example/", "nofeed", new Date("2026-11-09T00:00:01.000Z"));
  assert.equal(rows(app).length, 1001, "the next day starts afresh");
});

test("the top list sums per site and reason over the last 30 days, most first", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const now = new Date("2026-11-08T12:00:00.000Z");
  const add = (day: string, site: string, reason: string, count: number) => app.db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES (?, ?, ?, ?)", day, site, reason, count);
  add("2026-11-08", "a.example", "nofeed", 2); add("2026-11-01", "a.example", "nofeed", 3); add("2026-10-10", "a.example", "nofeed", 4); // 30 days back: the day still counts
  add("2026-10-09", "a.example", "nofeed", 100); // 31 days back: left out
  add("2026-11-08", "a.example", "timeout", 1);
  add("2026-11-02", "b.example", "unsupported", 9);
  add("2026-11-02", "c.example", "nofeed", 9);
  assert.deepEqual(topDiscoveryMisses(app, { now }).map((m) => ({ ...m })), [
    { site: "a.example", reason: "nofeed", count: 9 },
    { site: "b.example", reason: "unsupported", count: 9 },
    { site: "c.example", reason: "nofeed", count: 9 },
    { site: "a.example", reason: "timeout", count: 1 },
  ]);
  for (let i = 0; i < 30; i++) add("2026-11-03", `s${String(i).padStart(2, "0")}.example`, "nofeed", 10);
  const top = topDiscoveryMisses(app, { now });
  assert.equal(top.length, 20);
  assert.ok(top.every((m, i) => i === 0 || top[i - 1]!.count >= m.count));
  assert.equal(top[0]!.count, 10);
});

test("discovery that fails records the site and gives the same answer; a record that can't be written changes nothing", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  // TikTok publishes no feeds, so the answer comes from the address alone, without a network request.
  const first = await discoverSources(app, p, "https://www.tiktok.com/@somebody/video/7123456789");
  assert.equal(first.ok, false);
  assert.equal(first.ok === false && first.reason, "unsupported");
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(rows(app), [{ day: today, site: "tiktok.com", reason: "unsupported", count: 1 }]);
  assert.ok(!JSON.stringify(rows(app)).includes("somebody"), "not the account");

  // An address discovery refuses outright says nothing about a site: it is not counted.
  const blocked = await discoverSources(app, p, "http://192.168.1.1/feed.xml");
  assert.equal(blocked.ok === false && blocked.reason, "blocked");
  assert.equal(rows(app).length, 1);

  // The table is gone (as a broken database might be): the person still gets exactly the same answer.
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  app.db.exec("DROP TABLE discovery_misses");
  const again = await discoverSources(app, p, "https://www.tiktok.com/@somebody/video/7123456789");
  assert.deepEqual(again, first);
  assert.equal(warnings.length, 1, "the failure to count is noted for the operator");
  assert.ok(!JSON.stringify(warnings).includes("tiktok"), "and says nothing of what was pasted");
});
