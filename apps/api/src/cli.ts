import { existsSync, statSync } from "node:fs";
import { EventEmitter } from "node:events";
import { loadConfig } from "./config.ts";
import type { App } from "./app.ts";
import { audit } from "./app.ts";
import { openDatabase } from "./db/database.ts";
import { StorageFull, allocation, checkGrowth, databaseBytes, markPaused, recountCurrentFlags, refreshPause, reconcile, usedBytes } from "./services/storage.ts";
import { checkMail, mailHealth, sendMail } from "./mail/mailer.ts";
import { testMail } from "./mail/templates.ts";
import { emailSchema, hostResetLink, resendVerification, setAccountEmail } from "./services/account-email.ts";
import { issueInvite } from "./services/admin.ts";
import { usableAccountSql } from "./services/deletion.ts";
import { PLAN_NAMES } from "@purss/domain";
import { HttpError } from "./http.ts";
import { capacity, storedPlan } from "./services/plans.ts";

/*
 * Host-level operator tool: runs against the database file directly, for recovery when the
 * web app cannot be used. It needs the data directory (PURSS_DATA_DIR) and nothing else, and
 * every change it makes is recorded in the audit log with no actor (a host-level action).
 *
 *   node apps/api/src/cli.ts status
 *   node apps/api/src/cli.ts create-invite <address> [--note "text"] [--allocation <bytes>] [--days <n>]
 *   node apps/api/src/cli.ts set-email <account> <address>
 *   node apps/api/src/cli.ts set-allocation <account> <bytes|none>
 *   node apps/api/src/cli.ts set-plan <account> <free|plus|unlimited>
 *   node apps/api/src/cli.ts password-reset-link <account>
 *   node apps/api/src/cli.ts reconcile-usage
 *   node apps/api/src/cli.ts test-email <address>
 *
 * <account> is an account id (acc_...), its email address, or a unique display name.
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
  if (!ref) throw new CliError("Name the account: its id (acc_…), its email address or its display name.", 2);
  const byId = app.db.get<{ id: string; display_name: string | null }>("SELECT id, display_name FROM accounts WHERE id = ? OR lower(email) = lower(?)", ref, ref.trim());
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
      const parsed = emailSchema.safeParse(rest[0] ?? "");
      if (!parsed.success) throw new CliError("Give the email address the invitation is for.", 2);
      const admin = app.db.get<{ account_id: string }>(`SELECT r.account_id FROM role_grants r WHERE r.role = 'admin' AND ${usableAccountSql("r.account_id")} ORDER BY r.granted_at LIMIT 1`);
      if (!admin) throw new CliError("There is no active administrator account to attribute the invitation to. Claim the installation first.");
      const allocationArg = flag(rest, "--allocation");
      const bytes = allocationArg === undefined ? null : Number(allocationArg);
      if (bytes !== null && (!Number.isInteger(bytes) || bytes < 0)) throw new CliError("--allocation must be a whole number of bytes.", 2);
      const days = flag(rest, "--days") === undefined ? 14 : Number(flag(rest, "--days"));
      if (!Number.isInteger(days) || days < 1 || days > 60) throw new CliError("--days must be between 1 and 60.", 2);
      let code;
      try { ({ code } = await issueInvite(app, admin.account_id, parsed.data, flag(rest, "--note") ?? null, bytes, days)); } catch (err) {
        if (err instanceof HttpError) throw new CliError(err.message);
        throw err;
      }
      audit(app, null, "cli_create_invite", null, "success", "host-level");
      // Where email is set up the code went only to the address, so using it proves the address.
      io.out(code === null ? `The invitation was emailed to ${parsed.data} (valid ${days} days).` : `Invitation code for ${parsed.data} (shown once, valid ${days} days): ${code}`);
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
    case "set-email": {
      const acct = resolveAccount(app, rest[0]);
      const parsed = emailSchema.safeParse(rest[1] ?? "");
      if (!parsed.success) throw new CliError("Give the email address the account signs in with.", 2);
      if (deletionState(app, acct.id) === "purging") throw new CliError(`${acct.displayName ?? acct.id} is being deleted.`);
      const current = app.db.get<{ email: string | null }>("SELECT email FROM accounts WHERE id = ?", acct.id)!.email;
      if (app.config.mail && current) {
        // Where email is set up an address the account signs in with is replaced only once the new one is confirmed, as in Settings.
        if (app.db.get("SELECT 1 FROM accounts WHERE lower(email) = lower(?) AND id <> ?", parsed.data, acct.id)) throw new CliError("Another account already uses that email address.");
        setAccountEmail(app, acct.id, parsed.data);
        audit(app, null, "cli_set_email", acct.id, "success", "host-level, pending confirmation");
        io.out(`A confirmation link was sent to ${parsed.data}. ${acct.displayName ?? acct.id} keeps signing in with ${current} until it is used.`);
        return 0;
      }
      app.db.tx(() => {
        if (app.db.get("SELECT 1 FROM accounts WHERE lower(email) = lower(?) AND id <> ?", parsed.data, acct.id)) throw new CliError("Another account already uses that email address.");
        app.db.run("UPDATE accounts SET email = ?, email_verified_at = NULL WHERE id = ?", parsed.data, acct.id);
        app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND used_at IS NULL", acct.id);
        audit(app, null, "cli_set_email", acct.id, "success", "host-level");
      });
      // An account without an address gets one at once; where email is set up it is sent a link to confirm it.
      if (app.config.mail) resendVerification(app, acct.id);
      io.out(`${acct.displayName ?? acct.id} now signs in with ${parsed.data}${app.config.mail ? "; a confirmation link was sent there" : ""}.`);
      return 0;
    }
    case "password-reset-link": {
      const acct = resolveAccount(app, rest[0]);
      // During the grace period a new password lets the owner sign in and keep the account; once removal started it can't.
      if (deletionState(app, acct.id) === "purging") throw new CliError(`${acct.displayName ?? acct.id} is being deleted and can't be signed in to any more.`);
      const made = app.db.tx(() => {
        let out;
        try { out = hostResetLink(app, acct.id); } catch (err) {
          if (err instanceof HttpError) throw new CliError(`${acct.displayName ?? acct.id} has no password to reset or can't be reset now.`);
          throw err;
        }
        audit(app, null, "cli_password_reset_link", acct.id, "success", "host-level");
        return out;
      });
      io.out(`Password reset link for ${acct.displayName ?? acct.id}. It is shown once, works once and expires in ${made.minutes} minutes. Give it only to the person it is for; opening it lets them choose a new password, and signs the account out everywhere, assistant tokens and connected apps included.`);
      io.out(`  ${made.link}`);
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
      io.err("Usage: node apps/api/src/cli.ts <status | create-invite <address> | set-email <account> <address> | set-allocation <account> <bytes|none> | set-plan <account> <free|plus|unlimited> | password-reset-link <account> | reconcile-usage | test-email <address>>");
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
