import type { ConnectClientKind } from "@purss/domain";

/*
 * The first-party clients that may connect (plan/24), fixed in code: no registration, nothing for an
 * operator to set up. What each kind may send as a redirect target, which browser origins may call
 * the API with its token, and which routes its token reaches.
 */

/** The custom URL scheme the mobile app registers; the only redirect target for kind "mobile". */
export const MOBILE_REDIRECT = "purss://connect";

const CHROMIUM_HOST = /^([a-p]{32})\.chromiumapp\.org$/;
const FIREFOX_HOST = /^([0-9a-f]{40})\.extensions\.allizom\.org$/;

/**
 * Check a redirect target for a client kind; null when it isn't allowed. Never redirect to anything
 * that fails this: an approval page that redirects anywhere would be an open redirect that hands out codes.
 *
 * - mobile: exactly `purss://connect`.
 * - extension: what `identity.getRedirectURL()` returns. Chromium browsers:
 *   `https://<32-letter extension id>.chromiumapp.org/<path>`; Firefox:
 *   `https://<SHA-1 hex of the add-on id>.extensions.allizom.org/<path>` (pref
 *   extensions.webextensions.identity.redirectDomain). The browser intercepts these inside
 *   `identity.launchWebAuthFlow`, so the code never reaches the network. Firefox's loopback
 *   alternative (http://127.0.0.1/mozoauth2/…) is not accepted: any local program could listen there.
 *   No query, fragment, port or credentials, and the address must already be in its normal form.
 */
export function checkRedirect(kind: ConnectClientKind, raw: string): { uri: string; label: string } | null {
  if (kind === "mobile") return raw === MOBILE_REDIRECT ? { uri: raw, label: "The PURSS app on this device" } : null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.href !== raw || u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
  const chromium = CHROMIUM_HOST.exec(u.hostname);
  if (chromium) return { uri: raw, label: `Extension ${chromium[1]} in Chrome, Edge or another Chromium browser` };
  const firefox = FIREFOX_HOST.exec(u.hostname);
  if (firefox) return { uri: raw, label: `Extension ${firefox[1]!.slice(0, 12)}… in Firefox` };
  return null;
}

/** Redirect targets as advertised by /api/connect/info. */
export const REDIRECT_PATTERNS: Record<ConnectClientKind, string[]> = {
  mobile: [MOBILE_REDIRECT],
  extension: ["https://<extension id>.chromiumapp.org/", "https://<add-on id hash>.extensions.allizom.org/"],
};

export const DEFAULT_DEVICE_NAME: Record<ConnectClientKind, string> = { mobile: "Phone, tablet or computer", extension: "Browser extension" };

/** A display name from the app: control characters removed, spaces collapsed, at most 80 characters. */
export function cleanDeviceName(kind: ConnectClientKind, raw: string | undefined): string {
  const name = (raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return name || DEFAULT_DEVICE_NAME[kind];
}

/**
 * Browser origins the apps run in, which may call the API cross-origin with a device token:
 * the Capacitor WebView (iOS `capacitor://localhost`; Android `https://localhost`, or
 * `http://localhost` when the app is built with that scheme), the desktop app's Tauri page
 * (`tauri://localhost`; Windows `http://tauri.localhost`, plan/42) and extension pages. Extension ids
 * aren't pinned: self-built and Firefox per-install origins differ. This list only decides who gets
 * CORS answers for token requests; it grants nothing by itself (see plan/24).
 */
export function isClientOrigin(origin: string): boolean {
  return origin === "capacitor://localhost" || origin === "https://localhost" || origin === "http://localhost"
    || origin === "tauri://localhost" || origin === "http://tauri.localhost"
    || /^(chrome-extension|moz-extension|safari-web-extension):\/\/[A-Za-z0-9-]{1,64}$/.test(origin);
}

/** Routes the extension's token reaches, exactly (method and path). Everything else is refused. */
const EXTENSION_ROUTES = new Set([
  "GET /api/session",
  "GET /api/baskets",
  "GET /api/collections",
  "GET /api/items/lookup",
  "POST /api/items/manual",
  "POST /api/items/browser-capture",
  "GET /api/search",
  "POST /api/discover",
  "POST /api/sources",
  "DELETE /api/connect/device",
]);

/**
 * The phone app does everything the browser does (account security, administration, assistants,
 * connected apps), behind the same "confirm it's you" step-up a session needs. What it doesn't do is
 * approve another app's connection or an assistant's sign-in: those pages belong to the browser the
 * other app or the assistant opened.
 */
const NOT_FOR_THE_PHONE_APP = /^\/api\/(connect\/(request|approve)|assistant\/oauth)(\/|$)/;

export function deviceMayUse(kind: ConnectClientKind, method: string, path: string): boolean {
  const m = method === "HEAD" ? "GET" : method;
  if (kind === "extension") return EXTENSION_ROUTES.has(`${m} ${path}`);
  return !NOT_FOR_THE_PHONE_APP.test(path);
}
