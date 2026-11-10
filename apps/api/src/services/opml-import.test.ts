import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DiscoveryDraft } from "@purss/connectors";
import type { OpmlImportRequest } from "@purss/domain";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { consumeRateLimit } from "../http.ts";
import { writeSecret } from "../secrets.ts";
import { createCollection, listCollections } from "./collections.ts";
import { dismissOpmlImport, getOpmlImport, listOpmlImports, runOpmlImports, startOpmlImport, stopOpmlImport } from "./opml-import.ts";
import { listSources } from "./sources.ts";

const candidate = (feedUrl: string, title: string, over: Record<string, unknown> = {}) => ({
  title, kind: "feed" as const, origin: "RSS feed", via: "Posts feed", feedUrl, siteUrl: null, cadence: null, samples: [], summariesOnly: false, privateWarning: null, alreadyFollowingSourceId: null, ...over,
});

/** A discovery that answers from a table: a feed address maps to what the site would say it is, or to a failure. */
function answers(table: Record<string, DiscoveryDraft>) {
  const asked: string[] = [];
  return { asked, discover: async (url: string): Promise<DiscoveryDraft> => { asked.push(url); return table[url] ?? { ok: false, url, reason: "unreachable", message: "That site isn't answering." }; } };
}
const found = (url: string, ...c: ReturnType<typeof candidate>[]): DiscoveryDraft => ({ ok: true, url, candidates: c });

const feeds = (...f: ([string, string] | [string, string, string | null])[]): OpmlImportRequest["feeds"] => f.map(([title, feedUrl, folder]) => ({ title, feedUrl, siteUrl: null, folder: folder ?? null }));
const request = (f: OpmlImportRequest["feeds"], destination: OpmlImportRequest["destination"] = { kind: "none" }): OpmlImportRequest => ({ fileName: "subscriptions.opml", destination, feeds: f });

function setup(t: test.TestContext) {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  return { app, p };
}
const wait = async (app: ReturnType<typeof makeTestApp>["app"], deps: Parameters<typeof runOpmlImports>[1]) => { await runOpmlImports(app, deps); };

test("a list is followed on the server with the titles the file gave, and the result is there afterwards", async (t) => {
  const { app, p } = setup(t);
  const a = "https://github.com/nodejs/node/releases.atom";
  const b = "https://blog.example/feed.xml";
  const d = answers({
    [a]: found(a, candidate(a, "Release notes from node")),
    [b]: found(b, candidate(b, "Blog")),
    "https://gone.example/rss": { ok: false, url: "x", reason: "nofeed", message: "We couldn't find a feed on that page." },
  });
  const started = startOpmlImport(app, p, request(feeds(["Node.js releases", a], ["blog.example", b], ["Gone", "https://gone.example/rss"])));
  assert.equal(started.status, "running");
  assert.equal(started.total, 3);
  await wait(app, d);
  const done = getOpmlImport(app, p, started.id);
  assert.equal(done.status, "done");
  assert.deepEqual([done.followed, done.already, done.failed, done.waiting], [2, 0, 1, 0]);
  const titles = listSources(app, p).map((s) => s.title).sort();
  assert.deepEqual(titles, ["Blog", "Node.js releases"], "the file's title is kept; a title that is only the host is replaced by the feed's own name");
  assert.deepEqual(done.entries!.map((e) => [e.title, e.state, e.message]), [
    ["Node.js releases", "followed", null],
    ["blog.example", "followed", null],
    ["Gone", "failed", "We couldn't find a feed on that page."],
  ]);
  assert.ok(done.entries![0]!.sourceId);
  assert.equal(listOpmlImports(app, p).length, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 2, "each followed feed is subscribed through the usual job");
  // The record can be forgotten; the sources stay.
  dismissOpmlImport(app, p, started.id);
  assert.equal(listOpmlImports(app, p).length, 0);
  assert.equal(listSources(app, p).length, 2);
});

