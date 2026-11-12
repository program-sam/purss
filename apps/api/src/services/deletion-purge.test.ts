import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { createInvite } from "../auth/accounts.ts";
import { runCommand } from "../cli.ts";
import { bootDeletion, makeDue, member, rowsMentioning, seedAdjacent } from "../deletion-testing.ts";
import type { DeletionBoot, Member } from "../deletion-testing.ts";
import { seedLibrary, signIn } from "../features-testing.ts";
import { nowIso } from "../http.ts";
import { writeSecret } from "../secrets.ts";
import { batch, entry, makeOwner, makeSource } from "../testing.ts";
import { claimDeletion, runDeletions } from "./deletion.ts";
import { createBasket, createCollection } from "./collections.ts";
import { enqueue, expireLeases } from "./jobs.ts";
import { setPreferences } from "./preferences.ts";
import { setShareNote } from "./shares.ts";
import { shareRow } from "../features-testing.ts";
import { changeState, keepItem } from "./state.ts";
import { reserve } from "./storage.ts";
import { applySyncBatch, recordSyncSuccess } from "./sync.ts";
import { stageFile } from "./portability.ts";
import { createNewsPost } from "./news.ts";

const principal = (m: Member): Principal & { engineUserId: string } =>
  ({ accountId: m.accountId, workspaceId: m.workspaceId, isAdmin: false, sessionId: "seed", csrf: "", authAt: nowIso(), engineUserId: m.engineUserId });

async function requested(b: DeletionBoot, m: Member, name: string): Promise<void> {
  const r = await b.api(signIn(b.app, m.accountId), "POST", "/api/account/deletion", { confirm: name });
  assert.equal(r.status, 200, r.text);
}

/** A private source with its secret file, and a staged import with its file: what the manifest must name. */
function withFiles(app: App, m: Member): { secret: string; stage: string } {
  const sourceId = newId("src");
  app.db.run("INSERT INTO sources (id, account_id, workspace_id, kind, title, origin, is_private, engine_stream_id, health, created_at) VALUES (?, ?, ?, 'private', 'Private', 'RSS feed', 1, ?, 'ok', ?)",
    sourceId, m.accountId, m.workspaceId, `feed/${sourceId}`, nowIso());
  writeSecret(app.config.secretsDir, `source-urls/${sourceId}`, "https://feeds.example/secret?token=abc");
  const token = newId("stg");
  app.db.run("INSERT INTO import_stages (token, account_id, workspace_id, bytes, sha256, summary, created_at, expires_at) VALUES (?, ?, ?, 2, 'x', '{}', ?, ?)",
    token, m.accountId, m.workspaceId, nowIso(), new Date(Date.now() + 3600_000).toISOString());
  mkdirSync(path.dirname(stageFile(app, token)), { recursive: true });
  writeFileSync(stageFile(app, token), "{}");
  return { secret: path.join(app.config.secretsDir, "source-urls", sourceId), stage: stageFile(app, token) };
}

