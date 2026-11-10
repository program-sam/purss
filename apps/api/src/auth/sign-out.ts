import type { App } from "../app.ts";
import { revokeAllDevices } from "../connect/devices.ts";
import { revokeAllTokens } from "../services/assistant.ts";

/**
 * Sign an account out everywhere. The one place that decides what that covers, so every path ends the
 * same credentials:
 *
 * - "everything" (a password reset by email, the operator's `reissue-recovery-codes`, asking to
 *   delete the account, services/deletion.ts): browser
 *   sessions, connected apps (device tokens; their live streams end), connection and OAuth codes not
 *   yet exchanged, assistant tokens and OAuth grants, and email links not used yet (confirming the
 *   address, resetting the password), which could otherwise sign someone back in or confirm an address.
 * - "suspension": sessions, connected apps and pending codes. Assistant tokens and grants are kept:
 *   they are refused while the account is suspended (its status is checked on every request) and work
 *   again when it is resumed (plan/23, plan/33).
 *
 * Turning the account's assistant switch off ends only the assistants' part (revokeAllTokens). Run
 * inside the caller's transaction.
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
