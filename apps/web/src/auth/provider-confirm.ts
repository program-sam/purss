import { ApiError, api, post } from "../api/client.ts";
import { platform } from "../platform/index.ts";
import { withinApp } from "../app-base.ts";
import { rememberConfirming } from "./confirm-marker.ts";

/*
 * "Confirm it's you" with a linked external sign-in (Google): the provider checks the person again and PURSS marks this
 * session (or this app's connection) as recently confirmed. A browser leaves for the provider and comes back to `returnTo`, so
 * what was being done starts again, now allowed. An app can't show the provider's page itself (Google refuses embedded web
 * views): it opens the system browser with a single-use ticket and waits until PURSS says it is confirmed.
 */

const WAIT_MS = 5 * 60_000;
const POLL_MS = 2_000;

const enc = encodeURIComponent;
/** Where to come back to: an in-app path, `?dialog=` names a popup to open again. */
export function currentPath(): string {
  return withinApp(window.location.pathname) + window.location.search;
}

const security = () => api<{ recentAuth: boolean; methods: { kind: string; label: string | null }[] }>("/api/account/security", { live: true });

/** Resolves once `done` is true (the person finished in the system browser, and PURSS says so), or fails after a few minutes. */
async function waitFor(done: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (await done().catch(() => false)) return;
  }
  throw new ApiError(0, "timeout", "That wasn't finished in the browser. Try again.");
}

export async function confirmWithProvider(provider: { id: string; label: string }, returnTo?: string): Promise<void> {
  if (platform.connection) {
    const { url } = await post<{ url: string }>(`/api/auth/oidc/${enc(provider.id)}/ticket`, { purpose: "stepup" });
    platform.openExternal(url);
    await waitFor(async () => (await security()).recentAuth);
    return;
  }
  rememberConfirming(provider.label);
  window.location.assign(`/api/auth/oidc/${enc(provider.id)}/start?stepup=1&next=${enc(returnTo ?? currentPath())}`);
  // The page is leaving: nothing to resolve.
  await new Promise<never>(() => undefined);
}

/**
 * Add the provider as a way to sign in to the signed-in account (it needs a recent sign-in first). A browser leaves for the
 * provider and comes back to Settings → Security; an app does it in the system browser and resolves once it is linked.
 */
export async function linkWithProvider(provider: { id: string; label: string }): Promise<void> {
  if (!platform.connection) {
    window.location.assign(`/api/auth/oidc/${enc(provider.id)}/start?link=1`);
    await new Promise<never>(() => undefined);
    return;
  }
  const { url } = await post<{ url: string }>(`/api/auth/oidc/${enc(provider.id)}/ticket`, { purpose: "link" });
  platform.openExternal(url);
  await waitFor(async () => (await security()).methods.some((m) => m.kind === "oidc" && m.label === provider.label));
}

/** What to tell the person back from the provider's page, as PURSS itself says whether they are confirmed. */
export async function confirmationNotice(label: string): Promise<string> {
  return (await security()).recentAuth
    ? `Confirmed with ${label}. You can go ahead and do that again now.`
    : `${label} didn't confirm it's you. Try again, or use another way.`;
}
