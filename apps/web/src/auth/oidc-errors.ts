const DELETING = "This account is being deleted. It can't be signed in to or kept any more.";

/** What the sign-in page says when an external sign-in comes back with a problem (the server's code in `?error=`). */
export function oidcError(code: string, label?: string): string {
  switch (code) {
    case "account_deleting": return DELETING;
    case "email_in_use": return `An account with this email address already exists. Sign in with your username and password, then connect ${label ?? "it"} in Settings → Security.`;
    case "email_unverified": return `${label ?? "The provider"} didn't give PURSS a verified email address, so an account can't be made from it.`;
    case "not_linked": return `That ${label ?? "external"} account isn't connected to an account here. Sign in another way and connect it in Settings → Security first.`;
    case "signup_full": return "New accounts are full for now. Try again later.";
    case "signup_rate_limited": return "Too many attempts to make an account from this address. Try again later.";
    default: return "That sign-in didn't work. Try again, or use another way in.";
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
