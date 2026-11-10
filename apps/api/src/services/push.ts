import { safeFetch } from "@purss/connectors";
import type { SafeFetchOptions } from "@purss/connectors";
import { inQuietHours } from "@purss/domain";
import type { PushInfo, PushNotice, PushPending, PushRegisterResult } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { NOTIFICATION_EVENT, audit } from "../app.ts";
import { deviceIdOf, idleCutoff } from "../connect/devices.ts";
import { HttpError, nowIso } from "../http.ts";
import { randomToken, sha256 } from "../secrets.ts";
import { usableAccountSql } from "./deletion.ts";
import { notificationsOn } from "./notifications.ts";
import { getPreferences } from "./preferences.ts";
import { validTimezone } from "./reminders.ts";

/*
 * Phone notifications (plan/37). A connected phone app registers the handle the push relay gave it
 * (POST /api/push/device) and gets a narrow fetch credential back. When something new reaches the bell,
 * the API asks the relay, by handle only, to wake the phone; the phone then fetches the texts with that
 * credential (POST /api/push/pending). The relay, Google and Apple never see any text.
 *
 * Who is told follows the person's notification settings, which already decide what reaches the bell:
 * nothing while notifications are off, and nothing during quiet hours (it waits in the bell, and the
 * maintenance tick wakes the phone once they end: `wakeHeld`). Each phone is handed each notification
 * once, and again when its text grows ("3 new from …"). Waking is best-effort: a failure is logged
 * without the handle and touches nothing else.
 */

export const FETCH_TOKEN_PREFIX = "purss_push_";
/** Notifications are gathered this long before a phone is woken, so a sync batch wakes it once. */
const GATHER_MS = 3000;
/** A phone is woken at most this often; anything newer waits for the next wake or is fetched with it. */
const MIN_GAP_MS = 60_000;
/** At most this many notifications are shown per wake; older ones that are still waiting stay in the bell. */
const MAX_PER_FETCH = 5;

let testHooks: Pick<SafeFetchOptions, "testAllowAddress"> = {};
/** TEST ONLY: let the relay be a local server (safeFetch's in-process escape hatch; no setting can do this). */
export function setRelayFetchForTests(hooks: typeof testHooks): void {
  testHooks = hooks;
}

type DeviceRow = { device_id: string; handle: string; shown_until: string; pushed_at: string | null };

function mobileDevice(app: App, p: Principal): string {
  const id = deviceIdOf(p);
  const kind = id ? app.db.get<{ kind: string }>("SELECT kind FROM device_tokens WHERE id = ? AND account_id = ?", id, p.accountId)?.kind : undefined;
  if (!id || kind !== "mobile") throw new HttpError(400, "not_phone", "Phone notifications are for the phone app.");
  return id;
}

export function pushInfo(app: App, p: Principal): PushInfo {
  const id = deviceIdOf(p);
  const relay = app.config.pushRelay;
  const registered = !!(id && relay && app.db.get("SELECT 1 FROM push_devices WHERE device_id = ? AND relay = ?", id, relay));
  return { relay, registered };
}

/**
 * Register (or replace) the calling phone's relay handle. Returns a new fetch credential, shown once; the
 * one before stops working. What the phone was already handed stays handed.
 */
export function registerPushDevice(app: App, p: Principal, relay: string, handle: string): PushRegisterResult {
  const deviceId = mobileDevice(app, p);
  if (!app.config.pushRelay) throw new HttpError(409, "push_off", "This PURSS doesn't send phone notifications.");
  if (relay !== app.config.pushRelay) throw new HttpError(409, "push_relay", "This PURSS sends phone notifications through a different relay than this app uses.");
  const fetchToken = `${FETCH_TOKEN_PREFIX}${randomToken(32)}`;
  const now = nowIso();
  app.db.run(
    `INSERT INTO push_devices (device_id, account_id, relay, handle, fetch_hash, shown_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET relay = excluded.relay, handle = excluded.handle, fetch_hash = excluded.fetch_hash`,
    deviceId, p.accountId, relay, handle, sha256(fetchToken), now, now);
  audit(app, p.accountId, "push_register", deviceId, "success");
  return { fetchToken };
}

export function unregisterPushDevice(app: App, p: Principal): { ok: true } {
  const deviceId = mobileDevice(app, p);
  if (app.db.run("DELETE FROM push_devices WHERE device_id = ? AND account_id = ?", deviceId, p.accountId).changes) audit(app, p.accountId, "push_unregister", deviceId, "success");
  return { ok: true };
}