test("feeds already followed, several feeds at one address and a second list while one runs", async (t) => {
  const { app, p } = setup(t);
  makeSource(app, p, "Existing", "feed/1"); // https://example.org/feed/1.xml
  const existing = "https://example.org/feed/1.xml";
  const many = "https://many.example/";
  const d = answers({
    [existing]: found(existing, candidate(existing, "Existing")),
    [many]: found(many, candidate("https://many.example/a.xml", "A"), candidate("https://many.example/b.xml", "B")),
  });
  const first = startOpmlImport(app, p, request(feeds(["Existing", existing], ["Many", many])));
  assert.throws(() => startOpmlImport(app, p, request(feeds(["x", "https://x.example/"]))), /already being followed/, "one list at a time");
  await wait(app, d);
  const done = getOpmlImport(app, p, first.id);
  assert.deepEqual(done.entries!.map((e) => [e.state, e.message]), [["already", null], ["failed", "More than one feed was found there. Add it from Add source to choose the right one."]]);
  // Once it is over, another can start.
  assert.doesNotThrow(() => startOpmlImport(app, p, request(feeds(["x", "https://x.example/"]))));
});

test("folders become collections once each; a new collection is made when the first feed is followed", async (t) => {
  const { app, p } = setup(t);
  const urls = ["https://a.example/f", "https://b.example/f", "https://c.example/f"];
  const d = answers(Object.fromEntries(urls.map((u, i) => [u, found(u, candidate(u, `Feed ${i}`))])));
  const list = startOpmlImport(app, p, request(feeds(["A", urls[0]!, "News"], ["B", urls[1]!, "News"], ["C", urls[2]!]), { kind: "folders" }));
  await wait(app, d);
  assert.equal(getOpmlImport(app, p, list.id).followed, 3);
  const cols = listCollections(app, p);
  assert.deepEqual(cols.map((c) => c.name), ["News"]);
  assert.equal(listSources(app, p).filter((s) => s.collectionIds.includes(cols[0]!.id)).length, 2, "the two feeds of the folder, not the one outside any");

  const { app: app2, p: p2 } = setup(t);
  const u = "https://d.example/f";
  const fresh = startOpmlImport(app2, p2, request(feeds(["D", u]), { kind: "new", name: "Imported" }));
  assert.equal(listCollections(app2, p2).length, 0, "nothing is made before a feed is followed");
  await wait(app2, answers({ [u]: found(u, candidate(u, "D")) }));
  assert.deepEqual(listCollections(app2, p2).map((c) => c.name), ["Imported"]);
  assert.equal(getOpmlImport(app2, p2, fresh.id).followed, 1);
});

test("stopping ends the list after the feed in hand; the rest stay unfollowed", async (t) => {
  const { app, p } = setup(t);
  const urls = ["https://a.example/f", "https://b.example/f", "https://c.example/f"];
  let list: string | undefined;
  const asked: string[] = [];
  const discover = async (url: string): Promise<DiscoveryDraft> => {
    asked.push(url);
    if (url === urls[0]) stopOpmlImport(app, p, list!); // the person stops it while the first site is being asked
    return found(url, candidate(url, "x"));
  };
  list = startOpmlImport(app, p, request(feeds(["A", urls[0]!], ["B", urls[1]!], ["C", urls[2]!]))).id;
  await wait(app, { discover });
  const out = getOpmlImport(app, p, list);
  assert.equal(out.status, "stopped");
  assert.deepEqual(asked, [urls[0]], "no further site was asked");
  assert.deepEqual([out.followed, out.waiting], [0, 3], "the one in hand was not followed either: stopped means stopped");
  assert.equal(listSources(app, p).length, 0);
});

