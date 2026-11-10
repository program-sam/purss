import test from "node:test";
import assert from "node:assert/strict";
import { bootDeletion, member, setCookie } from "../deletion-testing.ts";
import { signIn } from "../features-testing.ts";
import { HttpError } from "../http.ts";
import { resolveToken } from "./assistant.ts";
import { enqueue, expireLeases, leaseJobs } from "./jobs.ts";
import { shareRow } from "../features-testing.ts";
import { tick } from "../main.ts";
import { GRACE_DAYS } from "./deletion.ts";

test("deleting needs a recent sign-in and the exact display name, or the word delete without one", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const robin = await member(b.app, "Robin Hood");
  const stale = signIn(b.app, robin.accountId, { authAgeSeconds: 3600 });
  const denied = await b.api(stale, "POST", "/api/account/deletion", { confirm: "Robin Hood" });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "step_up");

  const fresh = signIn(b.app, robin.accountId);
  for (const wrong of ["robin hood", "Robin", "delete", ""]) {
    const r = await b.api(fresh, "POST", "/api/account/deletion", { confirm: wrong });
    assert.equal(r.status, 400, `“${wrong}” isn't the name`);
    assert.equal(r.json.error.code, "confirm_mismatch");
  }
  assert.equal(b.app.db.get("SELECT 1 FROM account_deletions"), undefined, "nothing was requested");

  const nameless = await member(b.app, null);
  const ns = signIn(b.app, nameless.accountId);
  assert.equal((await b.api(ns, "POST", "/api/account/deletion", { confirm: "Delete" })).json.error.code, "confirm_mismatch");
  const ok = await b.api(ns, "POST", "/api/account/deletion", { confirm: " delete " });
  assert.equal(ok.status, 200, ok.text);
  const dueIn = Date.parse(ok.json.dueAt) - Date.now();
  assert.ok(Math.abs(dueIn - GRACE_DAYS * 86_400_000) < 60_000, "due in seven days");
  assert.equal(setCookie(ok, "purss_session")?.header.includes("Max-Age=0"), true, "the session cookie is cleared");

  const named = await b.api(fresh, "POST", "/api/account/deletion", { confirm: "Robin Hood" });
  assert.equal(named.status, 200);
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'account_deletion_requested' AND actor_account_id = ? AND outcome = 'success'", robin.accountId));
});

