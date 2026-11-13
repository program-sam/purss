import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, PRIVATE_FEED_URL, seedLibrary, signIn, startTestServer } from "../features-testing.ts";
import type { TestSession } from "../features-testing.ts";
import { extraRouters } from "./index.ts";
import { countJsonValues, parseArchive, sha256Hex } from "../services/archive-format.ts";
import { MAX_IMPORT_VALUES, checkUploadApart, oneImportAtATime, purgeUploads, uploadFile } from "../services/portability.ts";
import { HttpError } from "../http.ts";
import { applySyncBatch } from "../services/sync.ts";
import { createBasket } from "../services/collections.ts";
import { keepItem } from "../services/state.ts";
import { diskOverride, usedBytes } from "../services/storage.ts";

async function boot(env: Record<string, string> = {}, opts: { allocationBytes?: number | null } = {}) {
  const { app, cleanup } = makeTestApp(env);
  const owner = makeOwner(app, { admin: true, allocationBytes: opts.allocationBytes ?? null });
  const server = await startTestServer(app, extraRouters.api(), extraRouters.pages());
  const session = signIn(app, owner.accountId);
  const api = (method: string, path: string, body?: unknown, extra: { contentType?: string } = {}, s: TestSession | null = session) =>
    call(app, server.base, method, path, s, body === undefined && method !== "GET" ? {} : body, extra);
  return { app, owner, server, session, api, close: async () => { await server.close(); cleanup(); } };
}

test("export over HTTP streams a verifiable download with no secrets, and is audited", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  const out = await b.api("GET", "/api/export");
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type")!, /^application\/json/);
  assert.match(out.headers.get("content-disposition")!, /^attachment; filename="purss-export-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(out.headers.get("cache-control"), "no-store");
  const doc = parseArchive(JSON.parse(out.text));
  assert.equal(doc.items.length, 4);
  for (const leak of [PRIVATE_FEED_URL, "SUPERSECRETTOKEN123", "test-token", b.session.csrf, b.session.cookie.split("=")[1]!]) assert.ok(!out.text.includes(leak), `no ${leak.slice(0, 12)}…`);
  assert.equal(b.app.db.get("SELECT outcome FROM audit_events WHERE action = 'export'")!.outcome, "success");
  // The owner of one PURSS gets nothing of another's.
  const other = makeOwner(b.app, { admin: false });
  const otherDoc = JSON.parse((await b.api("GET", "/api/export", undefined, {}, signIn(b.app, other.accountId))).text);
  assert.deepEqual([otherDoc.items.length, otherDoc.sources.length, otherDoc.baskets.length], [0, 0, 0]);
});

test("import over HTTP: preview, apply, and a rejected over-limit apply", async (t) => {
  const a = await boot();
  const b = await boot();
  const small = await boot({}, { allocationBytes: 300 });
  t.after(async () => { await a.close(); await b.close(); await small.close(); });
  seedLibrary(a.app, a.owner);
  const archive = (await a.api("GET", "/api/export")).text;

  // Nothing, garbage and the wrong kind of JSON are all plain 400s.
  assert.equal((await b.api("POST", "/api/import/preview")).status, 400);
  const garbage = await b.api("POST", "/api/import/preview", "{ not json", { contentType: "text/plain" });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.json.error.code, "not_archive");
  assert.equal((await b.api("POST", "/api/import/preview", { hello: "world" })).json.error.code, "not_archive");

  // The archive can be sent as JSON or as plain text.
  const preview = await b.api("POST", "/api/import/preview", archive, { contentType: "text/plain" });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.fits, true);
  assert.equal(preview.json.counts.items, 4);
  assert.ok(Array.isArray(preview.json.conflicts) && preview.json.omitted.length > 0);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 0);
  const applied = await b.api("POST", "/api/import", { token: preview.json.token });
  assert.equal(applied.status, 200);
  assert.equal(applied.json.created.items, 4);
  assert.equal(applied.json.following, 1);
  assert.equal(applied.json.reconnectRequired, 1);
  assert.equal((await b.api("POST", "/api/import", { token: preview.json.token })).json.error.code, "expired", "a token is used once");

  // Too big for the account: refused with the storage message, nothing written, the file stays staged.
  const tooBig = await small.api("POST", "/api/import/preview", archive, { contentType: "application/json" });
  assert.equal(tooBig.json.fits, false);
  const refused = await small.api("POST", "/api/import", { token: tooBig.json.token });
  assert.equal(refused.status, 507);
  assert.equal(refused.json.error.code, "quota_full");
  assert.equal(small.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 0);
  assert.equal(small.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM import_stages")!.n, 1);
  assert.equal(usedBytes(small.app, small.owner.accountId), 0);
});