test("a feed whose link carries a secret never enters the database, follows privately, and its link is gone afterwards", async (t) => {
  const { app, p } = setup(t);
  const secret = "https://feeds.example/private?token=SUPERSECRETTOKEN";
  const d = answers({ [secret]: found(secret, candidate(secret, "Private feed", { privateWarning: "This link has a secret in it." })) });
  const list = startOpmlImport(app, p, request(feeds(["My private feed", secret])));
  const dir = path.join(app.config.secretsDir, "opml-imports", list.id);
  assert.ok(existsSync(path.join(dir, "0")), "waiting in the secrets folder");
  const dump = JSON.stringify([...app.db.all("SELECT * FROM opml_import_entries"), ...app.db.all("SELECT * FROM opml_imports")]);
  assert.ok(!dump.includes("SUPERSECRETTOKEN"), "the database holds no part of the secret");
  assert.equal(getOpmlImport(app, p, list.id).entries![0]!.looksPrivate, true);
  await wait(app, d);
  assert.equal(getOpmlImport(app, p, list.id).followed, 1);
  const src = app.db.get<{ is_private: number; feed_url: string | null }>("SELECT is_private, feed_url FROM sources WHERE title = 'My private feed'")!;
  assert.deepEqual([src.is_private, src.feed_url], [1, null]);
  assert.ok(!existsSync(dir), "the waiting link is removed");
  assert.ok(!JSON.stringify(app.db.all("SELECT payload FROM jobs")).includes("SUPERSECRETTOKEN"), "and no job carries it");
});

test("a process that stopped halfway picks the list up again where it was", async (t) => {
  const { app, p } = setup(t);
  const urls = ["https://a.example/f", "https://b.example/f"];
  const d = answers(Object.fromEntries(urls.map((u) => [u, found(u, candidate(u, `Feed ${u}`))])));
  const list = startOpmlImport(app, p, request(feeds(["A", urls[0]!], ["B", urls[1]!])));
  // As the database looks after a crash: the first one done, the second one in hand.
  app.db.run("UPDATE opml_import_entries SET state = 'followed' WHERE import_id = ? AND position = 0", list.id);
  app.db.run("UPDATE opml_import_entries SET state = 'working' WHERE import_id = ? AND position = 1", list.id);
  await wait(app, d);
  assert.deepEqual(d.asked, [urls[1]], "only what was not done");
  assert.equal(getOpmlImport(app, p, list.id).status, "done");
});

test("a PURSS that is not connected to the engine yet waits instead of failing its feeds", async (t) => {
  const { app, p } = setup(t);
  app.db.run("DELETE FROM engine_users WHERE account_id = ?", p.accountId);
  const u = "https://a.example/f";
  const list = startOpmlImport(app, p, request(feeds(["A", u])));
  await wait(app, answers({ [u]: found(u, candidate(u, "A")) }));
  const out = getOpmlImport(app, p, list.id);
  assert.equal(out.status, "running");
  assert.deepEqual([out.failed, out.waiting], [0, 1]);
});

test("lists belong to their account; invalid input is refused", async (t) => {
  const { app, p } = setup(t);
  const q = makeOwner(app, { admin: false });
  const list = startOpmlImport(app, p, request(feeds(["A", "https://a.example/f"])));
  assert.throws(() => getOpmlImport(app, q, list.id), /That import/);
  assert.throws(() => stopOpmlImport(app, q, list.id), /That import/);
  assert.deepEqual(listOpmlImports(app, q), []);
  assert.throws(() => dismissOpmlImport(app, p, list.id), /Stop the list first/);
  stopOpmlImport(app, p, list.id);
  assert.throws(() => startOpmlImport(app, q, request(feeds(["x", "ftp://nope.example/"]))), /web address/);
  assert.throws(() => startOpmlImport(app, q, request(feeds(["x", "https://x.example/"]), { kind: "collection", id: "col_missing" })), /That collection/);
  assert.throws(() => startOpmlImport(app, q, request(feeds(["x", "https://x.example/"]), { kind: "new", name: "  " })), /Name the new collection/);
});

