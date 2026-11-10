import { newId } from "@purss/domain";
import type { ConnectClientKind, DeviceDTO } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit } from "../app.ts";
import { HttpError, addSeconds, notFound, nowIso } from "../http.ts";
import { randomToken, sha256 } from "../secrets.ts";
import { isAccountUsable } from "../services/deletion.ts";

/*
 * Device tokens for connected apps (plan/24). A token is a bearer credential like a session cookie:
 * 32 random bytes with a recognisable prefix, shown to the app once, only its SHA-256 stored. It
 * acts as its account's principal scoped to the account's PURSS. The phone app's token is a full
 * sign-in: an administrator's is an administrator, and "confirm it's you" (step-up) refreshes its
 * auth_at as it does a session's. The extension's never is either, and reaches only its short list of
 * routes (see clients.ts). A token stops working when revoked, when the account is suspended, reset or
 * set to be deleted, or after IDLE_DAYS without use.
 */

export const DEVICE_TOKEN_PREFIX = "purss_dev_";
/** A token unused for this long stops working (sliding: every use moves it). */
export const IDLE_DAYS = 90;
export const MAX_DEVICES = 20;
/** last_used_at is written at most this often per token: enough for "last used", cheap on the database. */
const LAST_USED_GRANULARITY_MS = 60 * 60_000;
/** A connected app's principal has this prefix plus its device id as its sessionId. */
export const DEVICE_SESSION_PREFIX = "device:";

export type DeviceCaller = { principal: Principal; kind: ConnectClientKind; deviceId: string };

type Row = { id: string; kind: ConnectClientKind; name: string; created_at: string; last_used_at: string };
const toDTO = (r: Row, currentId: string | null): DeviceDTO => ({ id: r.id, kind: r.kind, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.id === currentId });

export const idleCutoff = () => addSeconds(-IDLE_DAYS * 86_400);

/** The device id behind a principal, or null for a browser session. */
export function deviceIdOf(p: Principal): string | null {
  return p.sessionId.startsWith(DEVICE_SESSION_PREFIX) ? p.sessionId.slice(DEVICE_SESSION_PREFIX.length) : null;
}

/** Live event streams opened with a token listen for this, so revoking also ends them. */
export const revokedEvent = (deviceId: string) => `device-revoked:${deviceId}`;

/** A new token for an approved connection. The secret is returned once. */
/**
 * `authMethod` is how the person just proved who they are (it starts the token's step-up clock):
 * 'connect' (approved on the Connect page after a recent sign-in), 'app-password', 'app-recovery',
 * 'invite', or 'signup' (open sign-up proves only an email address, so it counts after a step-up).
 */
export function createDeviceToken(app: App, accountId: string, kind: ConnectClientKind, name: string, authMethod = "connect"): { device: DeviceDTO; secret: string } {
  return app.db.tx(() => {
    const status = app.db.get<{ status: string }>("SELECT status FROM accounts WHERE id = ?", accountId)?.status;
    if (status !== "active") throw new HttpError(403, "suspended", "This account is suspended. Contact the administrator.");
    if (!isAccountUsable(app, accountId)) throw new HttpError(403, "account_deleting", "This account is set to be deleted, so no app can connect to it.");
    if (deviceCount(app, accountId) >= MAX_DEVICES) throw tooMany();
    const secret = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
    const now = nowIso();
    const row: Row = { id: newId("dev"), kind, name, created_at: now, last_used_at: now };
    app.db.run("INSERT INTO device_tokens (id, account_id, kind, name, token_hash, created_at, last_used_at, auth_at, auth_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, accountId, kind, name, sha256(secret), now, now, now, authMethod);
    audit(app, accountId, "device_connect", row.id, "success", kind);
    return { device: toDTO(row, row.id), secret };
  });
}

export function deviceCount(app: App, accountId: string): number {
  return app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM device_tokens WHERE account_id = ? AND last_used_at > ?", accountId, idleCutoff())!.n;
}

export const tooMany = () => new HttpError(409, "too_many_devices", `You can connect up to ${MAX_DEVICES} apps. Disconnect one you no longer use in Settings → Connected apps first.`);

/**
 * The caller behind a bearer secret, or null when it isn't a live token of an active account. Looked
 * up on every request, so revocation and suspension apply to the next one.
 */
export function resolveDeviceToken(app: App, secret: string): DeviceCaller | null {
  if (!secret.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const row = app.db.get<{ id: string; account_id: string; kind: ConnectClientKind; last_used_at: string; created_at: string; auth_at: string | null; auth_method: string; workspace_id: string }>(
    `SELECT d.id, d.account_id, d.kind, d.last_used_at, d.created_at, d.auth_at, d.auth_method, w.id AS workspace_id
     FROM device_tokens d JOIN workspaces w ON w.account_id = d.account_id WHERE d.token_hash = ?`, sha256(secret));
  if (!row || !isAccountUsable(app, row.account_id) || row.last_used_at <= idleCutoff()) return null;
  if (Date.now() - Date.parse(row.last_used_at) > LAST_USED_GRANULARITY_MS) {
    app.db.run("UPDATE device_tokens SET last_used_at = ? WHERE id = ?", nowIso(), row.id);
  }
  return {
    principal: {
      accountId: row.account_id, workspaceId: row.workspace_id, sessionId: `${DEVICE_SESSION_PREFIX}${row.id}`, csrf: "",
      isAdmin: row.kind === "mobile" && !!app.db.get("SELECT 1 FROM role_grants WHERE account_id = ? AND role = 'admin'", row.account_id),
      authAt: row.kind === "mobile" ? deviceAuthAt(row) ?? new Date(0).toISOString() : new Date(0).toISOString(),
    },
    kind: row.kind,
    deviceId: row.id,
  };
}

/** A phone app's last real authentication, by the rule sessions follow (lastRealAuth in auth/accounts.ts). */
export function deviceAuthAt(row: { auth_at: string | null; auth_method: string; created_at: string }): string | null {
  if (!row.auth_at) return null;
  return row.auth_method === "signup" && row.auth_at <= row.created_at ? null : row.auth_at;
}

export function listDevices(app: App, p: Principal): DeviceDTO[] {
  const current = deviceIdOf(p);
  return app.db.all<Row>("SELECT id, kind, name, created_at, last_used_at FROM device_tokens WHERE account_id = ? AND last_used_at > ? ORDER BY last_used_at DESC, id",
    p.accountId, idleCutoff()).map((r) => toDTO(r, current));
}

/** Disconnect one of the account's apps. */
export function revokeDevice(app: App, p: Principal, id: string, how: "settings" | "self"): { ok: true } {
  const r = app.db.run("DELETE FROM device_tokens WHERE id = ? AND account_id = ?", id, p.accountId);
  if (!r.changes) throw notFound("That app");
  audit(app, p.accountId, "device_revoke", id, "success", how);
  app.events.emit(revokedEvent(id));
  return { ok: true };
}

/** Disconnect every app of an account (operator reset, suspension). Returns how many. */
export function revokeAllDevices(app: App, accountId: string): number {
  const ids = app.db.all<{ id: string }>("SELECT id FROM device_tokens WHERE account_id = ?", accountId).map((r) => r.id);
  app.db.run("DELETE FROM device_tokens WHERE account_id = ?", accountId);
  for (const id of ids) app.events.emit(revokedEvent(id));
  return ids.length;
}

/** Drop tokens idle past IDLE_DAYS (maintenance tick). */
export function purgeIdleDevices(app: App): void {
  app.db.run("DELETE FROM device_tokens WHERE last_used_at <= ?", idleCutoff());
}
