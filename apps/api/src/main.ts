import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventMessage } from "@purss/domain";
import { appUrl } from "@purss/domain";
import type { App, Ctx, Principal } from "./app.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { ensureDir, ensureSecret } from "./secrets.ts";
import { ensureClaimCode } from "./auth/accounts.ts";
import { publicRouter } from "./routes/public.ts";
import { internalRouter } from "./routes/internal.ts";
import { extraRouters } from "./routes/index.ts";
import { internalServer, publicServer } from "./server.ts";
import { enqueue, expireLeases } from "./services/jobs.ts";
import { settleFailedJob, syncDelaySeconds } from "./services/failures.ts";
import { expireReservations, refreshPause } from "./services/storage.ts";
import { addSeconds, nowIso, watchTrustedProxies } from "./http.ts";
import { runReminderPass } from "./services/reminders.ts";
import { runReturningPass } from "./services/returning.ts";
import { runOpmlImports } from "./services/opml-import.ts";
import { backfillFeedKeys, checkEmptyFeeds } from "./services/sources.ts";
import { purgeStages, purgeUploads } from "./services/portability.ts";
import { startCaptureCheck } from "./services/captures.ts";
import { scheduleIconChecks } from "./services/icons.ts";
import { purgeCodes } from "./connect/codes.ts";
import { IDLE_DAYS, deviceIdOf, purgeIdleDevices, revokedEvent } from "./connect/devices.ts";
import { purgeOAuth } from "./oauth/grants.ts";
import { removeMediaFolder } from "./services/media-folder.ts";
import { checkMail, drainMail, mailHealth, prepareMail, purgeMail, recheckMail, settleMail } from "./mail/mailer.ts";
import { startSearchIndexRebuild } from "./services/search-index.ts";
import { assignMissingPlans } from "./services/plans.ts";
import { runDiscoveryPass } from "./services/discover.ts";
import { isAccountUsable, runDeletions, usableAccountSql } from "./services/deletion.ts";
import { startPush, wakeHeld } from "./services/push.ts";
import { deliverNews } from "./services/news.ts";

export function createApp(config: Config): App {
  ensureDir(config.dataDir);
  ensureDir(config.secretsDir);
  const db = openDatabase(config.dbFile);
  const serviceToken = ensureSecret(config.secretsDir, "service-token");
  const events = new EventEmitter();
  events.setMaxListeners(1000);
  const app = { db, config, events, serviceToken };
  removeMediaFolder(config.dataDir);
  assignMissingPlans(app);
  prepareMail(app);
  return app;
}

/** When the session or connected app behind a principal stops working, in ms; 0 when it already has. */
function credentialEnd(app: App, p: Principal, deviceId: string | null): number {
  if (deviceId) {
    const d = app.db.get<{ last_used_at: string }>("SELECT last_used_at FROM device_tokens WHERE id = ? AND account_id = ?", deviceId, p.accountId);
    return d && isAccountUsable(app, p.accountId) ? Date.parse(d.last_used_at) + IDLE_DAYS * 86_400_000 : 0;
  }
  const row = app.db.get<{ expires_at: string; status: string }>(
    "SELECT s.expires_at, a.status FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND s.account_id = ?", p.sessionId, p.accountId);
  return row && row.status === "active" ? Date.parse(row.expires_at) : 0;
}

export function eventStream(_req: IncomingMessage, res: ServerResponse, ctx: Ctx): void {
  const p = ctx.principal!;
  const closed = { value: false };
  const key = `account:${p.accountId}`;
  const sessionKey = `session:${p.sessionId}`;
  // A stream opened with a device token ends when that app is disconnected or goes unused too long.
  const deviceId = deviceIdOf(p);
  const deviceKey = deviceId ? revokedEvent(deviceId) : null;
  let expiry: NodeJS.Timeout | null = null;
  let ping: NodeJS.Timeout | null = null;
  const send = (m: EventMessage) => { if (!closed.value) res.write(`data: ${JSON.stringify(m)}\n\n`); };
  const cleanup = () => {
    if (expiry) clearTimeout(expiry);
    if (ping) clearInterval(ping);
    ctx.app.events.off(key, send);
    ctx.app.events.off(sessionKey, revoke);
    if (deviceKey) ctx.app.events.off(deviceKey, revoke);
  };
  const close = () => {
    if (closed.value) return;
    closed.value = true;
    cleanup();
    res.end();
  };
  const revoke = () => close();
  const checkSession = () => {
    if (closed.value) return;
    const expiresAt = credentialEnd(ctx.app, p, deviceId);
    if (expiresAt <= Date.now()) { close(); return; }
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(checkSession, Math.max(1, Math.min(expiresAt - Date.now(), 2_147_000_000)));
    expiry.unref();
  };
  if (credentialEnd(ctx.app, p, deviceId) <= Date.now()) { res.writeHead(401).end(); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": connected\n\n");
  ctx.app.events.on(key, send);
  ctx.app.events.on(sessionKey, revoke);
  if (deviceKey) ctx.app.events.on(deviceKey, revoke);
  checkSession();
  ping = setInterval(() => {
    checkSession();
    if (!closed.value) res.write(": ping\n\n");
  }, 25_000);
  res.on("close", cleanup);
}