test("a private link with its key in the path never enters the database either", async (t) => {
  const { app, p } = setup(t);
  const secret = "https://feeds.example/private/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c/feed.xml";
  const list = startOpmlImport(app, p, request(feeds(["Mine", secret])));
  const dump = JSON.stringify([...app.db.all("SELECT * FROM opml_import_entries"), ...app.db.all("SELECT * FROM opml_imports")]);
  assert.ok(!dump.includes("3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"), "no part of the key is stored");
  assert.equal(getOpmlImport(app, p, list.id).entries![0]!.looksPrivate, true);
  assert.ok(existsSync(path.join(app.config.secretsDir, "opml-imports", list.id, "0")));
});

test("source and settlement are one step: when settling fails nothing was followed, and a replay follows a private feed once", async (t) => {
  const { app, p } = setup(t);
  const secret = "https://feeds.example/feed?token=SUPERSECRETTOKEN";
  const d = answers({ [secret]: found(secret, candidate(secret, "Private feed", { privateWarning: "This link has a secret in it." })) });
  const list = startOpmlImport(app, p, request(feeds(["Mine", secret])));
  // The database gives way at the moment the entry is settled, as a crash there would.
  app.db.exec("CREATE TEMP TRIGGER crash BEFORE UPDATE ON opml_import_entries WHEN NEW.state = 'followed' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  await wait(app, d);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 0, "no source without its entry saying so");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 0, "and no subscription job");
  app.db.exec("DROP TRIGGER crash");
  // The process comes back with the entry as a crash leaves it: in hand.
  app.db.run("UPDATE opml_import_entries SET state = 'working', message = NULL WHERE import_id = ?", list.id);
  app.db.run("UPDATE opml_imports SET status = 'running', finished_at = NULL WHERE id = ?", list.id);
  writeSecret(app.config.secretsDir, `opml-imports/${list.id}/0`, secret);
  await wait(app, d);
  await wait(app, d);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 1);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 1);
  assert.equal(getOpmlImport(app, p, list.id).followed, 1);
});

test("a source already made for an entry is never made twice, even for a private feed that has no address to compare", async (t) => {
  const { app, p } = setup(t);
  const secret = "https://feeds.example/feed?token=SUPERSECRETTOKEN";
  const d = answers({ [secret]: found(secret, candidate(secret, "Private feed", { privateWarning: "This link has a secret in it." })) });
  const list = startOpmlImport(app, p, request(feeds(["Mine", secret])));
  await wait(app, d);
  assert.equal(getOpmlImport(app, p, list.id).followed, 1);
  // The settled entry is put back (a restore from an older copy of the list, say): its source is found again, not made again.
  app.db.run("UPDATE opml_import_entries SET state = 'waiting' WHERE import_id = ?", list.id);
  app.db.run("UPDATE opml_imports SET status = 'running', finished_at = NULL WHERE id = ?", list.id);
  writeSecret(app.config.secretsDir, `opml-imports/${list.id}/0`, secret);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 1);
  await wait(app, d);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 1);
});

test("stopping a list while a feed is being looked up leaves no private link behind, and an expired record takes its folder with it", async (t) => {
  const { app, p } = setup(t);
  const secret = "https://feeds.example/feed?token=SUPERSECRETTOKEN";
  let list: string | undefined;
  const discover = async (url: string): Promise<DiscoveryDraft> => { stopOpmlImport(app, p, list!); return found(url, candidate(url, "x")); };
  list = startOpmlImport(app, p, request(feeds(["A", secret], ["B", "https://b.example/f"]))).id;
  const dir = path.join(app.config.secretsDir, "opml-imports", list);
  assert.ok(existsSync(dir));
  await wait(app, { discover });
  assert.equal(getOpmlImport(app, p, list).status, "stopped");
  assert.ok(!existsSync(dir), "the link of the feed that was in hand, and of any that waited, is gone");

  // History: an old record's rows and its folder go together, whatever state the folder is in.
  const old = startOpmlImport(app, p, request(feeds(["C", secret])));
  app.db.run("UPDATE opml_imports SET status = 'done', finished_at = ? WHERE id = ?", new Date(Date.now() - 40 * 86_400_000).toISOString(), old.id);
  const oldDir = path.join(app.config.secretsDir, "opml-imports", old.id);
  assert.ok(existsSync(oldDir), "a leftover from an older run");
  await wait(app, { discover: async (url) => found(url, candidate(url, "x")) });
  assert.equal(app.db.get("SELECT 1 FROM opml_imports WHERE id = ?", old.id), undefined);
  assert.ok(!existsSync(oldDir), "the expired record's folder is removed with it");
});

