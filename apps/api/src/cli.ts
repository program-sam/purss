import { existsSync, statSync } from "node:fs";
import { EventEmitter } from "node:events";
import { loadConfig } from "./config.ts";
import type { App } from "./app.ts";
import { audit } from "./app.ts";
import { openDatabase } from "./db/database.ts";
import { createInvite, issueRecoveryCodes } from "./auth/accounts.ts";
import { StorageFull, allocation, checkGrowth, databaseBytes, markPaused, recountCurrentFlags, refreshPause, reconcile, usedBytes } from "./services/storage.ts";
import { signOutEverywhere } from "./auth/sign-out.ts";
import { checkMail, mailHealth, sendMail } from "./mail/mailer.ts";
import { testMail } from "./mail/templates.ts";
import { emailSchema } from "./services/account-email.ts";
import { usableAccountSql } from "./services/deletion.ts";
import { PLAN_NAMES } from "@purss/domain";
import { capacity, storedPlan } from "./services/plans.ts";

/*
 * Host-level operator tool: runs against the database file directly, for recovery when the
 * web app cannot be used. It needs the data directory (PURSS_DATA_DIR) and nothing else, and
 * every change it makes is recorded in the audit log with no actor (a host-level action).
 *
 *   node apps/api/src/cli.ts status
 *   node apps/api/src/cli.ts create-invite [--note "text"] [--allocation <bytes>] [--days <n>]
 *   node apps/api/src/cli.ts set-allocation <account> <bytes|none>
 *   node apps/api/src/cli.ts set-plan <account> <free|plus|unlimited>
 *   node apps/api/src/cli.ts reissue-recovery-codes <account> --yes
 *   node apps/api/src/cli.ts reconcile-usage
 *   node apps/api/src/cli.ts test-email <address>
 *
 * <account> is an account id (acc_...) or a unique display name.
 */

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

type Io = { out: (line: string) => void; err: (line: string) => void };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function resolveAccount(app: App, ref: string | undefined): { id: string; displayName: string | null } {
  if (!ref) throw new CliError("Name the account: its id (acc_…) or its display name.", 2);
  const byId = app.db.get<{ id: string; display_name: string | null }>("SELECT id, display_name FROM accounts WHERE id = ?", ref);
  if (byId) return { id: byId.id, displayName: byId.display_name };
  const named = app.db.all<{ id: string; display_name: string | null }>("SELECT id, display_name FROM accounts WHERE lower(display_name) = lower(?)", ref);
  if (named.length === 1) return { id: named[0]!.id, displayName: named[0]!.display_name };
  throw new CliError(named.length ? `More than one account is called “${ref}”. Use its id.` : `No account matches “${ref}”.`);
}

const deletionState = (app: App, accountId: string) =>
  app.db.get<{ state: "pending" | "purging" }>("SELECT state FROM account_deletions WHERE account_id = ?", accountId)?.state ?? null;

const fmt = (n: number | null) => (n === null ? "unknown" : `${n} bytes`);

