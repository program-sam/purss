import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeOwner, makeTestApp } from "../../api/src/testing.ts";
import { signedInPrincipal } from "../../api/src/features-testing.ts";
import { internalRouter } from "../../api/src/routes/internal.ts";
import { internalServer } from "../../api/src/server.ts";
import { enqueue } from "../../api/src/services/jobs.ts";
import { requestDeletion, runDeletions } from "../../api/src/services/deletion.ts";
import type { App } from "../../api/src/app.ts";
import { createHandlers, defaultMakeClient } from "./handlers.ts";
import { InternalApi } from "./internal-api.ts";
import { createLogger } from "./log.ts";
import { Worker } from "./runner.ts";
import type { Handlers } from "./runner.ts";
import { EngineUserSecrets } from "./secrets.ts";

/*
 * The worker against the real API (internal listener, real database): what happens to its jobs
 * when an account is deleted, and the deletion's engine step from lease to finalize.
 */

const quiet = createLogger(() => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await wait(10);
  }
}

async function stack(handlers: (api: InternalApi) => Handlers) {
  const { app, cleanup } = makeTestApp();
  const server: Server = internalServer(app, internalRouter(app));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = new InternalApi({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: { get: () => app.serviceToken, invalidate() {} }, retryDelaysMs: [10] });
  const worker = new Worker({ api, handlers: handlers(api), log: quiet, concurrency: 2, pollIntervalMs: 20, maxBackoffMs: 200, drainTimeoutMs: 2000 });
  let loop: Promise<void> | null = null;
  return {
    app, api, worker,
    start() { loop = worker.run(); },
    async stop() {
      await worker.drain();
      await loop;
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
      cleanup();
    },
  };
}

const job = (app: App, id: string) => app.db.get<{ status: string; attempts: number; lease_id: string | null }>("SELECT status, attempts, lease_id FROM jobs WHERE id = ?", id)!;

test("a job running when its account asks to be deleted goes back to the queue unspent, waits, and resumes when the account is kept", async () => {
  let release!: () => void;
  let runs = 0;
  const s = await stack(() => ({
    "engine.rename": async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => { release = r; });
      return { renamed: true };
    },
  }));
  try {
    makeOwner(s.app, { admin: true });
    const m = makeOwner(s.app, { admin: false });
    s.app.db.run("DELETE FROM jobs");
    const id = enqueue(s.app, "engine.rename", { engineUserId: m.engineUserId, streamId: "feed/1", title: "t" }, { accountId: m.accountId, workspaceId: m.workspaceId, maxAttempts: 1 });
    s.start();
    await until(() => runs === 1);
    assert.equal(job(s.app, id).attempts, 1, "its only attempt is running");

    requestDeletion(s.app, signedInPrincipal(s.app, m.accountId), "delete");
    release();
    await until(() => job(s.app, id).status === "queued" && job(s.app, id).lease_id === null);
    await wait(150); // several poll intervals
    assert.equal(runs, 1, "the worker doesn't lease it while the account is being deleted");
    assert.deepEqual({ ...job(s.app, id) }, { status: "queued", attempts: 0, lease_id: null }, "the completion was refused and the attempt refunded");

    s.app.db.run("DELETE FROM account_deletions WHERE account_id = ?", m.accountId); // the account was kept
    await until(() => job(s.app, id).status === "done");
    assert.equal(job(s.app, id).attempts, 1, "it ran its last attempt after all");
  } finally {
    await s.stop();
  }
});

test("the engine step of a deletion runs from lease to finalize against the real API", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "purss-worker-del-"));
  const users = new Set<string>();
  const secrets = new EngineUserSecrets(path.join(dir, "engine-users"));
  const s = await stack((api) => createHandlers({
    api,
    secrets,
    secretsDir: dir,
    admin: {
      ensureUser: async ({ username }) => { users.add(username); return { created: true }; },
      engineIdentity: async () => "freshrss:test",
      userExists: async (u) => users.has(u),
      deleteUser: async (u) => { users.delete(u); },
    },
    log: quiet,
    makeClient: defaultMakeClient(1000),
    syncPageSize: 10, syncOverlapSeconds: 0, syncMaxBatchBytes: 700_000, requestTimeoutMs: 1000,
  }));
  try {
    makeOwner(s.app, { admin: true });
    const m = makeOwner(s.app, { admin: false });
    const username = s.app.db.get<{ username: string }>("SELECT username FROM engine_users WHERE id = ?", m.engineUserId)!.username;
    users.add(username);
    secrets.ensure(m.engineUserId);
    requestDeletion(s.app, signedInPrincipal(s.app, m.accountId), "delete");
    s.app.db.run("UPDATE account_deletions SET due_at = ? WHERE account_id = ?", new Date(Date.now() - 1000).toISOString(), m.accountId);
    runDeletions(s.app);
    s.app.db.run("DELETE FROM jobs WHERE kind <> 'engine.delete_user'"); // only the deletion's job runs here
    s.start();
    await until(() => !s.app.db.get("SELECT 1 FROM accounts WHERE id = ?", m.accountId));
    assert.equal(users.has(username), false, "the engine user is gone");
    assert.equal(existsSync(path.join(dir, "engine-users", m.engineUserId)), false, "and its stored password");
    assert.equal(s.app.db.get("SELECT 1 FROM jobs WHERE account_id = ?", m.accountId), undefined, "the job removed itself");
    assert.ok(s.app.db.get("SELECT 1 FROM audit_events WHERE action = 'account_deleted' AND target = ?", m.accountId));
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
