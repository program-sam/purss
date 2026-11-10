import { createTransport } from "nodemailer";
import { newId } from "@purss/domain";
import type { App } from "../app.ts";
import type { MailConfig } from "../config.ts";
import { addSeconds, nowIso } from "../http.ts";
import { ensureSecret, readSecret, seal, unseal } from "../secrets.ts";

/*
 * Outgoing email (plan/27). Optional: with no PURSS_SMTP_HOST nothing here runs and nothing else
 * depends on it, except hosted open sign-up, which stays closed until a check of the mail
 * server succeeds. Every message is recorded in mail_log by kind and masked recipient, never
 * with its body (links in it are credentials).
 *
 * Messages that don't make a request wait (sendLater) go through mail_queue, sealed with a key from
 * the secrets folder, and are sent right away by this process; one that can't be sent yet (the
 * server is down, the process stopped) is tried again by the maintenance tick, after a restart too,
 * for up to a day. Invitations and the test message are sent while the person waits (sendMail).
 * The key is made at startup (prepareMail), so queueing in a request never writes a file.
 */

export type MailKind = "invitation" | "verify" | "reset" | "password_changed" | "email_changed" | "reminder" | "test";
export type Message = { to: string; subject: string; text: string; html: string };

/** The part that talks to a mail server. Tests swap in their own. */
export type Transport = {
  send(message: Message & { from: string }): Promise<void>;
  verify(): Promise<void>;
};

export type MailStatus = "unchecked" | "ok" | "failing";
type State = { transport: Transport; status: MailStatus; checkedAt: number; lastError: string | null; pending: Set<Promise<unknown>>; draining: boolean; drainAgain: boolean };

const states = new WeakMap<App, State>();
const RECHECK_MS = 10 * 60_000;
/** Codes that mean the server itself is unusable (not one recipient being refused). */
const SERVER_FAULTS = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "EAUTH", "ENOAUTH", "EPROTOCOL", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND"]);

export function smtpTransport(cfg: MailConfig): Transport {
  const t = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === "tls",
    requireTLS: cfg.security === "starttls",
    ignoreTLS: cfg.security === "none",
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(m) { await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html }); },
    async verify() { await t.verify(); },
  };
}

function state(app: App): State | null {
  if (!app.config.mail) return null;
  let s = states.get(app);
  if (!s) {
    s = { transport: smtpTransport(app.config.mail), status: "unchecked", checkedAt: 0, lastError: null, pending: new Set(), draining: false, drainAgain: false };
    states.set(app, s);
  }
  return s;
}

/** TEST ONLY: use this transport instead of SMTP (the app must have a mail configuration). */
export function useTransport(app: App, transport: Transport): void {
  states.set(app, { transport, status: "unchecked", checkedAt: 0, lastError: null, pending: new Set(), draining: false, drainAgain: false });
}

export function mailConfigured(app: App): boolean {
  return app.config.mail !== null;
}

export function mailHealth(app: App): { status: MailStatus; checkedAt: string | null; lastError: string | null; server: string; from: string } | null {
  const s = state(app);
  if (!s || !app.config.mail) return null;
  return { status: s.status, checkedAt: s.checkedAt ? new Date(s.checkedAt).toISOString() : null, lastError: s.lastError, server: `${app.config.mail.host}:${app.config.mail.port} (${app.config.mail.security})`, from: app.config.mail.from };
}

/**
 * Hosted open sign-up needs working email (to confirm addresses and reset passwords): it is
 * open only when configured as open, a mail server is set up and its last check succeeded.
 */
export function signupOpen(app: App): boolean {
  return app.config.mode === "hosted" && app.config.signup === "open" && state(app)?.status === "ok";
}

/** A short, secret-free description of a failure: the error code and the server's reply code. */
export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown; name?: unknown };
  const code = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "Error";
  return typeof e?.responseCode === "number" ? `${code} ${e.responseCode}` : code;
}

function serverFault(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && SERVER_FAULTS.has(code);
}