test("OPML over HTTP: download lists public sources only; upload is previewed, never sent to the engine", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  const out = await b.api("GET", "/api/opml");
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type")!, /^text\/x-opml/);
  assert.equal(out.headers.get("x-purss-left-out"), "1");
  assert.ok(out.text.includes('xmlUrl="https://example.org/feed/1.xml"') && !out.text.includes("Secret Garden") && !out.text.includes("SUPERSECRET"));

  const preview = await b.api("POST", "/api/opml/preview", out.text, { contentType: "text/x-opml" });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.feeds.map((f: any) => [f.title, f.alreadyFollowing]), [["Sediment Letters", true]]);
  const asJson = await b.api("POST", "/api/opml/preview", { opml: '<opml><body><outline text="New" xmlUrl="https://new.example/rss"/></body></opml>' });
  assert.deepEqual(asJson.json.feeds.map((f: any) => [f.feedUrl, f.alreadyFollowing]), [["https://new.example/rss", false]]);
  assert.equal((await b.api("POST", "/api/opml/preview", "<html/>", { contentType: "text/xml" })).json.error.code, "not_opml");
  assert.equal((await b.api("POST", "/api/opml/preview")).status, 400);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.subscribe'")!.n, 0);
});

test("reminders over HTTP: today's anniversary, hide, and the plain DTO shape", async (t) => {
  const b = await boot();
  t.after(b.close);
  makeSource(b.app, b.owner, "Sediment Letters", "feed/1");
  applySyncBatch(b.app, b.owner.engineUserId, batch([entry("feed/1", { title: "Four years ago today" })]));
  const id = b.app.db.get<{ id: string }>("SELECT id FROM items")!.id;
  const basket = createBasket(b.app, b.owner, { name: "Keepers", captureMode: "metadata" }).id;
  keepItem(b.app, b.owner, id, basket);
  const now = new Date();
  b.app.db.run("UPDATE basket_items SET kept_at = ?", new Date(Date.UTC(now.getUTCFullYear() - 4, now.getUTCMonth(), now.getUTCDate(), 12)).toISOString());

  const list = await b.api("GET", "/api/reminders");
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ["basketName", "captureLabel", "id", "itemId", "keptAt", "sourceTitle", "title"]);
  assert.equal(list.json[0].title, "Four years ago today");
  assert.equal((await b.api("POST", `/api/reminders/${list.json[0].id}`, { action: "explode" })).status, 400);
  assert.equal((await b.api("POST", "/api/reminders/rem_nope", { action: "hide" })).status, 404);
  assert.equal((await b.api("POST", `/api/reminders/${list.json[0].id}`, { action: "hide" })).status, 200);
  assert.deepEqual((await b.api("GET", "/api/reminders")).json, []);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders")!.n, 1);
});

test("reconciliation routes: literal path is not read as an id, and unknown entries are 404", async (t) => {
  const b = await boot();
  t.after(b.close);
  assert.deepEqual((await b.api("GET", "/api/reconcile")).json, { entries: [], total: 0, suggestedMatches: 0 });
  assert.deepEqual((await b.api("POST", "/api/reconcile/accept-suggested", {})).json, { matched: 0, skipped: 0, remaining: 0 });
  assert.equal((await b.api("POST", "/api/reconcile/rec_nope", { action: "dismiss" })).status, 404);
  assert.equal((await b.api("POST", "/api/reconcile/rec_nope", { action: "merge" })).status, 400);
});

/** Starts a request announcing `length` bytes and sends only the first few; resolves with the answer, if one comes. */
function partialUpload(base: string, path: string, headers: Record<string, string>, length: number) {
  const req = request(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": String(length) } });
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on("response", (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode!, body })); });
    req.on("error", reject);
  });
  req.write("{\"a\":\"");
  return { answer, finish: () => req.destroy() };
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

