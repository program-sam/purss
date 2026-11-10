import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { call, signIn, startTestServer } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { internalRouter } from "../routes/internal.ts";
import { internalServer } from "../server.ts";
import type { AddressInfo } from "node:net";
import { addSeconds } from "../http.ts";
import { completeJob, leaseJobs } from "./jobs.ts";
import { completeIconCheck, failIconCheck, scheduleIconChecks } from "./icons.ts";
import { getSource, listSources } from "./sources.ts";

const webp = (r: number) => sharp({ create: { width: 64, height: 64, channels: 4, background: { r, g: 10, b: 10, alpha: 1 } } }).webp().toBuffer();
const found = async (r = 200) => ({ found: true, data: (await webp(r)).toString("base64"), width: 64, from: "https://news.example/touch.png" });
const iconJobs = (app: ReturnType<typeof makeTestApp>["app"]) =>
  app.db.all<{ payload: string; status: string }>("SELECT payload, status FROM jobs WHERE kind = 'source.icon' ORDER BY created_at");

test("the sweep queues one check per due source, skips saved links, and redacts private feed links", (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const pub = makeSource(app, p, "Public", "feed/1");
  const priv = makeSource(app, p, "Private", "feed/2", { isPrivate: true });
  app.db.run("UPDATE sources SET site_url = 'https://private.example' WHERE id = ?", priv);
  const manual = makeSource(app, p, "Saved links", "feed/3", { kind: "manual" });
  const recent = makeSource(app, p, "Checked yesterday", "feed/4");
  app.db.run("UPDATE sources SET icon_checked_at = ? WHERE id = ?", addSeconds(-86_400), recent);

  scheduleIconChecks(app);
  scheduleIconChecks(app); // a second tick while the jobs wait adds nothing
  const payloads = iconJobs(app).map((j) => JSON.parse(j.payload));
  assert.deepEqual(payloads.map((j) => j.sourceId).sort(), [pub, priv].sort());
  assert.equal(payloads.find((j) => j.sourceId === priv).feedUrl, null, "a private feed link never enters a job");
  assert.equal(payloads.find((j) => j.sourceId === priv).siteUrl, "https://private.example");
  assert.ok(!payloads.some((j) => j.sourceId === manual));

  // A week later the checked source is due again and its finished job is re-armed.
  const [job] = leaseJobs(app, ["source.icon"], 1);
  completeJob(app, job!.id, job!.leaseId, {});
  const done = (job!.payload as { sourceId: string }).sourceId;
  app.db.run("UPDATE sources SET icon_checked_at = ? WHERE id = ?", addSeconds(-8 * 86_400), done);
  scheduleIconChecks(app);
  assert.equal(iconJobs(app).filter((j) => JSON.parse(j.payload).sourceId === done && j.status === "queued").length, 1);
});

test("a found icon is stored and shown; a later miss or failure keeps it; a new one replaces it", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const id = makeSource(app, p, "News", "feed/1");
  assert.equal(getSource(app, p, id).iconUrl, null);

  completeIconCheck(app, id, await found());
  const first = getSource(app, p, id).iconUrl;
  assert.match(first!, new RegExp(`^/api/sources/${id}/icon\\?v=[0-9a-f]{16}$`));
  assert.equal(listSources(app, p).find((s) => s.id === id)!.iconUrl, first);
  assert.ok(app.db.get<{ c: string }>("SELECT icon_checked_at AS c FROM sources WHERE id = ?", id)!.c);

  completeIconCheck(app, id, { found: false, reasons: ["http 403"] });
  failIconCheck(app, id);
  assert.equal(getSource(app, p, id).iconUrl, first, "a check that finds nothing keeps the icon");

  completeIconCheck(app, id, await found(20));
  const second = getSource(app, p, id).iconUrl;
  assert.notEqual(second, first, "a changed icon gets a new address, so browsers fetch it again");
});