test("the last administrator can't delete their account; two administrators asking at once leave exactly one", async (t) => {
  const b = await boot2();
  t.after(b.close);
  const [s1, s2] = [signIn(b.app, b.a1.accountId), signIn(b.app, b.a2.accountId)];
  const [r1, r2] = await Promise.all([
    b.api(s1, "POST", "/api/account/deletion", { confirm: "First" }),
    b.api(s2, "POST", "/api/account/deletion", { confirm: "Second" }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactly one goes ahead");
  const refused = r1.status === 409 ? r1 : r2;
  assert.equal(refused.json.error.code, "last_admin");
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM account_deletions")!.n, 1);

  // The remaining administrator is now the last one.
  const left = r1.status === 409 ? b.a1 : b.a2;
  const again = await b.api(signIn(b.app, left.accountId), "POST", "/api/account/deletion", { confirm: left === b.a1 ? "First" : "Second" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "last_admin");

  // An administrator who is suspended doesn't count as another administrator either.
  const third = await member(b.app, "Third", { admin: true });
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", third.accountId);
  assert.equal((await b.api(signIn(b.app, left.accountId), "POST", "/api/account/deletion", { confirm: left === b.a1 ? "First" : "Second" })).json.error.code, "last_admin");
});

async function boot2() {
  const b = await bootDeletion({ PURSS_MODE: "hosted" });
  return { ...b, a1: await member(b.app, "First", { admin: true }), a2: await member(b.app, "Second", { admin: true }) };
}

test("a request signs out everywhere and stops tokens, sharing, new jobs, leases, admin retries and admin changes", async (t) => {
  const b = await bootDeletion({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const admin = await member(b.app, "Admin", { admin: true });
  const as = signIn(b.app, admin.accountId);
  const pat = await member(b.app, "Pat");
  const other = signIn(b.app, pat.accountId);
  const current = signIn(b.app, pat.accountId);
  const patP = { accountId: pat.accountId, workspaceId: pat.workspaceId, isAdmin: false, sessionId: "x", csrf: "", authAt: new Date().toISOString() };

  // An assistant token, a published collection, a failed job and a running one.
  await b.api(as, "PUT", "/api/admin/assistant", { enabled: true });
  await b.api(current, "PUT", "/api/assistant", { enabled: true });
  const secret = (await b.api(current, "POST", "/api/assistant/tokens", { name: "Claude", access: "read" })).json.secret as string;
  assert.ok(!("error" in resolveToken(b.app, `Bearer ${secret}`)));
  const pub = { id: shareRow(b.app, patP, "collection", "col_00000000000000000000000000") };
  const failed = enqueue(b.app, "engine.sync", { engineUserId: pat.engineUserId }, { accountId: pat.accountId, workspaceId: pat.workspaceId, idempotencyKey: "sync-failed" });
  b.app.db.run("UPDATE jobs SET status = 'failed' WHERE id = ?", failed);
  b.app.db.run("DELETE FROM jobs WHERE kind = 'engine.provision'");
  const queued = enqueue(b.app, "engine.rename", { engineUserId: pat.engineUserId, streamId: "feed/1", title: "x" }, { accountId: pat.accountId, workspaceId: pat.workspaceId });

  const r = await b.api(current, "POST", "/api/account/deletion", { confirm: "Pat" });
  assert.equal(r.status, 200, r.text);

  assert.equal(b.app.db.get("SELECT 1 FROM sessions WHERE account_id = ?", pat.accountId), undefined, "every session is gone");
  for (const s of [current, other]) assert.equal((await b.api(s, "GET", "/api/bootstrap")).status, 401, "the principal no longer resolves");
  assert.equal(b.app.db.get("SELECT 1 FROM assistant_tokens WHERE account_id = ?", pat.accountId), undefined, "assistant tokens are revoked");
  assert.deepEqual(resolveToken(b.app, `Bearer ${secret}`), { error: "invalid" });
  assert.equal(b.app.db.get<{ status: string }>("SELECT status FROM shares WHERE id = ?", pub.id)!.status, "paused", "public pages stop");

  assert.throws(() => enqueue(b.app, "engine.sync", { engineUserId: pat.engineUserId }, { accountId: pat.accountId, workspaceId: pat.workspaceId }),
    (e: unknown) => e instanceof HttpError && e.code === "account_unavailable", "nothing new can be queued");
  assert.deepEqual(leaseJobs(b.app, ["engine.rename", "engine.sync"], 10).map((j) => j.id), [], "its jobs aren't leased");
  assert.equal(b.app.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", queued)!.status, "queued", "but they aren't cancelled either");
  const retry = await b.api(as, "POST", `/api/admin/jobs/${failed}/retry`);
  assert.equal(retry.status, 409, "an administrator can't restart them");
  assert.match(retry.json.error.message, /being deleted/);

  for (const patch of [{ status: "suspended" }, { status: "active" }, { isAdmin: true }, { allocationBytes: 1_000_000 }]) {
    const out = await b.api(as, "PATCH", `/api/admin/accounts/${pat.accountId}`, patch);
    assert.equal(out.status, 409, `admin change ${JSON.stringify(patch)} is refused`);
  }
  const listed = (await b.api(as, "GET", "/api/admin/accounts")).json.find((a: { id: string }) => a.id === pat.accountId);
  assert.equal(listed.deletion.state, "pending");
  assert.equal(listed.deletion.dueAt, r.json.dueAt);

  // Maintenance leaves it alone: no syncs, icon checks or reminders for a deleting account.
  b.app.db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, feed_url, engine_stream_id, health, created_at) VALUES ('src_pat', ?, ?, 'feed', 'Feed', 'RSS feed', 'https://example.org/f.xml', 'feed/9', 'ok', ?)",
    pat.accountId, pat.workspaceId, new Date().toISOString());
  tick(b.app);
  assert.equal(b.app.db.get("SELECT 1 FROM jobs WHERE account_id = ? AND kind IN ('engine.sync', 'source.icon') AND status = 'queued'", pat.accountId), undefined);
});

test("jobs resume intact when the account is kept, including one leased on its last attempt", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Mo");
  b.app.db.run("DELETE FROM jobs");
  const last = enqueue(b.app, "engine.rename", { engineUserId: m.engineUserId, streamId: "feed/1", title: "t" }, { accountId: m.accountId, workspaceId: m.workspaceId, maxAttempts: 1 });
  const [leased] = leaseJobs(b.app, ["engine.rename"], 1);
  assert.equal(leased!.attempts, 1, "its only attempt is running");

  assert.equal((await b.api(signIn(b.app, m.accountId), "POST", "/api/account/deletion", { confirm: "Mo" })).status, 200);
  const parked = b.app.db.get<{ status: string; attempts: number; lease_id: string | null }>("SELECT status, attempts, lease_id FROM jobs WHERE id = ?", last)!;
  assert.deepEqual({ ...parked }, { status: "queued", attempts: 0, lease_id: null }, "back in the queue with the attempt refunded");

  // The worker's next calls for it answer lease_lost, and the attempt stays refunded.
  for (const action of ["heartbeat", "complete", "fail"]) {
    const out = await b.worker(`/internal/jobs/${last}/${action}`, { leaseId: leased!.leaseId, error: "x", retryable: true, result: {} });
    assert.equal(out.status, 409, action);
    assert.equal(out.json.error.code, "lease_lost");
  }
  expireLeases(b.app);
  assert.deepEqual({ ...b.app.db.get("SELECT status, attempts FROM jobs WHERE id = ?", last)! }, { status: "queued", attempts: 0 });

  // Kept before the old lease would even have expired: the job runs its last attempt and completes.
  const signin = await b.api(null, "POST", "/api/auth/password", { username: m.username, password: m.password });
  assert.equal(signin.status, 409);
  const cookie = setCookie(signin, "purss_deletion")!.pair;
  assert.equal((await b.api(null, "POST", "/api/auth/deletion/cancel", {}, { cookie })).status, 200);
  const [again] = leaseJobs(b.app, ["engine.rename"], 1);
  assert.equal(again!.id, last);
  assert.equal(again!.attempts, 1);
  assert.equal((await b.worker(`/internal/jobs/${last}/complete`, { leaseId: again!.leaseId, result: {} })).status, 200);
  assert.equal(b.app.db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", last)!.status, "done");
});

test("a job whose account becomes unusable while leased waits instead of using up attempts", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Sam");
  b.app.db.run("DELETE FROM jobs");
  const id = enqueue(b.app, "engine.rename", { engineUserId: m.engineUserId, streamId: "feed/1", title: "t" }, { accountId: m.accountId, workspaceId: m.workspaceId, maxAttempts: 1 });

  // Suspension keeps the lease: an expired lease goes back to the queue without counting.
  leaseJobs(b.app, ["engine.rename"], 1);
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", m.accountId);
  b.app.db.run("UPDATE jobs SET lease_expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), id);
  expireLeases(b.app);
  assert.deepEqual({ ...b.app.db.get("SELECT status, attempts, lease_id FROM jobs WHERE id = ?", id)! }, { status: "queued", attempts: 0, lease_id: null });

  // A failure reported for it is answered lease_lost and returns it to the queue the same way.
  b.app.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", m.accountId);
  const [job] = leaseJobs(b.app, ["engine.rename"], 1);
  b.app.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", m.accountId);
  const fail = await b.worker(`/internal/jobs/${id}/fail`, { leaseId: job!.leaseId, error: "engine down", retryable: true });
  assert.equal(fail.status, 409);
  assert.deepEqual({ ...b.app.db.get("SELECT status, attempts, lease_id FROM jobs WHERE id = ?", id)! }, { status: "queued", attempts: 0, lease_id: null });
  assert.deepEqual(leaseJobs(b.app, ["engine.rename"], 1), [], "and it waits");
  b.app.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", m.accountId);
  assert.equal(leaseJobs(b.app, ["engine.rename"], 1)[0]!.attempts, 1, "back with its attempt intact");
});