/** Connect and log in to the mail server; updates the status that open sign-up depends on. */
export async function checkMail(app: App): Promise<boolean> {
  const s = state(app);
  if (!s) return false;
  s.checkedAt = Date.now();
  try {
    await s.transport.verify();
    s.status = "ok";
    s.lastError = null;
  } catch (err) {
    s.status = "failing";
    s.lastError = errorCode(err);
  }
  s.checkedAt = Date.now();
  return s.status === "ok";
}

/** From the maintenance tick: check again while unchecked or failing, at most every ten minutes. */
export function recheckMail(app: App): void {
  const s = state(app);
  if (!s || s.status === "ok" || Date.now() - s.checkedAt < RECHECK_MS) return;
  s.checkedAt = Date.now();
  track(s, checkMail(app));
}

/** a•••@example.com: enough to tell messages apart in the log without keeping the address. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${address[0]}•••@${address.slice(at + 1).toLowerCase()}`;
}

/** Send one message and record the outcome: sent, refused, or failed because of the server itself (worth trying again). */
async function deliver(app: App, s: State, kind: MailKind, accountId: string | null, message: Message): Promise<"sent" | "refused" | "server"> {
  let error: string | null = null;
  let fault = false;
  try {
    await s.transport.send({ ...message, from: app.config.mail!.from });
    s.status = "ok";
    s.lastError = null;
  } catch (err) {
    error = errorCode(err);
    fault = serverFault(err);
    if (fault) { s.status = "failing"; s.lastError = error; s.checkedAt = Date.now(); }
  }
  try {
    app.db.run("INSERT INTO mail_log (id, at, kind, account_id, recipient, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId("mlg"), nowIso(), kind, accountId, maskAddress(message.to), error ? "failed" : "sent", error);
  } catch { /* the database is closing; the message itself went or didn't */ }
  return !error ? "sent" : fault ? "server" : "refused";
}

/** Send one message while the caller waits. Resolves to whether it was accepted by the server. */
export async function sendMail(app: App, kind: MailKind, accountId: string | null, message: Message): Promise<boolean> {
  const s = state(app);
  if (!s || !app.config.mail) return false;
  return (await deliver(app, s, kind, accountId, message)) === "sent";
}

function track(s: State, p: Promise<unknown>): void {
  s.pending.add(p);
  void p.finally(() => s.pending.delete(p));
}

/** A queued message older than this is dropped (its links have expired; a notice that late would mislead). */
const QUEUE_MAX_AGE_MS = 24 * 3600_000;
const QUEUE_KEY = "mail-queue-key";
const keys = new WeakMap<App, string>();
/** The queue's key, made by prepareMail at startup; only read here. */
function queueKey(app: App): string {
  let key = keys.get(app);
  if (!key) {
    key = readSecret(app.config.secretsDir, QUEUE_KEY) ?? ensureSecret(app.config.secretsDir, QUEUE_KEY);
    keys.set(app, key);
  }
  return key;
}

/**
 * At startup. With email set up, make the queue's key now, so that queueing a message in a request
 * (after its change is committed) can't fail on the secrets folder; a folder where it can't be made
 * stops the server with the reason. Without email, messages queued while it was set up can never be
 * sent: they are dropped, logged as failed ("unconfigured") and counted in the server's output.
 */
export function prepareMail(app: App): void {
  if (app.config.mail) {
    try {
      queueKey(app);
    } catch (err) {
      throw new Error(`Outgoing email is set up (PURSS_SMTP_HOST), but the key for its queue (${app.config.secretsDir}/${QUEUE_KEY}) can't be created: ${err instanceof Error ? err.message : err}. Make the secrets folder writable by the server, or remove PURSS_SMTP_HOST.`);
    }
    return;
  }
  const queued = app.db.all<{ id: string; kind: string; account_id: string | null }>("SELECT id, kind, account_id FROM mail_queue");
  if (!queued.length) return;
  app.db.tx(() => {
    for (const row of queued) {
      app.db.run("DELETE FROM mail_queue WHERE id = ?", row.id);
      app.db.run("INSERT INTO mail_log (id, at, kind, account_id, recipient, outcome, error) VALUES (?, ?, ?, ?, '•••', 'failed', 'unconfigured')", newId("mlg"), nowIso(), row.kind, row.account_id);
    }
  });
  console.warn(`[api] outgoing email isn't set up any more: ${queued.length} queued message${queued.length === 1 ? " was" : "s were"} dropped.`);
}

/**
 * Send without making the request wait (and without its timing showing whether an account exists).
 * The message is queued in the database first, so a restart or a mail server that is down doesn't
 * lose it, then sent right away.
 */
export function sendLater(app: App, kind: MailKind, accountId: string | null, message: Message): void {
  if (!state(app)) return;
  app.db.run("INSERT INTO mail_queue (id, kind, account_id, sealed, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
    newId("mlq"), kind, accountId, seal(queueKey(app), JSON.stringify(message)), nowIso(), nowIso());
  drainMail(app);
}

/** Retry after 30 s, doubling to at most 15 minutes. */
const retryDelayMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);

