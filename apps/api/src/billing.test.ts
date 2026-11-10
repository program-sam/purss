import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeOwner, makeTestApp } from "./testing.ts";
import { call, signIn, startTestServer } from "./features-testing.ts";
import { publicRouter } from "./routes/public.ts";
import { extraRouters } from "./routes/index.ts";
import { signPlan } from "./billing.ts";
import { loadConfig } from "./config.ts";

const SECRET = "s".repeat(40);
const HOSTED = { PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://purss.example", PURSS_BILLING_URL: "https://pay.example/billing/", PURSS_BILLING_SECRET: SECRET };

async function boot(t: test.TestContext, env: Record<string, string> = HOSTED) {
  const { app, cleanup } = makeTestApp(env);
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()]);
  t.after(async () => { await server.close(); cleanup(); });
  return { app, base: server.base };
}

function planRequest(app: ReturnType<typeof makeTestApp>["app"], base: string, body: { accountId: string; plan: string; at: number }, sig = signPlan(SECRET, body)) {
  // The billing service sends no Origin and no cookies.
  return fetch(`${base}/api/billing/plan`, { method: "POST", headers: { "content-type": "application/json", "x-purss-billing-signature": sig }, body: JSON.stringify(body) });
}

const now = () => Math.floor(Date.now() / 1000);
const planOfRow = (app: ReturnType<typeof makeTestApp>["app"], id: string) => app.db.get<{ plan: string }>("SELECT plan FROM accounts WHERE id = ?", id)!.plan;

test("billing needs hosted mode, an https address and a long secret", () => {
  assert.equal(loadConfig({ PURSS_DATA_DIR: "/tmp/x", PURSS_BILLING_URL: HOSTED.PURSS_BILLING_URL, PURSS_BILLING_SECRET: SECRET }).billing, null, "self-hosted: off");
  assert.deepEqual(loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...HOSTED }).billing, { url: "https://pay.example/billing", secret: SECRET });
  assert.throws(() => loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...HOSTED, PURSS_BILLING_SECRET: "short" }), /32 characters/);
  assert.throws(() => loadConfig({ PURSS_DATA_DIR: "/tmp/x", ...HOSTED, PURSS_BILLING_URL: "http://pay.example" }), /https/);
});

test("the hand-off is a signed ticket for the signed-in account that expires", async (t) => {
  const { app, base } = await boot(t);
  const me = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET plan = 'free', email = 'me@example.org', email_verified_at = '2026-01-01T00:00:00Z' WHERE id = ?", me.accountId);
  const session = await call(app, base, "GET", "/api/session", signIn(app, me.accountId));
  assert.equal(session.json.installation.billing, true);
  const r = await call(app, base, "POST", "/api/billing/handoff", signIn(app, me.accountId), { intent: "plus_year" });
  assert.equal(r.status, 200);
  const url = new URL(r.json.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://pay.example/billing/go");
  const [payload, sig] = url.searchParams.get("t")!.split(".");
  assert.equal(sig, createHmac("sha256", SECRET).update(`purss-billing:ticket\n${payload}`).digest("base64url"));
  const ticket = JSON.parse(Buffer.from(payload!, "base64url").toString());
  assert.equal(ticket.a, me.accountId);
  assert.equal(ticket.i, "plus_year");
  assert.equal(ticket.p, "free");
  assert.equal(ticket.e, "me@example.org");
  assert.equal(ticket.r, "https://purss.example/app/?dialog=plan");
  assert.ok(ticket.x > now() && ticket.x <= now() + 600);

  assert.equal((await call(app, base, "POST", "/api/billing/handoff", null, { intent: "plus_year" })).status, 401);
  assert.equal((await call(app, base, "POST", "/api/billing/handoff", signIn(app, me.accountId), { intent: "gold" })).status, 400);
  const admin = makeOwner(app, { admin: true });
  assert.equal((await call(app, base, "POST", "/api/billing/handoff", signIn(app, admin.accountId), { intent: "manage" })).status, 409, "administrators have no plan to pay for");
});

test("the billing service sets Free, Plus or Pro with a fresh signature, once", async (t) => {
  const { app, base } = await boot(t);
  const me = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET plan = 'free' WHERE id = ?", me.accountId);

  const body = { accountId: me.accountId, plan: "pro", at: now() };
  const ok = await planRequest(app, base, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { plan: "pro", changed: true });
  assert.equal(planOfRow(app, me.accountId), "pro");
  assert.equal((await planRequest(app, base, body)).status, 409, "the same request again is refused");

  assert.equal((await planRequest(app, base, { ...body, plan: "free", at: now() + 1 }, signPlan("x".repeat(40), { ...body, plan: "free", at: now() + 1 }))).status, 401, "wrong secret");
  const forged = { ...body, plan: "free", at: now() + 2 };
  assert.equal((await planRequest(app, base, forged, signPlan(SECRET, body))).status, 401, "signature of another body");
  const old = { ...body, plan: "free", at: now() - 400 };
  assert.equal((await planRequest(app, base, old)).status, 401, "too old");
  assert.equal((await planRequest(app, base, { ...body, plan: "unlimited", at: now() + 3 })).status, 400, "only Free, Plus and Pro");
  assert.equal(planOfRow(app, me.accountId), "pro");

  assert.equal((await planRequest(app, base, { accountId: "acct_gone", plan: "plus", at: now() + 4 })).status, 404, "unknown account: stop charging");

  app.db.run("UPDATE accounts SET plan = 'unlimited' WHERE id = ?", me.accountId);
  const kept = await planRequest(app, base, { accountId: me.accountId, plan: "free", at: now() + 5 });
  assert.deepEqual(await kept.json(), { plan: "unlimited", changed: false });
  assert.equal(planOfRow(app, me.accountId), "unlimited", "the operator's Unlimited stays");
});

test("without billing configured there is no hand-off and no plan route", async (t) => {
  const { app, base } = await boot(t, { PURSS_MODE: "hosted" });
  const me = makeOwner(app, { admin: false });
  assert.equal((await call(app, base, "GET", "/api/session", signIn(app, me.accountId))).json.installation.billing, false);
  assert.equal((await call(app, base, "POST", "/api/billing/handoff", signIn(app, me.accountId), { intent: "plus_year" })).status, 404);
  assert.equal((await planRequest(app, base, { accountId: me.accountId, plan: "pro", at: now() })).status, 404);
});