test("bytes that are not a small WebP are never stored", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  const id = makeSource(app, p, "News", "feed/1");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  const png = (await sharp({ create: { width: 8, height: 8, channels: 3, background: "#f00" } }).png().toBuffer()).toString("base64");
  for (const data of [svg, png, "", "!!notbase64!!", "A".repeat(200_000)]) completeIconCheck(app, id, { found: true, data, from: "https://x.example/i" });
  completeIconCheck(app, id, { found: true });
  completeIconCheck(app, id, "nonsense");
  assert.equal(getSource(app, p, id).iconUrl, null);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_icons")!.n, 0);
});

test("the icon route serves the owner's icon with caching and lockdown headers, and nobody else's", async (t) => {
  const { app, cleanup } = makeTestApp();
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  t.after(async () => { await server.close(); cleanup(); });
  const owner = makeOwner(app);
  const other = makeOwner(app, { admin: false });
  const id = makeSource(app, owner, "News", "feed/1");
  completeIconCheck(app, id, await found());
  const url = getSource(app, owner, id).iconUrl!;

  const res = await fetch(server.base + url, { headers: { cookie: signIn(app, owner.accountId).cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy")!, /sandbox/);
  assert.match(res.headers.get("cache-control")!, /^private, .*immutable/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal((await sharp(body).metadata()).format, "webp");

  const again = await fetch(server.base + url, { headers: { cookie: signIn(app, owner.accountId).cookie, "if-none-match": res.headers.get("etag")! } });
  assert.equal(again.status, 304);

  assert.equal((await call(app, server.base, "GET", url, signIn(app, other.accountId))).status, 404, "another account can't read it");
  assert.equal((await call(app, server.base, "GET", url, null)).status, 401, "signed out can't read it");
});

test("through the internal job routes: the icon is stored, the job keeps no bytes, and a final failure still marks the check", async (t) => {
  const { app, cleanup } = makeTestApp();
  const server = internalServer(app, internalRouter(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); cleanup(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${app.serviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const p = makeOwner(app);
  const a = makeSource(app, p, "A", "feed/1");
  const b = makeSource(app, p, "B", "feed/2");
  scheduleIconChecks(app);

  const lease = await (await post("/internal/jobs/lease", { kinds: ["source.icon"], max: 2 })).json() as { jobs: { id: string; leaseId: string; payload: { sourceId: string } }[] };
  const jobA = lease.jobs.find((j) => j.payload.sourceId === a)!;
  const jobB = lease.jobs.find((j) => j.payload.sourceId === b)!;
  assert.equal((await post(`/internal/jobs/${jobA.id}/complete`, { leaseId: jobA.leaseId, result: await found() })).status, 200);
  assert.ok(getSource(app, p, a).iconUrl);
  assert.equal(app.db.get<{ result: string }>("SELECT result FROM jobs WHERE id = ?", jobA.id)!.result, JSON.stringify({ found: true }));

  // B's lookup crashes twice (maxAttempts 2): no icon, but it isn't retried every tick either.
  assert.equal((await post(`/internal/jobs/${jobB.id}/fail`, { leaseId: jobB.leaseId, error: "boom", retryable: true })).status, 200);
  app.db.run("UPDATE jobs SET run_after = ? WHERE id = ?", addSeconds(-1), jobB.id);
  const again = await (await post("/internal/jobs/lease", { kinds: ["source.icon"], max: 1 })).json() as { jobs: { id: string; leaseId: string }[] };
  assert.equal((await post(`/internal/jobs/${again.jobs[0]!.id}/fail`, { leaseId: again.jobs[0]!.leaseId, error: "boom", retryable: true })).status, 200);
  assert.ok(app.db.get<{ c: string | null }>("SELECT icon_checked_at AS c FROM sources WHERE id = ?", b)!.c);
  scheduleIconChecks(app);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'source.icon' AND status = 'queued'")!.n, 0);
});