/**
 * Send the queued messages that are due (maintenance tick, startup, after sendLater). One drain runs
 * at a time; asking while one runs runs it again afterwards. `now` is for tests.
 */
export function drainMail(app: App, at?: number): void {
  const s = state(app);
  if (!s) return;
  if (s.draining) { s.drainAgain = true; return; }
  s.draining = true;
  track(s, (async () => {
    try {
      do {
        s.drainAgain = false;
        const now = at ?? Date.now();
        const due = app.db.all<{ id: string; kind: MailKind; account_id: string | null; sealed: string; created_at: string; attempts: number }>(
          "SELECT id, kind, account_id, sealed, created_at, attempts FROM mail_queue WHERE next_attempt_at <= ? ORDER BY created_at, id LIMIT 50", new Date(now).toISOString());
        for (const row of due) {
          const opened = unseal(queueKey(app), row.sealed);
          if (opened === null || now - Date.parse(row.created_at) > QUEUE_MAX_AGE_MS) {
            // Sealed with a key this installation no longer has (a restore without secrets), or too old.
            app.db.run("DELETE FROM mail_queue WHERE id = ?", row.id);
            app.db.run("INSERT INTO mail_log (id, at, kind, account_id, recipient, outcome, error) VALUES (?, ?, ?, ?, '•••', 'failed', ?)",
              newId("mlg"), nowIso(), row.kind, row.account_id, opened === null ? "unreadable" : "expired");
            continue;
          }
          const outcome = await deliver(app, s, row.kind, row.account_id, JSON.parse(opened) as Message);
          if (outcome === "server") {
            app.db.run("UPDATE mail_queue SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?", new Date(now + retryDelayMs(row.attempts + 1)).toISOString(), row.id);
            break; // the server is down: the rest waits for the next try too
          }
          app.db.run("DELETE FROM mail_queue WHERE id = ?", row.id);
        }
      } while (s.drainAgain);
    } catch (err) {
      console.error("[api] sending queued mail failed:", err instanceof Error ? err.message : err);
    } finally {
      s.draining = false;
    }
  })());
}

/** Wait for messages still being sent (shutdown, tests). With `timeoutMs`, at most that long: what isn't sent stays queued. */
export async function settleMail(app: App, timeoutMs?: number): Promise<void> {
  const s = states.get(app);
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  while (s && s.pending.size && Date.now() < deadline) {
    const all = Promise.allSettled([...s.pending]);
    if (deadline === Infinity) await all;
    else await Promise.race([all, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
  }
}

/** Old log entries and spent links go after 90 days and a day respectively. */
export function purgeMail(app: App): void {
  app.db.run("DELETE FROM mail_log WHERE at < ?", addSeconds(-90 * 86400));
  app.db.run("DELETE FROM email_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)", addSeconds(-86400), addSeconds(-86400));
}