test("a list's lookups are counted against the account's discovery budget; when it is used up they wait, and nothing fails", async (t) => {
  const { app, p } = setup(t);
  const urls = ["https://a.example/f", "https://b.example/f", "https://c.example/f"];
  const d = answers(Object.fromEntries(urls.map((u) => [u, found(u, candidate(u, `Feed ${u}`))])));
  // What pasting links in Add source does: the account has used the share the list may draw on.
  for (let i = 0; i < 100; i++) consumeRateLimit(`discover:${p.accountId}`, 120);
  const list = startOpmlImport(app, p, request(feeds(["A", urls[0]!], ["B", urls[1]!], ["C", urls[2]!])));
  await wait(app, d);
  assert.deepEqual(d.asked, [], "no lookup while the budget is used up");
  let out = getOpmlImport(app, p, list.id);
  assert.deepEqual([out.status, out.failed, out.waiting], ["running", 0, 3]);
  assert.equal(consumeRateLimit(`discover:${p.accountId}`, 120).allowed, true, "and the person's own lookups still have room");

  // A window later the budget is back and the list goes on.
  await wait(app, { ...d, consume: () => ({ allowed: true, resetAt: 0, remaining: 50 }), now: () => Date.now() + 11 * 60_000 });
  out = getOpmlImport(app, p, list.id);
  assert.deepEqual([out.status, out.followed], ["done", 3]);
  assert.equal(d.asked.length, 3);
});

test("lists take turns, one feed each, instead of the first lists holding the rest back", async (t) => {
  const { app, p } = setup(t);
  const owners = [p, makeOwner(app, { admin: false }), makeOwner(app, { admin: false })];
  const urls = owners.map((_, i) => [`https://l${i}a.example/f`, `https://l${i}b.example/f`, `https://l${i}c.example/f`]);
  const d = answers(Object.fromEntries(urls.flat().map((u) => [u, found(u, candidate(u, `Feed ${u}`))])));
  owners.forEach((o, i) => startOpmlImport(app, o, request(feeds([`${i}a`, urls[i]![0]!], [`${i}b`, urls[i]![1]!], [`${i}c`, urls[i]![2]!]))));
  await wait(app, { ...d, workers: 1 });
  assert.deepEqual(d.asked, [urls[0]![0], urls[1]![0], urls[2]![0], urls[0]![1], urls[1]![1], urls[2]![1], urls[0]![2], urls[1]![2], urls[2]![2]]);
});

test("many lists never hold more than a few lookups at once", async (t) => {
  const { app, p } = setup(t);
  let running = 0;
  let peak = 0;
  const discover = async (url: string): Promise<DiscoveryDraft> => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return found(url, candidate(url, "x")); };
  for (let i = 0; i < 5; i++) startOpmlImport(app, i === 0 ? p : makeOwner(app, { admin: false }), request(feeds([`F${i}a`, `https://f${i}a.example/f`], [`F${i}b`, `https://f${i}b.example/f`])));
  await wait(app, { discover, workers: 2 });
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM opml_import_entries WHERE state = 'followed'")!.n, 10);
});