test("an import upload is refused before it's read unless someone is signed in, and is one at a time per account", async (t) => {
  const b = await boot();
  t.after(b.close);
  const origin = { origin: b.app.config.publicOrigin };
  // Signed out: answered at once, though 100 MB were announced and almost nothing was sent.
  const anon = partialUpload(b.server.base, "/api/import/preview", origin, 100 * 1024 * 1024);
  const refused = await within(anon.answer, 2000);
  anon.finish();
  assert.equal(refused.status, 401);
  assert.equal(JSON.parse(refused.body).error.code, "signed_out");

  // Signed in: while one upload is arriving, the same account can't start a second; another account isn't held up.
  const signed = { ...origin, cookie: b.session.cookie, "x-purss-csrf": b.session.csrf };
  const slow = partialUpload(b.server.base, "/api/import/preview", signed, 50 * 1024 * 1024);
  await new Promise((r) => setTimeout(r, 100));
  const second = await b.api("POST", "/api/import/preview", "{}", { contentType: "application/json" });
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, "busy");
  const other = signIn(b.app, makeOwner(b.app, { admin: false }).accountId);
  assert.equal((await b.api("POST", "/api/import/preview", { hello: "world" }, {}, other)).json.error.code, "not_archive", "another account uploads meanwhile");
  slow.finish();
  await slow.answer.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await b.api("POST", "/api/import/preview", { hello: "world" })).json.error.code, "not_archive", "free again once the first is gone");
  assert.deepEqual(readdirSync(path.join(b.app.config.dataDir, "staging")).filter((f) => f.endsWith(".part")), [], "no upload left on disk");
});

test("an upload too big to check is refused by the worker checking it, and the API carries on", async (t) => {
  const b = await boot();
  t.after(b.close);
  seedLibrary(b.app, b.owner);
  const doc = JSON.parse((await b.api("GET", "/api/export")).text);
  doc.preferences = { junk: Array.from({ length: 400_000 }, (_, i) => ({ i })) };
  doc.manifest.sections.preferences = { count: 1, sha256: sha256Hex(JSON.stringify(doc.preferences)) };
  const file = path.join(b.app.config.dataDir, "big-upload.json");
  writeFileSync(file, JSON.stringify(doc));
  // The check's own heap holds even under the API's larger --max-old-space-size (which a worker thread's limit doesn't).
  const small = path.join(b.app.config.dataDir, "small-upload.json");
  writeFileSync(small, (await b.api("GET", "/api/export")).text);
  assert.ok((await checkUploadApart(b.app, b.owner, small, 32)).check.counts, "a 32 MB check starts and checks an ordinary export");
  await assert.rejects(checkUploadApart(b.app, b.owner, file, 32), (e: unknown) => e instanceof HttpError && e.status === 413 && e.code === "import_too_large");
  const stop = new AbortController();
  const stopped = checkUploadApart(b.app, b.owner, file, undefined, stop.signal);
  stop.abort();
  await assert.rejects(stopped, (e: unknown) => e instanceof HttpError && e.code === "upload_aborted", "the person going away stops the check");
  const fine = await checkUploadApart(b.app, b.owner, file);
  assert.ok(fine.check.counts && /^[0-9a-f]{64}$/.test(fine.sha256), "with room to spare the same file checks out");
  assert.equal((await b.api("GET", "/api/export")).status, 200, "the API is unaffected");
});


test("an upload that would eat into the disk's reserve isn't stored", async (t) => {
  const b = await boot();
  t.after(async () => { diskOverride.freeBytes = null; await b.close(); });
  diskOverride.freeBytes = b.app.config.diskReserveBytes + 1000;
  const r = await b.api("POST", "/api/import/preview", "x".repeat(5000), { contentType: "application/json" });
  assert.equal(r.status, 507);
  assert.equal(r.json.error.code, "disk_reserve");
  diskOverride.freeBytes = b.app.config.diskReserveBytes + 10_000_000;
  assert.equal((await b.api("POST", "/api/import/preview", { hello: "world" })).json.error.code, "not_archive", "with room, it's read");
});

test("an export holding more values than this server parses at once is refused before parsing", async (t) => {
  const b = await boot();
  t.after(b.close);
  const many = `[${"0,".repeat(MAX_IMPORT_VALUES)}0]`;
  const r = await b.api("POST", "/api/import/preview", many, { contentType: "application/json" });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, "import_too_large");
  assert.equal(countJsonValues('{"a":[1,2,{"b":"x,{[\\"]"}],"c":"\\\\"}'), 7, "commas and brackets inside strings, escaped quotes included, don't count");
  const deep = await b.api("POST", "/api/import/preview", `${"[".repeat(100_000)}${"]".repeat(100_000)}`, { contentType: "application/json" });
  assert.equal(deep.json.error.code, "import_too_large", "few values nested very deep are refused unparsed too");
});

test("an upload the server can't write is answered, not a crash", async (t) => {
  const b = await boot();
  const staging = path.join(b.app.config.dataDir, "staging");
  t.after(async () => { chmodSync(staging, 0o700); await b.close(); });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o500);
  const r = await b.api("POST", "/api/import/preview", { hello: "world" });
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, "upload_not_stored");
  chmodSync(staging, 0o700);
  assert.equal((await b.api("POST", "/api/import/preview", { hello: "world" })).json.error.code, "not_archive", "and the API carries on");
});