const pendingSql = `FROM notifications WHERE workspace_id = ? AND read_at IS NULL AND COALESCE(changed_at, created_at) > ?`;
/** A phone is woken for what it wasn't handed and arrived since its last wake (a wake it didn't answer isn't repeated). */
const wakeSince = (d: { shown_until: string; pushed_at: string | null }) => (d.pushed_at && d.pushed_at > d.shown_until ? d.pushed_at : d.shown_until);

/**
 * What a woken phone shows: the unread notifications it hasn't been handed yet (newest few, oldest first),
 * after which they count as handed. Titles as in the bell; the body only when the person shows titles in
 * notifications, as for browser alerts. Null when the credential isn't a live phone's.
 */
export function takePending(app: App, fetchToken: string): PushPending | null {
  if (!fetchToken.startsWith(FETCH_TOKEN_PREFIX)) return null;
  return app.db.tx(() => {
    const row = app.db.get<{ device_id: string; shown_until: string; workspace_id: string }>(
      `SELECT pd.device_id, pd.shown_until, w.id AS workspace_id FROM push_devices pd
         JOIN device_tokens d ON d.id = pd.device_id JOIN workspaces w ON w.account_id = pd.account_id
       WHERE pd.fetch_hash = ? AND d.last_used_at > ? AND ${usableAccountSql("pd.account_id")}`, sha256(fetchToken), idleCutoff());
    if (!row) return null;
    const prefs = getPreferences(app, row.workspace_id);
    if (!notificationsOn(prefs)) return { notifications: [] };
    const latest = app.db.get<{ at: string | null }>(`SELECT MAX(COALESCE(changed_at, created_at)) AS at ${pendingSql}`, row.workspace_id, row.shown_until)?.at;
    if (!latest) return { notifications: [] };
    const list = app.db.all<{ id: string; title: string; body: string | null; item_id: string | null; source_id: string | null }>(
      `SELECT id, title, body, item_id, source_id ${pendingSql} ORDER BY COALESCE(changed_at, created_at) DESC, id DESC LIMIT ?`, row.workspace_id, row.shown_until, MAX_PER_FETCH);
    app.db.run("UPDATE push_devices SET shown_until = ? WHERE device_id = ?", latest, row.device_id);
    const notifications: PushNotice[] = list.reverse().map((n) => ({ id: n.id, title: n.title, body: prefs.notifications.previews ? n.body : null, itemId: n.item_id, sourceId: n.source_id }));
    return { notifications };
  });
}

// ---------- waking phones ----------

type Waker = { timers: Map<string, NodeJS.Timeout>; stopped: boolean; inFlight: Set<Promise<void>> };
const wakers = new WeakMap<App, Waker>();

/** Start waking phones when notifications are made (the running server; tests call it too). Returns stop. */
export function startPush(app: App): () => Promise<void> {
  const w: Waker = { timers: new Map(), stopped: false, inFlight: new Set() };
  wakers.set(app, w);
  const onNotification = (accountId: string) => schedule(app, w, accountId, GATHER_MS);
  app.events.on(NOTIFICATION_EVENT, onNotification);
  return async () => {
    w.stopped = true;
    app.events.off(NOTIFICATION_EVENT, onNotification);
    for (const t of w.timers.values()) clearTimeout(t);
    w.timers.clear();
    await Promise.allSettled([...w.inFlight]);
  };
}

function schedule(app: App, w: Waker, accountId: string, delayMs: number): void {
  if (w.stopped || !app.config.pushRelay || w.timers.has(accountId)) return;
  const t = setTimeout(() => {
    w.timers.delete(accountId);
    const run = wakePhones(app, accountId).then((retryMs) => { if (retryMs !== null) schedule(app, w, accountId, retryMs); })
      .catch((err) => console.warn("[api] waking a phone failed:", err instanceof Error ? err.message : err))
      .finally(() => w.inFlight.delete(run));
    w.inFlight.add(run);
  }, delayMs);
  t.unref();
  w.timers.set(accountId, t);
}

/** How often the maintenance tick looks for wakes held back (by quiet hours, or lost to a restart). */
const HELD_EVERY_MS = 60_000;
const heldCheckedAt = new WeakMap<App, number>();

