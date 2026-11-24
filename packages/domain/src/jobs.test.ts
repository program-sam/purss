import test from "node:test";
import assert from "node:assert/strict";
import { JOB_KINDS, isJobKind, jobResultSchemas } from "./jobs.ts";

/*
 * The results a worker reports are read by the API per kind. A worker of the version before or after this one is
 * on the wire during a rolling deploy, so what it may send (more fields, fewer fields) must be accepted.
 */

test("every kind has a result schema, and kinds are told apart from names a worker or a row of another version may bring", () => {
  assert.deepEqual(Object.keys(jobResultSchemas).sort(), [...JOB_KINDS].sort());
  assert.equal(isJobKind("engine.sync"), true);
  for (const other of ["media.save", "", "constructor", "__proto__"]) assert.equal(isJobKind(other), false, other);
});

test("a provision or subscribe result is accepted with the fields of older and newer workers, whatever shape its metadata has; only a missing stream id is refused", () => {
  const provision = jobResultSchemas["engine.provision"];
  assert.ok(provision.safeParse({ engineUserId: "eu", username: "u", engineIdentity: "freshrss:a", created: true }).success);
  assert.ok(provision.safeParse({}).success, "a worker that doesn't say which engine it is");
  for (const engineIdentity of [null, 7, { id: 1 }]) assert.ok(provision.safeParse({ engineIdentity }).success, JSON.stringify(engineIdentity));

  const subscribe = jobResultSchemas["engine.subscribe"];
  assert.ok(subscribe.safeParse({ streamId: "feed/9", title: "T", alreadySubscribed: false }).success, "before it reported empty feeds and the gateway");
  assert.ok(subscribe.safeParse({ streamId: "feed/9", title: "T", alreadySubscribed: true, viaGateway: true, empty: false, something: "newer" }).success);
  for (const odd of [{ empty: null }, { viaGateway: null }, { empty: "yes", viaGateway: 1 }]) assert.ok(subscribe.safeParse({ streamId: "feed/9", ...odd }).success, JSON.stringify(odd));
  for (const bad of [{}, { streamId: "" }, { streamId: 9 }, { streamId: null }, { empty: true }]) assert.equal(subscribe.safeParse(bad).success, false, JSON.stringify(bad));
});

test("a Smart filter result is accepted without the fields an older worker did not send, and the missing ones read as nothing", () => {
  const judge = jobResultSchemas["filter.judge"];
  const older = judge.parse({ route: "server", model: "jev-1", verdicts: [{ itemId: "i", answers: { f1_x: 0.4 }, inputTokens: 5 }] });
  assert.deepEqual([older.keyRejected, older.keyFingerprint, older.unfinished], [false, null, []]);
  assert.ok(judge.safeParse({ route: null, model: null, keyRejected: true, keyFingerprint: null, unfinished: [], verdicts: [] }).success);
  assert.equal(judge.safeParse({ route: "elsewhere", model: null, verdicts: [] }).success, false);
});

test("the results the API reads from the stored copies are any object", () => {
  for (const kind of ["capture.fulltext", "capture.images", "source.icon", "engine.sync", "engine.unsubscribe", "engine.rename", "engine.mark_read", "engine.delete_user"] as const) {
    assert.ok(jobResultSchemas[kind].safeParse({ anything: [1, { at: "all" }] }).success, kind);
    assert.ok(jobResultSchemas[kind].safeParse({}).success, kind);
  }
});