test("a failure while following leaves no link file of a source that was never made", async (t) => {
  const { app, p } = setup(t);
  const secret = "https://feeds.example/feed?token=SUPERSECRETTOKEN";
  const d = answers({ [secret]: found(secret, candidate(secret, "Private feed", { privateWarning: "This link has a secret in it." })) });
  startOpmlImport(app, p, request(feeds(["Mine", secret])));
  app.db.exec("CREATE TEMP TRIGGER crash BEFORE UPDATE ON opml_import_entries WHEN NEW.state = 'followed' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  await wait(app, d);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 0);
  assert.ok(!existsSync(path.join(app.config.secretsDir, "source-urls")) || readdirSync(path.join(app.config.secretsDir, "source-urls")).length === 0, "the rolled-back source's link file is gone");
});

test("link folders nobody can need any more are swept: a stopped list's, an orphan from a crash, a dismissed list's", async (t) => {
  const { app, p } = setup(t);
  const dirs = path.join(app.config.secretsDir, "opml-imports");
  const secret = "https://feeds.example/feed?token=SUPERSECRETTOKEN";
  const live = startOpmlImport(app, p, request(feeds(["A", secret])));
  // A folder no list owns (a crash while a list was being made).
  writeSecret(app.config.secretsDir, "opml-imports/opl_orphan/0", secret);
  // A list the process was stopped in the middle of: stopped, with its folder still there.
  const q = makeOwner(app, { admin: false });
  const stopped = startOpmlImport(app, q, request(feeds(["B", secret])));
  app.db.run("UPDATE opml_imports SET status = 'stopped', finished_at = ? WHERE id = ?", new Date().toISOString(), stopped.id);
  assert.ok(existsSync(path.join(dirs, "opl_orphan")) && existsSync(path.join(dirs, stopped.id)));
  // A finished list whose folder was left behind.
  const r = makeOwner(app, { admin: false });
  const done = startOpmlImport(app, r, request(feeds(["C", secret])));
  app.db.run("UPDATE opml_imports SET status = 'done', finished_at = ? WHERE id = ?", new Date().toISOString(), done.id);

  await wait(app, { discover: async (url) => found(url, candidate(url, "x")), workers: 0 });
  assert.ok(!existsSync(path.join(dirs, "opl_orphan")), "an orphan");
  assert.ok(!existsSync(path.join(dirs, stopped.id)), "a stopped list's");
  assert.ok(!existsSync(path.join(dirs, done.id)), "a finished list's");
  assert.ok(existsSync(path.join(dirs, live.id)), "a running list's link is still waiting");
});

test("forgetting a list takes its link folder first: when that fails, the record stays and can be forgotten again", async (t) => {
  if (process.getuid?.() === 0) return t.skip("permissions don't bind root");
  const { app, p } = setup(t);
  const dirs = path.join(app.config.secretsDir, "opml-imports");
  const secret = "https://feeds.example/feed?token=SUPERSECRETTOKEN";
  const list = startOpmlImport(app, p, request(feeds(["A", secret])));
  stopOpmlImport(app, p, list.id);
  writeSecret(app.config.secretsDir, `opml-imports/${list.id}/0`, secret); // still there, as after a crash
  chmodSync(dirs, 0o500);
  try {
    assert.throws(() => dismissOpmlImport(app, p, list.id));
    assert.equal(listOpmlImports(app, p).length, 1, "the record is not gone while its folder is");
  } finally {
    chmodSync(dirs, 0o700);
  }
  dismissOpmlImport(app, p, list.id);
  assert.ok(!existsSync(path.join(dirs, list.id)));
  assert.equal(listOpmlImports(app, p).length, 0);
});

// ---------- hosted plans (main's rules for imports, carried into the server-side import) ----------

function hostedSetup(t: test.TestContext) {
  const { app, cleanup } = makeTestApp({ PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://workspace.example" });
  t.after(cleanup);
  return { app, p: makeOwner(app, { admin: false }) };
}
const fill = (app: ReturnType<typeof makeTestApp>["app"], p: Parameters<typeof makeSource>[1], n: number) => { for (let i = 0; i < n; i++) makeSource(app, p, `Source ${i}`, `feed/${i}`); };
const answerEach = (urls: string[]) => answers(Object.fromEntries(urls.map((u) => [u, found(u, candidate(u, `Feed ${u}`))])));

test("the plan's limit is checked before each follow: what fits is followed, the rest says why and costs no lookup", async (t) => {
  const { app, p } = hostedSetup(t);
  fill(app, p, 99); // Free allows 100 followed sources
  const urls = ["https://a.example/f", "https://b.example/f", "https://c.example/f"];
  const d = answerEach(urls);
  const list = startOpmlImport(app, p, request(feeds(["A", urls[0]!], ["B", urls[1]!], ["C", urls[2]!])));
  await wait(app, d);
  const out = getOpmlImport(app, p, list.id);
  assert.deepEqual([out.status, out.followed, out.failed], ["done", 1, 2]);
  assert.deepEqual(out.entries!.map((e) => e.state), ["followed", "failed", "failed"]);
  assert.match(out.entries![1]!.message ?? "", /Your plan allows 100 sources/);
  assert.deepEqual(d.asked, [urls[0]], "the refused ones were not even looked up");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual' AND followed = 1")!.n, 100);
});

test("a feed already followed is recognised at the limit, and the plan's room is not spent on it", async (t) => {
  const { app, p } = hostedSetup(t);
  fill(app, p, 100);
  const again = "https://example.org/feed/7.xml"; // the address Source 7 was made with
  const other = "https://z.example/f";
  const d = answerEach([again, other]);
  const list = startOpmlImport(app, p, request(feeds(["Seven", again], ["Z", other])));
  await wait(app, d);
  const out = getOpmlImport(app, p, list.id);
  assert.deepEqual(out.entries!.map((e) => e.state), ["already", "failed"]);
  assert.ok(out.entries![0]!.sourceId);
  assert.equal(out.followed, 0);
  assert.deepEqual(d.asked, []);
});

test("a folder's collection is made together with its first follow: a follow the plan refuses leaves no empty collection", async (t) => {
  const { app, p } = hostedSetup(t);
  fill(app, p, 100);
  const urls = ["https://a.example/f", "https://b.example/f"];
  const list = startOpmlImport(app, p, request(feeds(["A", urls[0]!, "News"], ["B", urls[1]!, "Sport"]), { kind: "folders" }));
  await wait(app, answerEach(urls));
  assert.equal(getOpmlImport(app, p, list.id).failed, 2);
  assert.deepEqual(listCollections(app, p), [], "no empty collection for the folders whose feeds were refused");

  // With room for sources but not for collections: the follow is refused as a whole, with no source and no half-made collection.
  const { app: app2, p: p2 } = hostedSetup(t);
  for (let i = 0; i < 4; i++) createCollection(app2, p2, { name: `C${i}`, emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
  const u = "https://c.example/f";
  const full = startOpmlImport(app2, p2, request(feeds(["C", u, "Brand new folder"]), { kind: "folders" }));
  await wait(app2, answerEach([u]));
  const out = getOpmlImport(app2, p2, full.id);
  assert.match(out.entries![0]!.message ?? "", /allows 4 collections/);
  assert.equal(app2.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual'")!.n, 0);
  assert.equal(listCollections(app2, p2).length, 4);
});

test("feeds of one folder share the collection its first follow made, and two records of one source count it once", async (t) => {
  const { app, p } = hostedSetup(t);
  const a = "https://a.example/f";
  const alias = "https://alias.example/f"; // a second address that discovery resolves to the same feed
  const b = "https://b.example/f";
  const d = answers({ [a]: found(a, candidate(a, "A")), [alias]: found(alias, candidate(a, "A")), [b]: found(b, candidate(b, "B")) });
  const list = startOpmlImport(app, p, request(feeds(["A", a, "News"], ["A again", alias, "News"], ["B", b, "News"]), { kind: "folders" }));
  await wait(app, d);
  const out = getOpmlImport(app, p, list.id);
  assert.deepEqual(out.entries!.map((e) => e.state), ["followed", "already", "followed"]);
  assert.equal(out.followed, 2, "the source both records land on is counted once");
  const cols = listCollections(app, p);
  assert.deepEqual(cols.map((c) => c.name), ["News"]);
  assert.equal(listSources(app, p).filter((s) => s.collectionIds.includes(cols[0]!.id)).length, 2);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE kind <> 'manual' AND followed = 1")!.n, 2);
});