export async function runCommand(app: App, args: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "status": {
      const n = (sql: string) => app.db.get<{ n: number }>(sql)!.n;
      const jobs = app.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status ORDER BY status");
      const migrations = app.db.all<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name").map((m) => m.name);
      const db = databaseBytes(app);
      io.out(`Data directory: ${app.config.dataDir}`);
      io.out(`Mode: ${app.config.mode}`);
      io.out(`Database: ${fmt(db.bytes)}, write-ahead log ${fmt(db.walBytes)}; migrations applied: ${migrations.length} (${migrations.at(-1) ?? "none"})`);
      io.out(`Accounts: ${n("SELECT COUNT(*) AS n FROM accounts")} (${n("SELECT COUNT(*) AS n FROM role_grants WHERE role = 'admin'")} administrators, ${n("SELECT COUNT(*) AS n FROM accounts WHERE status = 'suspended'")} suspended, ${n("SELECT COUNT(*) AS n FROM account_deletions")} being deleted)`);
      io.out(`Sources: ${n("SELECT COUNT(*) AS n FROM sources WHERE followed = 1 AND kind <> 'manual'")} followed; items: ${n("SELECT COUNT(*) AS n FROM items")}; kept pins: ${n("SELECT COUNT(*) AS n FROM basket_items")}`);
      io.out(`Jobs: ${jobs.length ? jobs.map((j) => `${j.n} ${j.status}`).join(", ") : "none"}`);
      io.out(`Open reconciliation entries: ${n("SELECT COUNT(*) AS n FROM reconciliation_queue WHERE status = 'open'")}`);
      const mail = mailHealth(app);
      io.out(mail ? `Outgoing email: ${mail.server}, from ${mail.from} (run test-email to check it)` : "Outgoing email: not set up");
      return 0;
    }
    case "create-invite": {
      const admin = app.db.get<{ account_id: string }>(`SELECT r.account_id FROM role_grants r WHERE r.role = 'admin' AND ${usableAccountSql("r.account_id")} ORDER BY r.granted_at LIMIT 1`);
      if (!admin) throw new CliError("There is no active administrator account to attribute the invitation to. Claim the installation first.");
      const allocationArg = flag(rest, "--allocation");
      const bytes = allocationArg === undefined ? null : Number(allocationArg);
      if (bytes !== null && (!Number.isInteger(bytes) || bytes < 0)) throw new CliError("--allocation must be a whole number of bytes.", 2);
      const days = flag(rest, "--days") === undefined ? 14 : Number(flag(rest, "--days"));
      if (!Number.isInteger(days) || days < 1 || days > 60) throw new CliError("--days must be between 1 and 60.", 2);
      const code = app.db.tx(() => {
        const c = createInvite(app, admin.account_id, flag(rest, "--note") ?? null, bytes, days);
        audit(app, null, "cli_create_invite", null, "success", "host-level");
        return c;
      });
      io.out(`Invitation code (shown once, valid ${days} days): ${code}`);
      if (bytes !== null && app.config.mode !== "hosted") io.err("Note: storage allowances only apply on hosted installations; this account will have no limit.");
      return 0;
    }
    case "set-allocation": {
      const acct = resolveAccount(app, rest[0]);
      if (deletionState(app, acct.id)) throw new CliError(`${acct.displayName ?? acct.id} is being deleted, so its allocation can't be changed.`);
      const value = rest[1];
      if (value === undefined) throw new CliError("Give a number of bytes, or “none” for no limit.", 2);
      const bytes = value === "none" ? null : Number(value);
      if (bytes !== null && (!Number.isInteger(bytes) || bytes < 0)) throw new CliError("The allocation must be a whole number of bytes, or “none”.", 2);
      const before = allocation(app, acct.id);
      app.db.tx(() => {
        app.db.run("INSERT INTO storage_accounts (account_id, allocation_bytes) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET allocation_bytes = excluded.allocation_bytes", acct.id, bytes);
        audit(app, null, "cli_set_allocation", acct.id, "success", `${before ?? "none"} -> ${bytes ?? "none"}`);
      });
      try {
        checkGrowth(app, acct.id, 1);
        refreshPause(app, acct.id);
      } catch (err) {
        if (!(err instanceof StorageFull)) throw err;
        markPaused(app, err); // over the new limit: growth is paused, data is kept
      }
      io.out(`Allocation for ${acct.displayName ?? acct.id}: ${before ?? "none"} -> ${bytes ?? "none"} (currently using ${usedBytes(app, acct.id)} bytes).`);
      return 0;
    }
    case "set-plan": {
      const acct = resolveAccount(app, rest[0]);
      if (app.config.mode !== "hosted") throw new CliError("Plans only apply on hosted installations.", 2);
      if (deletionState(app, acct.id)) throw new CliError(`${acct.displayName ?? acct.id} is being deleted, so its plan can't be changed.`);
      const value = rest[1];
      if (!value || !(PLAN_NAMES as readonly string[]).includes(value)) throw new CliError(`Give a plan: ${PLAN_NAMES.join(", ")}.`, 2);
      const before = storedPlan(app, acct.id);
      app.db.tx(() => {
        app.db.run("UPDATE accounts SET plan = ? WHERE id = ?", value, acct.id);
        audit(app, null, "cli_set_plan", acct.id, "success", `${before} -> ${value}`);
      });
      const c = capacity(app, acct.id);
      io.out(`Plan for ${acct.displayName ?? acct.id}: ${before} -> ${value} (${c.sources.used} sources, ${c.collections.used} collections).`);
      return 0;
    }
    case "reissue-recovery-codes": {
      const acct = resolveAccount(app, rest[0]);
      // During the grace period new codes let the owner sign in and keep the account; once removal started they can't.
      if (deletionState(app, acct.id) === "purging") throw new CliError(`${acct.displayName ?? acct.id} is being deleted and can't be signed in to any more.`);
      if (!rest.includes("--yes")) {
        io.err(`This replaces every unused recovery code for ${acct.displayName ?? acct.id}, signs the account out everywhere (connected apps too) and is recorded in the audit log.`);
        io.err("Run it again with --yes to continue.");
        return 2;
      }
      const codes = app.db.tx(() => {
        const issued = issueRecoveryCodes(app, acct.id);
        signOutEverywhere(app, acct.id, "everything");
        audit(app, null, "cli_reissue_recovery_codes", acct.id, "success", "host-level");
        return issued;
      });
      io.out(`New recovery codes for ${acct.displayName ?? acct.id}. They are shown once; store them somewhere safe. All sessions were signed out, assistant tokens revoked and connected apps disconnected.`);
      for (const c of codes) io.out(`  ${c}`);
      return 0;
    }
    case "reconcile-usage": {
      let differ = 0;
      for (const a of app.db.all<{ id: string; display_name: string | null }>("SELECT id, display_name FROM accounts ORDER BY created_at, id")) {
        const r = app.db.tx(() => reconcile(app, a.id, { repair: true }));
        if (r.difference !== 0) differ++;
        io.out(`${a.display_name ?? a.id}: ledger ${r.ledger} bytes, owned objects ${r.objects} bytes, difference ${r.difference}`);
        // Derived numbers the product reads instead of adding things up each time: put right wherever they have drifted.
        if (r.trackedDifference !== 0) io.out(`  used-bytes total was ${r.tracked}, recounted ${r.objects}: corrected (${r.objects > r.tracked ? "+" : ""}${r.objects - r.tracked} bytes)`);
        const flags = recountCurrentFlags(app, a.id);
        if (flags) io.out(`  corrected ${flags} stored version(s) wrongly marked current or superseded`);
      }
      audit(app, null, "cli_reconcile_usage", null, differ ? "failure" : "success", `${differ} differ`);
      io.out(differ ? `${differ} account(s) differ from the usage ledger. The ledger was not changed.` : "All accounts agree.");
      return differ ? 1 : 0;
    }
    case "test-email": {
      const parsed = emailSchema.safeParse(rest[0] ?? "");
      if (!parsed.success) throw new CliError("Give the address to send a test message to.", 2);
      if (!app.config.mail) throw new CliError("Outgoing email isn't set up: PURSS_SMTP_HOST and PURSS_MAIL_FROM are empty in this environment.");
      const h = mailHealth(app)!;
      io.out(`Mail server ${h.server}, sending as ${h.from}.`);
      if (!(await checkMail(app))) throw new CliError(`The mail server check failed: ${mailHealth(app)!.lastError}. Check the host, port, security setting and login.`);
      if (!(await sendMail(app, "test", null, testMail(parsed.data, { origin: app.config.publicOrigin })))) {
        const last = app.db.get<{ error: string | null }>("SELECT error FROM mail_log WHERE kind = 'test' ORDER BY at DESC LIMIT 1");
        throw new CliError(`The mail server refused the message: ${last?.error ?? "unknown error"}.`);
      }
      audit(app, null, "cli_test_email", null, "success", "host-level");
      io.out("Sent. Check that it arrived (and isn't in spam).");
      return 0;
    }
    default:
      io.err("Usage: node apps/api/src/cli.ts <status | create-invite | set-allocation <account> <bytes|none> | set-plan <account> <free|plus|unlimited> | reissue-recovery-codes <account> --yes | reconcile-usage | test-email <address>>");
      return 2;
  }
}

/** Open the database named by the environment and run one command. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
  const config = loadConfig(env);
  if (!existsSync(config.dbFile) || !statSync(config.dbFile).isFile()) {
    io.err(`No database at ${config.dbFile}. Set PURSS_DATA_DIR to the installation's data directory.`);
    return 1;
  }
  const db = openDatabase(config.dbFile);
  const app: App = { db, config, events: new EventEmitter(), serviceToken: "" };
  try {
    return await runCommand(app, argv, io);
  } catch (err) {
    if (err instanceof CliError) { io.err(err.message); return err.exitCode; }
    throw err;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