test("uploads arriving together each set aside their room on disk, so together they can't eat into the reserve", async (t) => {
  const b = await boot();
  t.after(async () => { diskOverride.freeBytes = null; await b.close(); });
  const size = 10 * 1024 * 1024;
  diskOverride.freeBytes = b.app.config.diskReserveBytes + Math.floor(size * 1.5);
  const first = partialUpload(b.server.base, "/api/import/preview", { origin: b.app.config.publicOrigin, cookie: b.session.cookie, "x-purss-csrf": b.session.csrf }, size);
  await new Promise((r) => setTimeout(r, 100));
  const other = signIn(b.app, makeOwner(b.app, { admin: false }).accountId);
  const secondUpload = partialUpload(b.server.base, "/api/import/preview", { origin: b.app.config.publicOrigin, cookie: other.cookie, "x-purss-csrf": other.csrf }, size);
  const second = await within(secondUpload.answer, 2000);
  secondUpload.finish();
  first.finish();
  await first.answer.catch(() => undefined);
  assert.equal(second.status, 507, "the second is refused, before reading, while the first holds its room");
  assert.equal(JSON.parse(second.body).error.code, "disk_reserve");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(b.app, b.server.base, "POST", "/api/import/preview", other, { hello: "world" })).json.error.code, "not_archive", "and admitted once the first is done");
});

test("uploads left half-written by a stop are removed when the API starts", async (t) => {
  const b = await boot();
  t.after(b.close);
  const left = uploadFile(b.app);
  writeFileSync(left, "half");
  purgeUploads(b.app, 3600_000);
  assert.ok(readdirSync(path.dirname(left)).includes(path.basename(left)), "a recent one may still be arriving");
  purgeUploads(b.app, 0);
  assert.ok(!readdirSync(path.dirname(left)).includes(path.basename(left)), "at start-up, none is");
});

test("an account can apply a few imports a day, so one can't keep holding the API with large ones", async (t) => {
  const b = await boot();
  t.after(b.close);
  for (let i = 0; i < 5; i++) assert.equal((await b.api("POST", "/api/import", { token: "not-a-staged-import" })).json.error.code, "expired");
  const sixth = await b.api("POST", "/api/import", { token: "not-a-staged-import" });
  assert.equal(sixth.status, 429);
});

test("statistics can be asked for a few dozen times in ten minutes, so one account can't keep the API counting", async (t) => {
  const b = await boot();
  t.after(b.close);
  for (let i = 0; i < 30; i++) assert.equal((await b.api("GET", "/api/stats/sources/src_nothing")).status, 404);
  assert.equal((await b.api("GET", "/api/stats/sources/src_nothing")).status, 429);
});

test("the full export and the kept-links list share one allowance of a few an hour", async (t) => {
  const b = await boot();
  t.after(b.close);
  for (let i = 0; i < 6; i++) assert.equal((await b.api("GET", i % 2 ? "/api/export" : "/api/export/kept-links?format=md")).status, 200);
  assert.equal((await b.api("GET", "/api/export/kept-links")).status, 429);
  assert.equal((await b.api("GET", "/api/export")).status, 429);
});

test("a body that stops arriving is answered 408, not just cut off", async (t) => {
  const b = await boot();
  t.after(b.close);
  const stalled = partialUpload(b.server.base, "/p/some-page/report", { origin: b.app.config.publicOrigin }, 1000);
  const started = Date.now();
  const answer = await within(stalled.answer, 9000);
  stalled.finish();
  assert.equal(answer.status, 408);
  assert.equal(JSON.parse(answer.body).error.code, "upload_stalled");
  assert.ok(Date.now() - started >= 4500, "after the signed-out pause allowed (5 s)");
});

test("an import waiting its turn checks the session again when the turn comes: signed out meanwhile, nothing is imported", async (t) => {
  const a = await boot();
  const b = await boot();
  t.after(async () => { await a.close(); await b.close(); });
  seedLibrary(a.app, a.owner);
  const preview = await b.api("POST", "/api/import/preview", (await a.api("GET", "/api/export")).text, { contentType: "application/json" });
  assert.equal(preview.status, 200, preview.text);
  let release!: () => void;
  void oneImportAtATime(() => new Promise<void>((r) => { release = r; }));
  const applying = b.api("POST", "/api/import", { token: preview.json.token });
  await new Promise((r) => setTimeout(r, 100));
  b.app.db.run("DELETE FROM sessions");
  release();
  assert.equal((await applying).status, 401);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n, 0, "nothing was imported");
});

