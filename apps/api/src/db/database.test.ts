import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "./database.ts";

test("writes go on after a search index delete leaves a last rowid past 2^53, and inserts still report their own rowid", () => {
  const db = new Database(":memory:");
  // Like items_fts: once its segments have been merged, deleting from a contentless_delete index writes
  // a tombstone page under a rowid past 2^53, and the connection keeps that as its last inserted rowid.
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(body, content = '', contentless_delete = 1); CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
  for (let i = 1; i <= 40; i++) db.run("INSERT INTO fts (rowid, body) VALUES (?, ?)", i, `words ${i}`);
  db.run("DELETE FROM fts WHERE rowid = ?", 1);
  assert.equal(db.run("DELETE FROM fts WHERE rowid = ?", 4).changes, 1);
  const last = db.raw.prepare("SELECT last_insert_rowid() AS r");
  last.setReadBigInts(true);
  assert.ok((last.get() as { r: bigint }).r > BigInt(Number.MAX_SAFE_INTEGER), "the case this guards against");
  assert.deepEqual(db.run("INSERT INTO t (n) VALUES (?)", 7), { changes: 1, lastInsertRowid: 1 });
  assert.equal(db.run("UPDATE t SET n = ? WHERE id = ?", 8, 1).changes, 1);
  assert.deepEqual({ ...db.get("SELECT id, n FROM t")! }, { id: 1, n: 8 }, "reads still give numbers");
});
