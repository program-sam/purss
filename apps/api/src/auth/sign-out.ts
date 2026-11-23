import type { App } from "../app.ts";
import { revokeAllDevices } from "../connect/devices.ts";
import { revokeAllTokens } from "../services/assistant.ts";

/**
 * Sign an account out everywhere. The one place that decides what that covers, so every path ends the
 * same credentials:
 *
 * - "everything" (a password reset, by email or with a link the administrator made, asking to
 *   delete the account, services/deletion.ts): browser
 *   sessions, connected apps (device tokens; their live streams end), connection and OAuth codes not
 *   yet exchanged, assistant tokens and OAuth grants, and email links not used yet (confirming the
 *   address, resetting the password), which could otherwise sign someone back in or confirm an address.
 * - "suspension": sessions, connected apps and pending codes. Assistant tokens and grants are kept:
 *   they are refused while the account is suspended (its status is checked on every request) and work
 *   again when it is resumed.
 *
 * Turning the account's assistant switch off ends only the assistants' part (revokeAllTokens). Run
 * inside the caller's transaction.
 *
 * A password change ends the same as "everything" except the one browser session or connected app it was made
 * from (signOutAllElse), so a session, app token or assistant taken with the old password stops working.
 */
export function signOutEverywhere(app: App, accountId: string, why: "everything" | "suspension"): void {
  app.db.run("DELETE FROM sessions WHERE account_id = ?", accountId);
  revokeAllDevices(app, accountId);
  app.db.run("DELETE FROM connect_codes WHERE account_id = ?", accountId);
  if (why === "everything") {
    revokeAllTokens(app, accountId);
    app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND used_at IS NULL", accountId);
  }
}

/**
 * Everything "everything" ends except the caller: the browser session `sessionId`, or the connected app whose device
 * session it is. Returns the browser sessions and connected apps it ended, whose open event streams the caller closes
 * once the transaction has committed. Run inside the caller's transaction.
 */
export function signOutAllElse(app: App, accountId: string, sessionId: string, deviceId: string | null): { sessions: string[]; devices: string[] } {
  const sessions = app.db.all<{ id: string }>("SELECT id FROM sessions WHERE account_id = ? AND id <> ?", accountId, sessionId).map((r) => r.id);
  app.db.run("DELETE FROM sessions WHERE account_id = ? AND id <> ?", accountId, sessionId);
  const devices = app.db.all<{ id: string }>("SELECT id FROM device_tokens WHERE account_id = ? AND id IS NOT ?", accountId, deviceId).map((r) => r.id);
  app.db.run("DELETE FROM device_tokens WHERE account_id = ? AND id IS NOT ?", accountId, deviceId);
  app.db.run("DELETE FROM connect_codes WHERE account_id = ?", accountId);
  revokeAllTokens(app, accountId);
  app.db.run("DELETE FROM email_tokens WHERE account_id = ? AND used_at IS NULL", accountId);
  return { sessions, devices };
}