/**
 * From the maintenance tick: wake the phones that have something they weren't handed and that arrived since
 * their last wake, at most once a minute. That is what quiet hours held back (the wake is then sent once
 * they end, so overnight items arrive in the morning) and a wake a restart lost while it was gathering.
 * Worked out from the database alone, so nothing is lost when the server restarts.
 */
export function wakeHeld(app: App, now = Date.now()): void {
  const w = wakers.get(app);
  if (!w || w.stopped || !app.config.pushRelay) return;
  if ((heldCheckedAt.get(app) ?? 0) > now - HELD_EVERY_MS) return;
  heldCheckedAt.set(app, now);
  const accounts = app.db.all<{ account_id: string }>(
    `SELECT DISTINCT pd.account_id FROM push_devices pd JOIN device_tokens d ON d.id = pd.device_id JOIN workspaces w ON w.account_id = pd.account_id
     WHERE pd.relay = ? AND d.last_used_at > ? AND EXISTS (
       SELECT 1 FROM notifications n WHERE n.workspace_id = w.id AND n.read_at IS NULL
         AND COALESCE(n.changed_at, n.created_at) > pd.shown_until AND COALESCE(n.changed_at, n.created_at) > COALESCE(pd.pushed_at, ''))`,
    app.config.pushRelay, idleCutoff());
  // wakePhones itself leaves out accounts still in quiet hours or with notifications off.
  for (const a of accounts) schedule(app, w, a.account_id, 0);
}

/**
 * Ask the relay to wake each of the account's phones that has something it hasn't been handed. Returns when
 * to look again (a phone woken too recently, or a relay asking to slow down), or null.
 */
export async function wakePhones(app: App, accountId: string, now = Date.now()): Promise<number | null> {
  const relay = app.config.pushRelay;
  if (!relay) return null;
  const ws = app.db.get<{ id: string }>(`SELECT id FROM workspaces WHERE account_id = ? AND ${usableAccountSql("workspaces.account_id")}`, accountId);
  if (!ws) return null;
  const prefs = getPreferences(app, ws.id);
  if (!notificationsOn(prefs)) return null;
  const n = prefs.notifications;
  // Held back, as browser alerts are: it waits in the bell.
  if (inQuietHours(new Date(now), n.quietStart, n.quietEnd, validTimezone(prefs.timezone))) return null;
  const devices = app.db.all<DeviceRow>(
    `SELECT pd.device_id, pd.handle, pd.shown_until, pd.pushed_at FROM push_devices pd JOIN device_tokens d ON d.id = pd.device_id
     WHERE pd.account_id = ? AND pd.relay = ? AND d.last_used_at > ?`, accountId, relay, idleCutoff());
  let retry: number | null = null;
  const later = (ms: number) => { retry = retry === null ? ms : Math.min(retry, ms); };
  for (const d of devices) {
    if (!app.db.get(`SELECT 1 ${pendingSql} LIMIT 1`, ws.id, wakeSince(d))) continue;
    const since = d.pushed_at ? now - Date.parse(d.pushed_at) : Infinity;
    if (since < MIN_GAP_MS) { later(MIN_GAP_MS - since); continue; }
    const r = await safeFetch(`${relay}/v1/notify`, {
      ...testHooks,
      post: { body: JSON.stringify({ handle: d.handle }), contentType: "application/json" },
      accept: "application/json",
      maxBytes: 4096,
      maxRedirects: 0,
      timeoutMs: 10_000,
      phaseTimeoutsMs: { resolveMs: 3000, connectMs: 4000, firstByteMs: 8000, idleMs: 3000 },
    });
    if (!r.ok) { console.warn(`[api] the push relay couldn't be reached (${r.reason}); this wake is skipped.`); continue; }
    const status = r.response.status;
    if (status === 202 || status === 200) {
      app.db.run("UPDATE push_devices SET pushed_at = ? WHERE device_id = ?", new Date(now).toISOString(), d.device_id);
    } else if (status === 404) {
      // The relay no longer knows the phone (uninstalled, or its push address expired): it registers again when it next starts.
      app.db.run("DELETE FROM push_devices WHERE device_id = ? AND handle = ?", d.device_id, d.handle);
    } else if (status === 429) {
      const after = Number(r.response.headers["retry-after"]);
      later(Math.min(Math.max(Number.isFinite(after) ? after * 1000 : MIN_GAP_MS, 1000), 15 * 60_000));
    } else {
      console.warn(`[api] the push relay answered ${status}; this wake is skipped.`);
    }
  }
  return retry;
}
