import { app } from "@purss/copy/app";

const t = app.auth.oidcErrors;

/** What the sign-in page says when an external sign-in comes back with a problem (the server's code in `?error=`). */
export function oidcError(code: string, label?: string): string {
  switch (code) {
    case "account_deleting": return t.deleting;
    case "email_in_use": return t.emailInUse(label);
    case "email_unverified": return t.emailUnverified(label);
    case "not_linked": return t.notLinked(label);
    case "signup_full": return t.signupFull;
    case "signup_rate_limited": return t.signupRateLimited;
    default: return t.didntWork;
  }
}

/**
 * The message for a failed sign-in, naming the provider that failed (`?provider=` in the server's redirect). An address without one
 * (an old link) names the first provider set up, or none.
 */
export function oidcErrorFor(code: string, providerId: string | undefined, providers: { id: string; label: string }[]): string {
  const failed = providers.find((p) => p.id === providerId) ?? providers[0];
  return oidcError(code, failed?.label);
}
