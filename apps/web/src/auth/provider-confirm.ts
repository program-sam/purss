import { ApiError, api, post } from "../api/client.ts";
import { platform } from "../platform/index.ts";
import { withinApp } from "../app-base.ts";
import { pkce, readAppCode } from "../platform/native/connect.ts";
import { rememberConfirming } from "./confirm-marker.ts";

/*
 * "Confirm it's you" with a linked external sign-in (Google): the provider checks the person again and PURSS marks this
 * session (or this app's connection) as recently confirmed. A browser leaves for the provider and comes back to `returnTo`, so
 * what was being done starts again, now allowed. An app can't show the provider's page itself (Google refuses embedded web
 * views): it opens the system browser with a single-use ticket, and the browser's answer comes back to it at purss://connect as a
 * code, which the app redeems with its own token and a verifier only it holds. The browser alone changes nothing.
 */

const WAIT_MS = 5 * 60_000;

const enc = encodeURIComponent;
/** Where to come back to: an in-app path, `?dialog=` names a popup to open again. */
export function currentPath(): string {
  return withinApp(window.location.pathname) + window.location.search;
}

const security = () => api<{ recentAuth: boolean }>("/api/account/security", { live: true });

/**
 * What an app does for a link or a confirmation: keep a verifier, ask for a ticket carrying its challenge, open the system browser,
 * wait for the code the browser sends back to purss://connect, and redeem it. Fails if the person doesn't finish in a few minutes.
 */
async function throughSystemBrowser(provider: { id: string }, purpose: "link" | "stepup"): Promise<void> {
  const kind = purpose === "link" ? "link" : "confirm";
  const request = await pkce();
  let cancel = () => {};
  const code = new Promise<string>((resolve, reject) => {
    const stop = platform.onConnectReturn((url) => {
      const back = readAppCode(url, kind, { state: request.state, issuer: platform.publicOrigin() });
      if (back.kind === "code") resolve(back.code);
    });
    const timer = setTimeout(() => reject(new ApiError(0, "timeout", "That wasn't finished in the browser. Try again.")), WAIT_MS);
    cancel = () => { clearTimeout(timer); stop(); };
  });
  try {
    const { url } = await post<{ url: string }>(`/api/auth/oidc/${enc(provider.id)}/ticket`, { purpose, codeChallenge: request.challenge, state: request.state });
    platform.openExternal(url);
    await post(`/api/auth/oidc/${enc(provider.id)}/${kind}`, { code: await code, codeVerifier: request.verifier });
  } finally { cancel(); }
}

export async function confirmWithProvider(provider: { id: string; label: string }, returnTo?: string): Promise<void> {
  if (platform.connection) {
    await throughSystemBrowser(provider, "stepup");
    return;
  }
  rememberConfirming(provider.label);
  window.location.assign(`/api/auth/oidc/${enc(provider.id)}/start?stepup=1&next=${enc(returnTo ?? currentPath())}`);
  // The page is leaving: nothing to resolve.
  await new Promise<never>(() => undefined);
}

/**
 * Add the provider as a way to sign in to the signed-in account (it needs a recent sign-in first). A browser leaves for the
 * provider and comes back to Settings → Security; an app does it in the system browser, which never links anything itself.
 */
export async function linkWithProvider(provider: { id: string; label: string }): Promise<void> {
  if (!platform.connection) {
    window.location.assign(`/api/auth/oidc/${enc(provider.id)}/start?link=1`);
    await new Promise<never>(() => undefined);
    return;
  }
  await throughSystemBrowser(provider, "link");
}

/** What to tell the person back from the provider's page, as PURSS itself says whether they are confirmed. */
export async function confirmationNotice(label: string): Promise<string> {
  return (await security()).recentAuth
    ? `Confirmed with ${label}. You can go ahead and do that again now.`
    : `${label} didn't confirm it's you. Try again, or use another way.`;
}