/** Rows in every table that holds account data, through the real services where there is one. */
function populate(app: App, m: Member, owner: Member): string[] {
  const p = principal(m);
  const lib = seedLibrary(app, p);
  const files = withFiles(app, m);
  const reading = createCollection(app, p, { name: "Reading", emoji: null, mode: "sources", sourceIds: [lib.publicSource], query: null, view: "list" });
  // Smart filters (plan/36): a filter on a source and one on a collection, an answer and a week's usage.
  const sourceFilter = newId("aif");
  app.db.run("INSERT INTO ai_filters (id, workspace_id, source_id, keep_text, created_at, updated_at) VALUES (?, ?, ?, 'Keep posts about sediment', ?, ?)", sourceFilter, m.workspaceId, lib.publicSource, nowIso(), nowIso());
  app.db.run("INSERT INTO ai_filters (id, workspace_id, collection_id, keep_text, created_at, updated_at) VALUES (?, ?, ?, 'Keep long reads', ?, ?)", newId("aif"), m.workspaceId, reading.id, nowIso(), nowIso());
  app.db.run("INSERT INTO ai_filter_verdicts (filter_id, item_id, workspace_id, version, keep_probability, dropped, judged_at) VALUES (?, ?, ?, 1, 0.9, 0, ?)", sourceFilter, lib.itemIds[0]!, m.workspaceId, nowIso());
  app.db.run("INSERT INTO ai_usage (account_id, week, input_tokens, requests) VALUES (?, '2026-W46', 300, 1)", m.accountId);
  const revision = app.db.get<{ revision: number }>("SELECT revision FROM item_state WHERE item_id = ?", lib.itemIds[1])!.revision;
  changeState(app, p, lib.itemIds[1], { workflow: "toread", expectedRevision: revision }); // state, state log, undo token
  setPreferences(app, m.workspaceId, { theme: "dark" });
  const shareId = shareRow(app, p, "basket", lib.baskets.reading, "published", "M");
  setShareNote(app, p, shareId, lib.keptIds[0]!, "A public note.");
  app.db.run("INSERT INTO share_reports (id, share_id, reason, details, created_at) VALUES (?, ?, 'spam', 'A visitor reported it.', ?)", newId("rpt"), shareId, nowIso());
  app.db.run("INSERT INTO confirm_tokens (token, workspace_id, purpose, data, expires_at) VALUES ('ct1', ?, 'item-delete', '[]', ?)", m.workspaceId, new Date(Date.now() + 600_000).toISOString());
  app.db.run("INSERT INTO reminders (id, workspace_id, item_id, basket_id, kept_at, for_date, created_at) VALUES (?, ?, ?, ?, ?, '2026-11-05', ?)", newId("rem"), m.workspaceId, lib.keptIds[0]!, lib.baskets.reading, nowIso(), nowIso());
  app.db.run("INSERT INTO item_reminders (id, account_id, workspace_id, item_id, remind_on, note, created_at) VALUES (?, ?, ?, ?, '2026-11-20', 'Ask again', ?)", newId("irm"), m.accountId, m.workspaceId, lib.keptIds[0]!, nowIso()); // "Remind me"
  app.db.run("INSERT INTO discovery_dismissed (workspace_id, key, created_at) VALUES (?, 'example.org/not-for-me.xml', ?)", m.workspaceId, nowIso()); // "Not interested" in Discover
  app.db.run("INSERT INTO notifications (id, workspace_id, kind, title, dedup_key, created_at) VALUES (?, ?, 'arrivals', 'New', 'n1', ?)", newId("ntf"), m.workspaceId, nowIso());
  app.db.run("INSERT INTO notification_state (workspace_id, window_end) VALUES (?, ?)", m.workspaceId, nowIso()); // digest watermark
  app.db.run("INSERT OR IGNORE INTO signup_creations (account_id, address_hash, created_at) VALUES (?, 'address', ?)", m.accountId, nowIso()); // counted against the sign-up limit
  app.db.run("INSERT INTO reconciliation_queue (id, workspace_id, engine_user_id, entry, created_at) VALUES (?, ?, ?, '{}', ?)", newId("rec"), m.workspaceId, m.engineUserId, nowIso());
  app.db.run("INSERT INTO source_icons (source_id, account_id, workspace_id, bytes, digest, found_url, updated_at) VALUES (?, ?, ?, x'00', 'd', 'https://example.org/i.png', ?)", lib.publicSource, m.accountId, m.workspaceId, nowIso());
  app.db.run("INSERT INTO item_tombstones (engine_user_id, external_id, deleted_at) VALUES (?, 'gone', ?)", m.engineUserId, nowIso());
  app.db.run("INSERT INTO auth_challenges (id, purpose, account_id, challenge, expires_at) VALUES (?, 'register', ?, 'c', ?)", newId("chl"), m.accountId, new Date(Date.now() + 300_000).toISOString());
  app.db.run("INSERT INTO assistant_tokens (id, account_id, name, access, token_hash, created_at) VALUES (?, ?, 'T', 'read', ?, ?)", newId("tok"), m.accountId, newId("hash"), nowIso());
  app.db.run("INSERT INTO role_grants (account_id, role, granted_at, granted_by) VALUES (?, 'admin', ?, NULL)", m.accountId, nowIso());
  app.db.run("UPDATE role_grants SET granted_by = ? WHERE account_id = ?", m.accountId, owner.accountId); // the member once made the owner an administrator
  createInvite(app, m.accountId, "invited@example.test", "from the member", null);
  createInvite(app, owner.accountId, "invited@example.test", "for the member", null);
  app.db.run("UPDATE invites SET used_at = ?, used_by = ? WHERE note = 'for the member'", nowIso(), m.accountId);
  reserve(app, m.accountId, 10, "test", `res:${m.accountId}`);
  recordSyncSuccess(app, m.engineUserId);
  signIn(app, m.accountId);
  enqueue(app, "engine.sync", { engineUserId: m.engineUserId }, { accountId: m.accountId, workspaceId: m.workspaceId });
  seedAdjacent(app, p); // connected apps, playback, annotations, browser capture, a kept picture, email, OAuth
  // A list of feeds being followed, with a private link waiting in the secrets folder.
  const list = newId("opl");
  app.db.run("INSERT INTO opml_imports (id, account_id, workspace_id, file_name, destination, status, created_at) VALUES (?, ?, ?, 'list.opml', 'none', 'running', ?)", list, m.accountId, m.workspaceId, nowIso());
  app.db.run("INSERT INTO opml_import_entries (import_id, position, title, host, feed_url, looks_private) VALUES (?, 0, 'Private one', 'feeds.example', NULL, 1)", list);
  writeSecret(app.config.secretsDir, `opml-imports/${list}/0`, "https://feeds.example/private?token=listed");
  // A news post the member wrote (as an administrator once): it stays for everyone, without its author. Its copy in the member's PURSS goes.
  createNewsPost(app, p, { title: "Welcome", body: "Hello, everyone.", publish: true });
  return [files.secret, files.stage, path.join(app.config.secretsDir, "opml-imports", list)];
}

