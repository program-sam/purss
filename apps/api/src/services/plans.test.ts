import test from "node:test";
import assert from "node:assert/strict";
import { newId, PLAN_LIMITS } from "@purss/domain";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { createCollection } from "./collections.ts";
import { holdCandidate } from "./discovery-cache.ts";
import { applyImport, stageImport, streamExport } from "./portability.ts";
import { assignMissingPlans, capacity } from "./plans.ts";
import { followSource, unfollowSource } from "./sources.ts";
import { updateAccount } from "./admin.ts";
import { OPTIONAL_SECTION_NAMES, SECTION_NAMES, sha256Hex } from "./archive-format.ts";

const base = { collectionId: null, newCollectionName: null, showOnHome: true, markPrivate: false, fullText: false };
const hosted = () => makeTestApp({ PURSS_MODE: "hosted", PURSS_PUBLIC_ORIGIN: "https://workspace.example" });

function hold(p: Principal, n: number): string {
  const token = newId("dsc");
  holdCandidate(token, p.workspaceId, {
    feedUrl: `https://example.org/new/${n}.xml`, siteUrl: "https://example.org/", title: `New ${n}`, kind: "feed",
    origin: "RSS feed", via: "Posts feed", cadence: null, samples: [], summariesOnly: false, privateWarning: null,
  });
  return token;
}

const fill = (app: App, p: Principal, n: number, prefix = "feed") => { for (let i = 0; i < n; i++) makeSource(app, p, `Source ${i}`, `${prefix}/${i}`); };
const collection = (app: App, p: Principal, name: string) => createCollection(app, p, { name, emoji: null, mode: "sources", sourceIds: [], query: null, view: "list" });
/** Recompute the manifest after editing a section, as a foreign producer could. */
function rebuild(doc: any): any {
  const sections: Record<string, { count: number; sha256: string }> = {};
  for (const n of [...SECTION_NAMES, ...OPTIONAL_SECTION_NAMES]) if (doc[n] !== undefined) sections[n] = { count: Array.isArray(doc[n]) ? doc[n].length : 1, sha256: sha256Hex(JSON.stringify(doc[n])) };
  return { ...doc, manifest: { algorithm: "sha256", sections } };
}
const refused = (code: string) => (e: unknown) => e instanceof HttpError && e.status === 403 && e.code === code;

test("Free allows 100 followed sources; the 101st is refused, saved links and unfollowed sources don't count", (t) => {
  const { app, cleanup } = hosted();
  t.after(cleanup);
  const p = makeOwner(app, { admin: false });
  assert.equal(capacity(app, p.accountId).plan, "free");
  fill(app, p, PLAN_LIMITS.free.sources! - 1);
  makeSource(app, p, "Saved links", "manual/1", { kind: "manual" });
  followSource(app, p, { ...base, token: hold(p, 1) });
  assert.deepEqual(capacity(app, p.accountId).sources, { used: 100, limit: 100 });
  assert.throws(() => followSource(app, p, { ...base, token: hold(p, 2) }), refused("plan_limit"));
  assert.equal(capacity(app, p.accountId).sources.used, 100, "nothing was added");

  const first = app.db.get<{ id: string }>("SELECT id FROM sources WHERE account_id = ? AND kind = 'feed' ORDER BY created_at LIMIT 1", p.accountId)!.id;
  unfollowSource(app, p, first);
  followSource(app, p, { ...base, token: hold(p, 2) });
  assert.equal(capacity(app, p.accountId).sources.used, 100);
});

test("following again an address already followed is not a new source, even at the limit", (t) => {
  const { app, cleanup } = hosted();
  t.after(cleanup);
  const p = makeOwner(app, { admin: false });
  fill(app, p, PLAN_LIMITS.free.sources! - 1);
  const s = followSource(app, p, { ...base, token: hold(p, 7) });
  assert.equal(followSource(app, p, { ...base, token: hold(p, 7) }).id, s.id);
});

test("Free allows 4 collections, also when made while following; Plus has no collection limit", (t) => {
  const { app, cleanup } = hosted();
  t.after(cleanup);
  const p = makeOwner(app, { admin: false });
  for (let i = 0; i < 4; i++) collection(app, p, `C${i}`);
  assert.throws(() => collection(app, p, "C4"), refused("plan_limit"));
  assert.throws(() => followSource(app, p, { ...base, token: hold(p, 1), newCollectionName: "Via follow" }), refused("plan_limit"));
  assert.equal(capacity(app, p.accountId).sources.used, 0, "the refused follow added no source either");

  updateAccount(app, makeOwner(app), p.accountId, { plan: "plus" });
  for (let i = 4; i < 12; i++) collection(app, p, `C${i}`);
  assert.deepEqual(capacity(app, p.accountId).collections, { used: 12, limit: null });
});