/** Periodic maintenance: media files an earlier version left, lease/reservation expiry, scheduled engine syncs, pause recovery, account deletions. */
export function tick(app: App): void {
  removeMediaFolder(app.config.dataDir);
  deliverNews(app);
  expireLeases(app, (job) => settleFailedJob(app, job, { finalFailure: true }));
  expireReservations(app);
  const users = app.db.all<{ id: string; account_id: string; workspace_id: string }>(`SELECT id, account_id, workspace_id FROM engine_users WHERE status = 'ready' AND ${usableAccountSql("engine_users.account_id")}`);
  for (const u of users) {
    const active = app.db.get("SELECT 1 FROM jobs WHERE idempotency_key = ? AND status IN ('queued', 'leased')", `sync:${u.id}`);
    const cp = app.db.get<{ last_attempt_at: string | null; consecutive_failures: number }>("SELECT last_attempt_at, consecutive_failures FROM sync_checkpoints WHERE engine_user_id = ?", u.id);
    // A run that keeps failing waits longer each time (1, 5, 15, then 60 minutes) instead of starting again every interval.
    const wait = syncDelaySeconds(app.config.syncIntervalSeconds, cp?.consecutive_failures ?? 0);
    const due = !cp?.last_attempt_at || Date.parse(cp.last_attempt_at) < Date.now() - wait * 1000;
    const hasSources = app.db.get("SELECT 1 FROM sources WHERE workspace_id = ? AND engine_stream_id IS NOT NULL AND followed = 1 LIMIT 1", u.workspace_id);
    if (!active && due && hasSources) {
      enqueue(app, "engine.sync", { engineUserId: u.id }, { accountId: u.account_id, workspaceId: u.workspace_id, idempotencyKey: `sync:${u.id}` });
    }
    refreshPause(app, u.account_id);
  }
  scheduleIconChecks(app);
  runReminderPass(app);
  runReturningPass(app); // digests, expiring New markers, pauses that run out (throttled inside)
  void runOpmlImports(app); // lists of feeds being followed (a restart picks them up again)
  backfillFeedKeys(app); // private sources made before they had a key
  checkEmptyFeeds(app); // sources still waiting for their first items long after they were followed
  purgeStages(app);
  runDeletions(app);
  wakeHeld(app); // phone wakes quiet hours held back, once they end (throttled inside)
  runDiscoveryPass(app); // hosted: rebuild the co-follow graph when due; self-hosted: keep none
  recheckMail(app);
  drainMail(app);
  purgeMail(app);
  app.db.run("DELETE FROM undo_tokens WHERE expires_at < ?", nowIso());
  app.db.run("DELETE FROM confirm_tokens WHERE expires_at < ?", nowIso());
  purgeCodes(app);
  purgeIdleDevices(app);
  purgeOAuth(app);
  app.db.run("DELETE FROM signup_creations WHERE created_at < ?", addSeconds(-2 * 60 * 60));
  app.db.run("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?", addSeconds(-7 * 86400));
}

/** Tell the operator whether outgoing email works, and why open sign-up stays closed when it doesn't. */
async function reportMail(app: App): Promise<void> {
  const wantsSignup = app.config.mode === "hosted" && app.config.signup === "open";
  if (!app.config.mail) {
    if (wantsSignup) console.warn("[api] Open sign-up is closed: it needs outgoing email (PURSS_SMTP_HOST and PURSS_MAIL_FROM) to confirm addresses and reset passwords. See docs/self-hosting.md.");
    return;
  }
  const ok = await checkMail(app);
  const h = mailHealth(app)!;
  if (ok) console.log(`[api] outgoing email works (${h.server})`);
  else console.warn(`[api] outgoing email: the mail server check failed (${h.lastError}); checking again every 10 minutes.${wantsSignup ? " Open sign-up stays closed until it works." : ""}`);
}

export async function start(config = loadConfig()) {
  const app = createApp(config);
  void startSearchIndexRebuild(app); // only does anything after an upgrade that changed how search folds text
  void startCaptureCheck(app); // only does anything for readable copies saved before captures were checked
  purgeUploads(app, 0); // nothing is uploading yet: whatever a stop left half-written goes
  const code = ensureClaimCode(app);
  watchTrustedProxies(config.trustProxy);
  const pub = publicServer(app, [publicRouter(), ...extraRouters.api()], { publicPages: extraRouters.pages(), events: eventStream });
  const internal = internalServer(app, internalRouter(app));
  await new Promise<void>((resolve) => pub.listen(config.publicPort, config.publicHost, resolve));
  await new Promise<void>((resolve) => internal.listen(config.internalPort, config.internalHost, resolve));
  console.log(`[api] PURSS on ${config.publicOrigin} (listening ${config.publicHost}:${config.publicPort}); internal ${config.internalHost}:${config.internalPort}; mode ${config.mode}${config.assistantOAuth ? "; assistants may sign in with OAuth" : ""}`);
  if (code) console.log(`[api] Not set up yet. Open ${config.publicOrigin}${appUrl("/setup")} and enter the setup code from ${config.secretsDir}/setup-code`);
  void reportMail(app);
  const stopPush = startPush(app);
  tick(app);
  const timer = setInterval(() => { try { tick(app); } catch (err) { console.error("[api] maintenance failed:", err); } }, 15_000);
  /** Stop serving, give messages being sent up to ten seconds (what isn't sent stays queued for the next start), then close. */
  const stop = async () => {
    clearInterval(timer);
    pub.close();
    internal.close();
    pub.closeAllConnections();
    internal.closeAllConnections();
    await Promise.all([settleMail(app, 10_000), stopPush()]);
    app.db.close();
  };
  return { app, stop, publicServer: pub, internalServer: internal };
}

if (import.meta.main) {
  const running = await start();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { console.log(`[api] ${sig}: shutting down`); void running.stop().finally(() => process.exit(0)); });
  }
}