/** Another account's library next to the deleted one: a public and a private source, items, a kept one. Returns the private link's file. */
function ownerLibrary(app: App, p: Principal & { engineUserId: string }): string {
  makeSource(app, p, "Owner's letters", "feed/1");
  const priv = makeSource(app, p, "Owner's secret", "feed/2", { isPrivate: true });
  writeSecret(app.config.secretsDir, `source-urls/${priv}`, "https://feeds.example/owner?token=OWNER");
  applySyncBatch(app, p.engineUserId, batch([entry("feed/1", { title: "Owner on sediment" }), entry("feed/2", { title: "Owner's private sediment note" })]));
  const item = app.db.get<{ id: string }>("SELECT id FROM items WHERE workspace_id = ? ORDER BY seq LIMIT 1", p.workspaceId)!.id;
  keepItem(app, p, item, createBasket(app, p, { name: "Owner's basket", captureMode: "metadata" }).id);
  return path.join(app.config.secretsDir, "source-urls", priv);
}

/** Every row (as JSON) of every ordinary table that mentions none of the ids. The search index is compared by its results instead. */
function snapshotWithout(app: App, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of app.db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('audit_events', 'schema_migrations')")) {
    if (/VIRTUAL TABLE/i.test(t.sql) || t.name.startsWith("items_fts_") || t.name.startsWith("annotations_fts_")) continue;
    for (const row of app.db.all(`SELECT * FROM "${t.name}"`)) {
      const json = JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v));
      if (!ids.some((id) => json.includes(id))) out.add(`${t.name}:${json}`);
    }
  }
  return out;
}

