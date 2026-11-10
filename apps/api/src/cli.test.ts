import { readdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeOwner, makeTestApp } from "./testing.ts";
import type { App } from "./app.ts";
import { seedLibrary, signIn } from "./features-testing.ts";
import { main } from "./cli.ts";
import { acceptInvite, issueRecoveryCodes, recoveryCodesLeft, useRecoveryCode } from "./auth/accounts.ts";
import { createDeviceToken, resolveDeviceToken } from "./connect/devices.ts";
import { usedBytes } from "./services/storage.ts";

async function run(app: App, args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { PURSS_DATA_DIR: app.config.dataDir, ...env }, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("status summarises the installation without showing any content", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  seedLibrary(app, p);
  const r = (await run(app, ["status"]));
  assert.equal(r.code, 0);
  assert.match(r.out, /Accounts: 1 \(1 administrators, 0 suspended, 0 being deleted\)/);
  assert.match(r.out, /Sources: 2 followed; items: 4; kept pins: 3/);
  const migrations = readdirSync(new URL("./db/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
  assert.match(r.out, new RegExp(`migrations applied: ${migrations.length} \\(${migrations.at(-1)!.replace(".", "\\.")}\\)`));
  for (const content of ["Tidal", "Private note", "Sediment", "feeds.example"]) assert.ok(!r.out.includes(content), `status must not show ${content}`);
});

test("without a database the CLI says where it looked and does nothing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "purss-cli-empty-"));
  try {
    const err: string[] = [];
    const code = await main(["status"], { PURSS_DATA_DIR: dir }, { out: () => {}, err: (l) => err.push(l) });
    assert.equal(code, 1);
    assert.match(err[0]!, /No database at .*product\.db/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set-allocation changes the limit by id or unique name, validates, and is audited as a host-level action", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  app.db.run("UPDATE accounts SET display_name = 'Pat' WHERE id = ?", p.accountId);
  seedLibrary(app, p);
  assert.equal((await run(app, ["set-allocation", "Pat", "5000000"])).code, 0);
  assert.equal(app.db.get("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", p.accountId)!.allocation_bytes, 5_000_000);
  assert.equal((await run(app, ["set-allocation", p.accountId, "none"])).code, 0);
  assert.equal(app.db.get("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", p.accountId)!.allocation_bytes, null);
  // Below current usage: data stays, new growth is paused.
  const low = (await run(app, ["set-allocation", p.accountId, "100"]));
  assert.equal(low.code, 0);
  assert.match(low.out, /currently using \d+ bytes/);
  assert.equal(app.db.get("SELECT paused_reason FROM storage_accounts WHERE account_id = ?", p.accountId)!.paused_reason, "quota");
  assert.ok(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items")!.n > 0);
  assert.equal((await run(app, ["set-allocation", p.accountId, "1e9x"])).code, 2);
  assert.equal((await run(app, ["set-allocation", p.accountId])).code, 2);
  assert.equal((await run(app, ["set-allocation", "nobody", "10"])).code, 1);
  makeOwner(app, { admin: false });
  app.db.run("UPDATE accounts SET display_name = 'Pat'");
  const ambiguous = (await run(app, ["set-allocation", "pat", "10"]));
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /More than one account/);
  const audit = app.db.all<{ actor_account_id: string | null; action: string }>("SELECT actor_account_id, action FROM audit_events WHERE action = 'cli_set_allocation'");
  assert.equal(audit.length, 3);
  assert.ok(audit.every((a) => a.actor_account_id === null));
});

test("reissue-recovery-codes needs --yes, prints new codes once, signs the account out, disconnects its apps and retires the old codes", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  signIn(app, p.accountId);
  const oldCodes = issueRecoveryCodes(app, p.accountId);
  const phone = createDeviceToken(app, p.accountId, "mobile", "Phone").secret;
  app.db.run("INSERT INTO connect_codes (code_hash, account_id, kind, redirect_uri, code_challenge, label, created_at, expires_at) VALUES ('h', ?, 'mobile', 'purss://connect', 'c', 'Phone', ?, ?)", p.accountId, new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());
  const dry = (await run(app, ["reissue-recovery-codes", p.accountId]));
  assert.equal(dry.code, 2);
  assert.match(dry.err, /--yes/);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")!.n, 1, "nothing happened without --yes");
  assert.equal(recoveryCodesLeft(app, p.accountId), 10);

  const r = (await run(app, ["reissue-recovery-codes", p.accountId, "--yes"]));
  assert.equal(r.code, 0);
  const printed = r.out.split("\n").map((l) => l.trim()).filter((l) => /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(l));
  assert.equal(printed.length, 10);
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?", p.accountId)!.n, 0, "all sessions revoked");
  assert.equal(resolveDeviceToken(app, phone), null, "connected apps disconnected");
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connect_codes")!.n, 0, "a connection waiting for its code exchange ends too");
  assert.equal(useRecoveryCode(app, oldCodes[0]!), null, "the old codes are gone");
  assert.equal(useRecoveryCode(app, printed[0]!), p.accountId, "a new code works, once");
  assert.equal(useRecoveryCode(app, printed[0]!), null);
  const event = app.db.get<{ actor_account_id: string | null; target: string; detail: string }>("SELECT actor_account_id, target, detail FROM audit_events WHERE action = 'cli_reissue_recovery_codes'")!;
  assert.deepEqual([event.actor_account_id, event.target, event.detail], [null, p.accountId, "host-level"]);
  assert.ok(!JSON.stringify(app.db.all("SELECT * FROM audit_events")).includes(printed[1]!), "codes are never logged");
});

test("create-invite prints a one-time code that a hosted installation accepts", async (t) => {
  const { app, cleanup } = makeTestApp({ PURSS_MODE: "hosted" });
  t.after(cleanup);
  assert.equal((await run(app, ["create-invite"], { PURSS_MODE: "hosted" })).code, 1, "no administrator to attribute it to yet");
  const p = makeOwner(app);
  const bad = (await run(app, ["create-invite", "--days", "99"], { PURSS_MODE: "hosted" }));
  assert.equal(bad.code, 2);
  const r = (await run(app, ["create-invite", "--note", "for Alex", "--allocation", "777", "--days", "3"], { PURSS_MODE: "hosted" }));
  assert.equal(r.code, 0);
  const code = /: ([a-z0-9-]{24})$/.exec(r.out)![1]!;
  const joined = acceptInvite(app, code, "Alex");
  assert.equal(app.db.get("SELECT allocation_bytes FROM storage_accounts WHERE account_id = ?", joined.accountId)!.allocation_bytes, 777);
  assert.equal(app.db.get("SELECT created_by FROM invites")!.created_by, p.accountId);
  assert.equal(app.db.get("SELECT actor_account_id FROM audit_events WHERE action = 'cli_create_invite'")!.actor_account_id, null);
  assert.ok(!JSON.stringify(app.db.all("SELECT * FROM audit_events")).includes(code));
  // Self-hosted installations accept invitations too; only a storage allowance is a hosted feature.
  const self = (await run(app, ["create-invite"], { PURSS_MODE: "self" }));
  assert.equal(self.code, 0);
  assert.equal(self.err, "");
  assert.match((await run(app, ["create-invite", "--allocation", "1000"], { PURSS_MODE: "self" })).err, /only apply on hosted installations/);
});

test("reconcile-usage reports ledger differences and exits non-zero, changing no object, and corrects a drifted used-bytes total", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const p = makeOwner(app);
  seedLibrary(app, p);
  const ok = (await run(app, ["reconcile-usage"]));
  assert.equal(ok.code, 0);
  assert.match(ok.out, /All accounts agree/);
  assert.doesNotMatch(ok.out, /corrected/);
  // An object written around the product: the ledger differs, and so does the total kept for the quota check.
  app.db.run("INSERT INTO stored_objects (id, account_id, workspace_id, kind, ref_id, bytes, created_at) VALUES ('obj_orphan', ?, ?, 'record', 'orphan', 500, 'x')", p.accountId, p.workspaceId);
  const before = usedBytes(app, p.accountId);
  const bad = (await run(app, ["reconcile-usage"]));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /difference -500/);
  assert.match(bad.out, new RegExp(`used-bytes total was ${before}, recounted ${before + 500}: corrected \\(\\+500 bytes\\)`));
  assert.equal(app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stored_objects WHERE id = 'obj_orphan'")!.n, 1, "the object is reported, not removed");
  assert.equal(usedBytes(app, p.accountId), before + 500, "the total now agrees with the objects");
  assert.doesNotMatch((await run(app, ["reconcile-usage"])).out, /corrected/, "and stays right");
});

test("an unknown command prints usage", async (t) => {
  const { app, cleanup } = makeTestApp();
  t.after(cleanup);
  const r = (await run(app, ["drop-everything"]));
  assert.equal(r.code, 2);
  assert.match(r.err, /Usage:/);
});
