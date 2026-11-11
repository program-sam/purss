import type { App } from "../app.ts";
import { issuerKey } from "../config.ts";
import type { OidcProviderConfig } from "../config.ts";

/*
 * Which external sign-ins an account really has: its stored provider sign-ins matched, by issuer address, to the providers set up
 * here. A stored sign-in for a provider that is no longer configured can't be used, so it is not a way in and can't confirm anything.
 */

/** The configured providers this account has linked. */
export function linkedProviders(app: App, accountId: string): OidcProviderConfig[] {
  const stored = new Set(app.db.all<{ issuer: string | null }>("SELECT issuer FROM sign_in_methods WHERE account_id = ? AND kind = 'oidc'", accountId)
    .map((m) => issuerKey(m.issuer ?? "")));
  return app.config.oidc.filter((p) => stored.has(issuerKey(p.issuer)));
}

export const hasPassword = (app: App, accountId: string): boolean =>
  !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'password'", accountId);
export const hasPasskey = (app: App, accountId: string): boolean =>
  !!app.db.get("SELECT 1 FROM sign_in_methods WHERE account_id = ? AND kind = 'passkey'", accountId);

/**
 * Whether this provider may confirm it's you for the account now. One that re-authenticates the person can. One that can only show
 * its account chooser proves less than a password or a passkey does, so it confirms only accounts that have neither.
 */
export function canConfirm(app: App, accountId: string, p: OidcProviderConfig): boolean {
  return p.stepUp === "reauthenticate" || (!hasPassword(app, accountId) && !hasPasskey(app, accountId));
}