test("a smaller plan keeps what the account has and only stops new follows", (t) => {
  const { app, cleanup } = hosted();
  t.after(cleanup);
  const admin = makeOwner(app);
  const p = makeOwner(app, { admin: false });
  updateAccount(app, admin, p.accountId, { plan: "plus" });
  fill(app, p, 120);
  updateAccount(app, admin, p.accountId, { plan: "free" });
  assert.deepEqual(capacity(app, p.accountId).sources, { used: 120, limit: 100 });
  assert.throws(() => followSource(app, p, { ...base, token: hold(p, 1) }), refused("plan_limit"));
});

test("self-hosted installs have no plans or limits; administrators on hosted installs are unlimited", (t) => {
  const self = makeTestApp();
  t.after(self.cleanup);
  const p = makeOwner(self.app, { admin: false });
  for (let i = 0; i < 6; i++) collection(self.app, p, `C${i}`);
  assert.deepEqual(capacity(self.app, p.accountId), { plan: null, sources: { used: 0, limit: null }, collections: { used: 6, limit: null } });

  const h = hosted();
  t.after(h.cleanup);
  const admin = makeOwner(h.app);
  assert.equal(capacity(h.app, admin.accountId).plan, "unlimited");
  for (let i = 0; i < 6; i++) collection(h.app, admin, `C${i}`);
});

test("on a hosted install, accounts from before plans get one when the API starts", (t) => {
  const { app, cleanup } = hosted();
  t.after(cleanup);
  const admin = makeOwner(app);
  const p = makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET plan = NULL");
  assignMissingPlans(app);
  assert.equal(capacity(app, admin.accountId).plan, "unlimited");
  assert.equal(capacity(app, p.accountId).plan, "free");
});

test("an import that would follow more sources or add more collections than the plan allows is refused before anything is written", async (t) => {
  const from = makeTestApp();
  t.after(from.cleanup);
  const pa = makeOwner(from.app);
  fill(from.app, pa, 30, "theirs");
  for (let i = 0; i < 3; i++) collection(from.app, pa, `C${i}`);
  const parts: string[] = [];
  await streamExport(from.app, pa, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));

  const { app, cleanup } = hosted();
  t.after(cleanup);
  const p = makeOwner(app, { admin: false });
  fill(app, p, 80);
  const preview = stageImport(app, p, doc);
  assert.match(preview.overPlan ?? "", /allows 100 sources/);
  assert.throws(() => applyImport(app, p, preview.token), refused("plan_limit"));
  assert.equal(capacity(app, p.accountId).sources.used, 80, "nothing was imported");

  collection(app, p, "Mine");
  collection(app, p, "Mine too");
  app.db.run("DELETE FROM sources WHERE account_id = ? AND title LIKE 'Source 1%'", p.accountId);
  const again = stageImport(app, p, doc);
  assert.match(again.overPlan ?? "", /allows 4 collections/, "now the sources fit, but 2 + 3 collections don't");
});

test("an administrator is unlimited while they are one, whatever plan they keep for afterwards", (t) => {
  const { app, cleanup } = hosted();
  t.after(cleanup);
  const admin = makeOwner(app);
  const p = makeOwner(app, { admin: false });
  for (let i = 0; i < 4; i++) collection(app, p, `C${i}`);
  updateAccount(app, admin, p.accountId, { isAdmin: true });
  assert.equal(capacity(app, p.accountId).plan, "unlimited");
  collection(app, p, "C4");
  updateAccount(app, makeOwner(app), p.accountId, { isAdmin: false });
  assert.equal(capacity(app, p.accountId).plan, "free", "back on the plan they had");
  assert.throws(() => collection(app, p, "C5"), refused("plan_limit"));
});

test("an import whose records land on one source counts that source once", async (t) => {
  const from = makeTestApp();
  t.after(from.cleanup);
  const pa = makeOwner(from.app);
  makeSource(from.app, pa, "Shared", "shared");
  const parts: string[] = [];
  await streamExport(from.app, pa, (c) => { parts.push(c); });
  const doc = JSON.parse(parts.join(""));
  const twin = { ...doc.sources[0], id: "src_twin", feedUrl: `${doc.sources[0].feedUrl}/` };
  doc.sources.push(twin);

  const { app, cleanup } = hosted();
  t.after(cleanup);
  const p = makeOwner(app, { admin: false });
  fill(app, p, PLAN_LIMITS.free.sources! - 1);
  const shared = makeSource(app, p, "Shared", "shared");
  unfollowSource(app, p, shared);
  const preview = stageImport(app, p, rebuild(doc));
  assert.equal(preview.overPlan, null);
  applyImport(app, p, preview.token);
  assert.deepEqual(capacity(app, p.accountId).sources, { used: 100, limit: 100 });
});
