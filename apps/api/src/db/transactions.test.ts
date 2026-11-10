import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "./database.ts";

function open() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (n INTEGER) STRICT; CREATE TRIGGER stop BEFORE INSERT ON t WHEN NEW.n = 99 BEGIN SELECT RAISE(ROLLBACK, 'ended by the database'); END");
  return db;
}
const rows = (db: Database) => db.all<{ n: number }>("SELECT n FROM t ORDER BY n").map((r) => r.n);

test("a savepoint that fails is undone alone; the outer transaction goes on", () => {
  const db = open();
  db.tx(() => {
    db.run("INSERT INTO t VALUES (1)");
    assert.throws(() => db.tx(() => { db.run("INSERT INTO t VALUES (2)"); throw new Error("ordinary"); }), /ordinary/);
    assert.equal(db.inTransaction, true);
    db.run("INSERT INTO t VALUES (3)");
  });
  assert.deepEqual(rows(db), [1, 3]);
});

test("when the database ends the whole transaction inside a savepoint, the error that did it is the one thrown, and nothing is left half done", () => {
  const db = open();
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO t VALUES (1)");
    db.tx(() => db.run("INSERT INTO t VALUES (99)"));
    db.run("INSERT INTO t VALUES (3)");
  }), /ended by the database/);
  assert.equal(db.inTransaction, false);
  assert.deepEqual(rows(db), [], "the first insert went with it");
  // The connection is usable afterwards, and a new transaction starts from a clean depth.
  db.tx(() => db.run("INSERT INTO t VALUES (5)"));
  assert.deepEqual(rows(db), [5]);
});

test("a caller that swallows that error cannot keep writing: nothing more runs in the ended transaction, so nothing half-commits", () => {
  const db = open();
  let afterwards: unknown = null;
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO t VALUES (1)");
    try { db.tx(() => db.run("INSERT INTO t VALUES (99)")); } catch { /* swallowed, as a careless caller might */ }
    assert.equal(db.inTransaction, false);
    // Every way back into the database now refuses, so these are not run in autocommit and kept.
    for (const attempt of [
      () => db.run("INSERT INTO t VALUES (3)"),
      () => db.get("SELECT n FROM t"),
      () => db.all("SELECT n FROM t"),
      () => db.exec("INSERT INTO t VALUES (5)"),
      () => db.tx(() => db.run("INSERT INTO t VALUES (6)")),
    ]) assert.throws(attempt, /ended the transaction/);
    db.run("INSERT INTO t VALUES (4)"); // the caller carries on regardless: this refuses too
    afterwards = "reached";
  }), /ended the transaction/);
  assert.equal(afterwards, null, "the function was cut short at its first write after the transaction ended");
  assert.equal(db.inTransaction, false);
  assert.deepEqual(rows(db), [], "none of the rows survived, the first included");
  // The connection works afterwards: depth is back to zero.
  db.tx(() => db.run("INSERT INTO t VALUES (7)"));
  assert.deepEqual(rows(db), [7]);
});

test("a transaction that ended inside the outermost one is reported even when only reads follow", () => {
  const db = open();
  assert.throws(() => db.tx(() => {
    try { db.tx(() => db.run("INSERT INTO t VALUES (99)")); } catch { /* swallowed */ }
    return db.all("SELECT n FROM t");
  }), /ended the transaction/);
  assert.deepEqual(rows(db), []);
});

test("refreshPause keeps a pause that still holds and clears one that no longer does, and hides nothing else", async () => {
  const { makeOwner, makeTestApp } = await import("../testing.ts");
  const { refreshPause } = await import("../services/storage.ts");
  const { app, cleanup } = makeTestApp();
  try {
    const p = makeOwner(app, { allocationBytes: 1000 });
    const pause = () => app.db.get<{ paused_reason: string | null }>("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", p.accountId)!.paused_reason;
    app.db.run("UPDATE storage_accounts SET used_bytes = 1000, paused_reason = 'quota' WHERE account_id = ?", p.accountId);
    refreshPause(app, p.accountId);
    assert.equal(pause(), "quota", "still full: still paused, and no error");
    app.db.run("UPDATE storage_accounts SET used_bytes = 0 WHERE account_id = ?", p.accountId);
    // The database ends the transaction the moment the pause is cleared: that is not "still paused", and it is not swallowed.
    app.db.exec("CREATE TRIGGER stop_clearing BEFORE UPDATE OF paused_reason ON storage_accounts BEGIN SELECT RAISE(ROLLBACK, 'ended by the database'); END");
    assert.throws(() => app.db.tx(() => refreshPause(app, p.accountId)), /ended by the database/);
    app.db.exec("DROP TRIGGER stop_clearing");
    refreshPause(app, p.accountId);
    assert.equal(pause(), null, "room again: cleared");
  } finally { cleanup(); }
});
