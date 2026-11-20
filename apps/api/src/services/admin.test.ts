import test from "node:test";
import assert from "node:assert/strict";
import { server } from "@purss/copy/server";
import { makeOwner, makeTestApp } from "../testing.ts";
import { adminHealth } from "./admin.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");

function lastSync(app: ReturnType<typeof makeTestApp>["app"], engineUserId: string, at: string, error: string | null = null) {
  app.db.run(
    "INSERT INTO sync_checkpoints (engine_user_id, last_success_at, last_error) VALUES (?, ?, ?) ON CONFLICT (engine_user_id) DO UPDATE SET last_success_at = excluded.last_success_at, last_error = excluded.last_error",
    engineUserId, at, error,
  );
}

test("the engine reads as not syncing when no sync has succeeded for many intervals and no error was recorded", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);

  lastSync(app, p.engineUserId, new Date(NOW - 60_000).toISOString());
  assert.equal((await adminHealth(app, NOW)).engine.status, "ok", "a sync a minute ago is running");

  lastSync(app, p.engineUserId, new Date(NOW - 4 * 86_400_000).toISOString());
  const stale = (await adminHealth(app, NOW)).engine;
  assert.equal(stale.status, "stalled", "four days without a sync is not running, even with no error recorded");
  assert.equal(stale.message, server.api.admin.syncStalled);

  const newcomer = makeOwner(app);
  app.db.run("UPDATE engine_users SET status = 'pending' WHERE id = ?", newcomer.engineUserId);
  assert.equal((await adminHealth(app, NOW)).engine.status, "stalled", "an account still being set up doesn't hide a stalled sync");
  app.db.run("UPDATE engine_users SET status = 'ready' WHERE id = ?", newcomer.engineUserId);

  lastSync(app, p.engineUserId, new Date(NOW - 4 * 86_400_000).toISOString(), "connection refused");
  assert.equal((await adminHealth(app, NOW)).engine.status, "degraded", "a recorded error on one of two accounts reads as partly failing");
});