async function lease(b: DeletionBoot): Promise<{ id: string; leaseId: string; payload: { engineUserId: string; username: string } }> {
  const r = await b.worker("/internal/jobs/lease", { kinds: ["engine.delete_user"], max: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.jobs.length, 1, "the engine.delete_user job is ready");
  return r.json.jobs[0];
}

test("a due deletion is claimed exactly once, even when two ticks race for it", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Ray");
  await requested(b, m, "Ray");
  assert.equal(claimDeletion(b.app, m.accountId), false, "not before it is due");
  makeDue(b.app, m.accountId);
  assert.equal(claimDeletion(b.app, m.accountId), true);
  assert.equal(claimDeletion(b.app, m.accountId), false, "the second tick finds it taken");
  assert.equal(b.app.db.get<{ state: string }>("SELECT state FROM account_deletions WHERE account_id = ?", m.accountId)!.state, "purging");
});

test("with more than two accounts due, a tick starts two, each with its own files", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const ms: { m: Member; files: { secret: string; stage: string } }[] = [];
  for (const name of ["A", "B", "C"]) {
    const m = await member(b.app, name);
    ms.push({ m, files: withFiles(b.app, m) });
    await requested(b, m, name);
  }
  ms.forEach(({ m }, i) => b.app.db.run("UPDATE account_deletions SET due_at = ? WHERE account_id = ?", new Date(Date.now() - (10 - i) * 1000).toISOString(), m.accountId));

  runDeletions(b.app);
  const rows = new Map(b.app.db.all<{ account_id: string; state: string; files: string | null; phase1_done: number }>("SELECT account_id, state, files, phase1_done FROM account_deletions").map((r) => [r.account_id, r]));
  const [a, bb, c] = ms;
  for (const { m, files } of [a!, bb!]) {
    const row = rows.get(m.accountId)!;
    assert.equal(row.state, "purging");
    assert.equal(row.phase1_done, 1);
    assert.deepEqual(JSON.parse(row.files!), [path.relative(b.app.config.dataDir, files.secret), path.relative(b.app.config.dataDir, files.stage)], "the manifest names this account's files only");
    assert.ok(!existsSync(files.secret) && !existsSync(files.stage), "and they are removed");
  }
  assert.equal(rows.get(c!.m.accountId)!.state, "pending", "the third waits for the next tick");
  assert.ok(existsSync(c!.files.secret) && existsSync(c!.files.stage), "with its files untouched");
  runDeletions(b.app);
  assert.equal(b.app.db.get<{ state: string }>("SELECT state FROM account_deletions WHERE account_id = ?", c!.m.accountId)!.state, "purging");
});

test("allocation changes are refused mid-purge, and the CLI counts and protects deleting accounts", async (t) => {
  const b = await bootDeletion({ PURSS_MODE: "hosted" });
  t.after(b.close);
  const admin = await member(b.app, "Admin", { admin: true });
  const m = await member(b.app, "Val");
  await requested(b, m, "Val");
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  await runCommand(b.app, ["status"], io);
  assert.match(lines.join("\n"), /Accounts: 2 \(1 administrators, 0 suspended, 1 being deleted\)/);
  makeDue(b.app, m.accountId);
  claimDeletion(b.app, m.accountId);

  const out = await b.api(signIn(b.app, admin.accountId), "PATCH", `/api/admin/accounts/${m.accountId}`, { allocationBytes: 5_000_000 });
  assert.equal(out.status, 409);
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'admin_account_update' AND target = ? AND outcome = 'failure'", m.accountId));
  await assert.rejects(runCommand(b.app, ["set-allocation", m.accountId, "1000"], io), /being deleted/);
  await assert.rejects(runCommand(b.app, ["password-reset-link", m.accountId], io), /being deleted/);
  runDeletions(b.app);
  assert.equal(b.app.db.get("SELECT 1 FROM storage_accounts WHERE account_id = ?", m.accountId), undefined, "phase 1 still completes cleanly");
});