test("an upload stops when other content takes the disk room it set aside while it arrives", async (t) => {
  const b = await boot();
  t.after(async () => { diskOverride.freeBytes = null; await b.close(); });
  const size = 20 * 1024 * 1024;
  diskOverride.freeBytes = b.app.config.diskReserveBytes + size * 2;
  const req = request(b.server.base + "/api/import/preview", { method: "POST", headers: { origin: b.app.config.publicOrigin, cookie: b.session.cookie, "x-purss-csrf": b.session.csrf, "content-type": "application/json", "content-length": String(size) } });
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on("response", (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode!, body })); });
    req.on("error", reject);
  });
  req.write(Buffer.alloc(1024 * 1024, 32));
  await new Promise((r) => setTimeout(r, 100));
  diskOverride.freeBytes = b.app.config.diskReserveBytes + 1024 * 1024; // something else filled the disk meanwhile
  req.write(Buffer.alloc(9 * 1024 * 1024, 32));
  const r = await within(answer, 5000);
  req.destroy();
  assert.equal(r.status, 507);
  assert.equal(JSON.parse(r.body).error.code, "disk_reserve");
});

test("a check that can't start, or can't open the database, is answered as a failure and frees the turn", async (t) => {
  const b = await boot();
  t.after(b.close);
  const file = path.join(b.app.config.dataDir, "export.json");
  writeFileSync(file, (await b.api("GET", "/api/export")).text);
  const realExec = process.execPath;
  process.execPath = "/nonexistent/node";
  let failed: unknown;
  try { failed = await within(checkUploadApart(b.app, b.owner, file).then(() => null, (e: unknown) => e), 10000); } finally { process.execPath = realExec; }
  assert.ok(failed instanceof HttpError && failed.status === 500, `no process: a failure, not a hang (${String(failed)})`);
  assert.equal(await within(oneImportAtATime(() => "next"), 5000), "next", "and the next import gets its turn");
  const broken = { ...b.app, config: { ...b.app.config, dbFile: path.join(b.app.config.dataDir, "no-such-dir", "product.db") } };
  const unopened = await checkUploadApart(broken, b.owner, file).then(() => null, (e: unknown) => e);
  assert.ok(unopened instanceof HttpError && unopened.status === 500 && unopened.code === "internal", "a database it can't open isn't called too large");
});

test("a small upload is checked against the disk reserve again once it has arrived", async (t) => {
  const b = await boot();
  t.after(async () => { diskOverride.freeBytes = null; await b.close(); });
  const size = 2 * 1024 * 1024;
  diskOverride.freeBytes = b.app.config.diskReserveBytes + size * 2;
  const req = request(b.server.base + "/api/import/preview", { method: "POST", headers: { origin: b.app.config.publicOrigin, cookie: b.session.cookie, "x-purss-csrf": b.session.csrf, "content-type": "application/json", "content-length": String(size) } });
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on("response", (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode!, body })); });
    req.on("error", reject);
  });
  req.write(Buffer.alloc(size / 2, 32));
  await new Promise((r) => setTimeout(r, 100));
  diskOverride.freeBytes = b.app.config.diskReserveBytes - 1; // filled by something else while it arrived
  req.end(Buffer.alloc(size / 2, 32));
  const r = await within(answer, 5000);
  assert.equal(r.status, 507);
  assert.deepEqual(readdirSync(path.join(b.app.config.dataDir, "staging")).filter((f) => f.startsWith("upload-") || f.startsWith("import-")), [], "nothing kept");
});

test("an upload waiting its turn is checked against the disk reserve again just before it's kept", async (t) => {
  const a = await boot();
  const b = await boot();
  t.after(async () => { diskOverride.freeBytes = null; await a.close(); await b.close(); });
  seedLibrary(a.app, a.owner);
  const exported = (await a.api("GET", "/api/export")).text;
  diskOverride.freeBytes = b.app.config.diskReserveBytes + 50 * 1024 * 1024;
  let release!: () => void;
  void oneImportAtATime(() => new Promise<void>((r) => { release = r; }));
  const previewing = b.api("POST", "/api/import/preview", exported, { contentType: "application/json" });
  await new Promise((r) => setTimeout(r, 300)); // arrived and checked once; now waiting for its turn
  diskOverride.freeBytes = b.app.config.diskReserveBytes - 1;
  release();
  const r = await previewing;
  assert.equal(r.status, 507);
  assert.deepEqual(readdirSync(path.join(b.app.config.dataDir, "staging")).filter((f) => f.startsWith("import-") || f.startsWith("upload-")), [], "nothing kept");
});