test("a crash between the phase-1 steps is resumed by the next tick", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Cas");
  const lib = seedLibrary(b.app, principal(m));
  const files = withFiles(b.app, m);
  await requested(b, m, "Cas");
  makeDue(b.app, m.accountId);

  // The files are removed, then the database step fails as if the process died in it.
  b.app.db.exec("CREATE TEMP TRIGGER crash BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  t.mock.method(console, "error", () => {});
  runDeletions(b.app);
  const row = b.app.db.get<{ state: string; phase1_done: number }>("SELECT state, phase1_done FROM account_deletions WHERE account_id = ?", m.accountId)!;
  assert.deepEqual({ ...row }, { state: "purging", phase1_done: 0 });
  assert.ok(!existsSync(files.secret) && !existsSync(files.stage), "step 1 ran");
  assert.ok(b.app.db.get("SELECT 1 FROM items WHERE id = ?", lib.itemIds[0]), "nothing of step 2 committed");
  assert.equal(b.app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.delete_user'"), undefined);

  b.app.db.exec("DROP TRIGGER crash");
  runDeletions(b.app);
  assert.equal(b.app.db.get<{ phase1_done: number }>("SELECT phase1_done FROM account_deletions WHERE account_id = ?", m.accountId)!.phase1_done, 1);
  assert.equal(b.app.db.get("SELECT 1 FROM items WHERE workspace_id = ?", m.workspaceId), undefined);
  assert.ok(b.app.db.get("SELECT 1 FROM jobs WHERE kind = 'engine.delete_user' AND account_id = ?", m.accountId));
  runDeletions(b.app);
  assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'engine.delete_user'")!.n, 1, "a rerun queues nothing twice");
});

test("on a populated database the purge passes every foreign key, and afterwards nothing refers to the account", async (t) => {
  const b = await bootDeletion({ PURSS_ASSISTANT_OAUTH: "on" });
  t.after(b.close);
  const owner = await member(b.app, "Owner", { admin: true });
  const m = await member(b.app, "Mel");
  const files = populate(b.app, m, owner);
  const ownerSecret = ownerLibrary(b.app, principal(owner));

  const memberIds = [m.accountId, m.workspaceId, m.engineUserId,
    ...b.app.db.all<{ id: string }>(`SELECT id FROM items WHERE workspace_id = ? UNION SELECT id FROM sources WHERE workspace_id = ? UNION SELECT id FROM collections WHERE workspace_id = ?
      UNION SELECT id FROM baskets WHERE workspace_id = ? UNION SELECT id FROM shares WHERE workspace_id = ?`, m.workspaceId, m.workspaceId, m.workspaceId, m.workspaceId, m.workspaceId).map((r) => r.id),
    ...b.app.db.all<{ id: string }>("SELECT id FROM oauth_grants WHERE account_id = ?", m.accountId).map((r) => r.id), // its access tokens name only the grant
    ...b.app.db.all<{ id: string }>("SELECT id FROM opml_imports WHERE account_id = ?", m.accountId).map((r) => r.id)]; // its feeds name only the list
  // Every table that holds account data has rows for the member, so the order really is exercised.
  const scoped = b.app.db.all<{ name: string }>(`SELECT DISTINCT m.name FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND c.name IN ('account_id', 'workspace_id', 'engine_user_id') AND m.name NOT IN ('audit_events', 'account_deletions')`).map((r) => r.name);
  const mentioned = new Set(rowsMentioning(b.app, [m.accountId, m.workspaceId, m.engineUserId]).map((s) => s.split(".")[0]));
  for (const table of scoped) assert.ok(mentioned.has(table), `${table} has rows of the member before the purge`);
  for (const table of ["share_notes", "share_reports", "collection_sources", "items_fts_docsize", "annotations_fts_docsize", "oauth_access_tokens"]) {
    assert.ok(b.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n > 0, `${table} is populated`);
  }
  const ownerBefore = snapshotWithout(b.app, memberIds);
  const ownerSearch = () => b.app.db.all<{ rowid: number }>("SELECT rowid FROM items_fts WHERE items_fts MATCH 'sediment' AND rowid IN (SELECT seq FROM items WHERE workspace_id = ?) ORDER BY rowid", owner.workspaceId);
  const searchBefore = ownerSearch();
  assert.ok(searchBefore.length > 0);

  await requested(b, m, "Mel");
  makeDue(b.app, m.accountId);
  runDeletions(b.app);
  assert.equal(b.app.db.get<{ phase1_done: number }>("SELECT phase1_done FROM account_deletions WHERE account_id = ?", m.accountId)!.phase1_done, 1, "phase 1 committed with foreign keys enforced");
  assert.deepEqual(b.app.db.all("PRAGMA foreign_key_check"), []);
  for (const f of files) assert.ok(!existsSync(f), `${path.basename(f)} is removed`);
  assert.ok(existsSync(ownerSecret), "the owner's private feed address stays");
  for (const kept of ["accounts", "workspaces", "engine_users"]) {
    assert.ok(b.app.db.get(`SELECT 1 FROM ${kept} WHERE ${kept === "accounts" ? "id" : "account_id"} = ?`, m.accountId), `${kept} stays until phase 2`);
  }

  // Phase 2 as the worker drives it: the engine user is removed, then the API finalizes.
  const job = await lease(b);
  assert.deepEqual(job.payload, { engineUserId: m.engineUserId, username: b.app.db.get<{ username: string }>("SELECT username FROM engine_users WHERE id = ?", m.engineUserId)!.username });
  const lease_ = { jobId: job.id, leaseId: job.leaseId };
  assert.deepEqual((await b.worker(`/internal/deletions/${m.engineUserId}`, lease_)).json, { engineAttemptedAt: null, engineRemovedAt: null, engineReviewAt: null });
  assert.ok((await b.worker(`/internal/deletions/${m.engineUserId}/attempt`, lease_)).json.engineAttemptedAt);
  assert.equal((await b.worker(`/internal/deletions/${m.engineUserId}/finalize`, lease_)).status, 409, "not before the engine user is confirmed gone");
  assert.equal((await b.worker(`/internal/deletions/${m.engineUserId}/removed`, { jobId: job.id, leaseId: "lse_stale" })).status, 409, "only the current lease may report");
  assert.ok((await b.worker(`/internal/deletions/${m.engineUserId}/removed`, lease_)).json.engineRemovedAt);
  const done = await b.worker(`/internal/deletions/${m.engineUserId}/finalize`, lease_);
  assert.deepEqual(done.json, { finalized: true });
  assert.deepEqual((await b.worker(`/internal/deletions/${m.engineUserId}/finalize`, lease_)).json, { finalized: false }, "a repeat after a lost answer is a no-op success");

  assert.deepEqual(rowsMentioning(b.app, memberIds), [], "no row in any table refers to the account, its workspace or its data");
  assert.deepEqual(b.app.db.all("PRAGMA foreign_key_check"), []);
  const audit = b.app.db.get<{ actor_account_id: string | null; target: string; detail: string | null }>("SELECT actor_account_id, target, detail FROM audit_events WHERE action = 'account_deleted'")!;
  assert.deepEqual({ ...audit }, { actor_account_id: null, target: m.accountId, detail: null }, "the audit log keeps the bare id only");

  const ownerAfter = snapshotWithout(b.app, memberIds);
  for (const row of ownerBefore) assert.ok(ownerAfter.has(row), `the owner's data is untouched: ${row.slice(0, 120)}`);
  assert.deepEqual(ownerSearch(), searchBefore, "the owner's search still finds the same items");
  const invite = b.app.db.get<{ used_at: string | null; used_by: string | null }>("SELECT used_at, used_by FROM invites WHERE note = 'for the member'")!;
  assert.ok(invite.used_at && invite.used_by === null, "the owner's invitation stays used, without the reference");
  assert.equal(b.app.db.get<{ granted_by: string | null }>("SELECT granted_by FROM role_grants WHERE account_id = ?", owner.accountId)!.granted_by, null);
});

test("a user missing after an unconfirmed attempt waits for an administrator, whose confirmation finishes the deletion", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  const admin = await member(b.app, "Admin", { admin: true });
  const m = await member(b.app, "Noor");
  await requested(b, m, "Noor");
  makeDue(b.app, m.accountId);
  runDeletions(b.app);

  // The first run records its attempt and then the worker stops responding.
  const first = await lease(b);
  await b.worker(`/internal/deletions/${m.engineUserId}/attempt`, { jobId: first.id, leaseId: first.leaseId });
  b.app.db.run("UPDATE jobs SET lease_expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), first.id);
  expireLeases(b.app);

  // The rerun finds the user gone after that attempt: it opens a review instead of finishing.
  const second = await lease(b);
  assert.equal(second.id, first.id);
  const state = (await b.worker(`/internal/deletions/${m.engineUserId}`, { jobId: second.id, leaseId: second.leaseId })).json;
  assert.ok(state.engineAttemptedAt && !state.engineRemovedAt);
  assert.equal((await b.worker(`/internal/deletions/${m.engineUserId}/review`, { jobId: second.id, leaseId: second.leaseId })).status, 200);
  const job = b.app.db.get<{ status: string; last_error: string }>("SELECT status, last_error FROM jobs WHERE id = ?", second.id)!;
  assert.equal(job.status, "failed");
  assert.match(job.last_error, /Confirm the engine user's data was removed/);
  assert.ok(b.app.db.get("SELECT 1 FROM accounts WHERE id = ?", m.accountId), "the account isn't finalized");

  const as = signIn(b.app, admin.accountId);
  const listed = (await b.api(as, "GET", "/api/admin/accounts")).json.find((a: { id: string }) => a.id === m.accountId);
  assert.deepEqual(listed.deletion, { dueAt: listed.deletion.dueAt, state: "purging", engineReview: true });
  const stale = signIn(b.app, admin.accountId, { authAgeSeconds: 3600 });
  assert.equal((await b.api(stale, "POST", `/api/admin/accounts/${m.accountId}/deletion/engine-removed`)).json.error.code, "step_up");
  assert.equal((await b.api(as, "POST", `/api/admin/accounts/${admin.accountId}/deletion/engine-removed`)).status, 409, "only an account waiting for it");
  assert.equal((await b.api(as, "POST", `/api/admin/accounts/${m.accountId}/deletion/engine-removed`)).status, 200);
  assert.ok(b.app.db.get("SELECT 1 FROM audit_events WHERE action = 'admin_deletion_engine_confirmed' AND actor_account_id = ? AND target = ?", admin.accountId, m.accountId));

  const third = await lease(b);
  const lease_ = { jobId: third.id, leaseId: third.leaseId };
  assert.ok((await b.worker(`/internal/deletions/${m.engineUserId}`, lease_)).json.engineRemovedAt, "the job resumes with the removal confirmed");
  assert.deepEqual((await b.worker(`/internal/deletions/${m.engineUserId}/finalize`, lease_)).json, { finalized: true });
  assert.equal(b.app.db.get("SELECT 1 FROM accounts WHERE id = ?", m.accountId), undefined);
});

test("an account without an engine user is finalized by phase 1 itself", async (t) => {
  const b = await bootDeletion();
  t.after(b.close);
  await member(b.app, "Owner", { admin: true });
  const m = makeOwner(b.app, { admin: false });
  b.app.db.run("DELETE FROM jobs WHERE account_id = ?", m.accountId);
  b.app.db.run("DELETE FROM engine_users WHERE account_id = ?", m.accountId);
  const r = await b.api(signIn(b.app, m.accountId), "POST", "/api/account/deletion", { confirm: "delete" });
  assert.equal(r.status, 200);
  makeDue(b.app, m.accountId);
  runDeletions(b.app);
  assert.equal(b.app.db.get("SELECT 1 FROM accounts WHERE id = ?", m.accountId), undefined);
  assert.deepEqual(rowsMentioning(b.app, [m.accountId, m.workspaceId]), []);
});
