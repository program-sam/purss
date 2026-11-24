/*
 * Connecting the extension to a PURSS: authorization code with PKCE (S256). Where the
 * browser has identity.launchWebAuthFlow (Chrome, Edge, Firefox), the PURSS's approval page
 * redirects to the extension's own address, which the browser intercepts; elsewhere (Safari) the page
 * shows a short code that the person types into the options page. Either way the code is exchanged
 * with the verifier at /api/connect/token for the device token.
 */

import { extension } from "@purss/translations/extension";
import { readConnectAnswer } from "@purss/domain/connect-protocol";
import { appUrl } from "@purss/domain/paths";

/** The approval page's address. Leave out the redirect for the typed-code form. */
export function connectPageUrl(origin: string, p: { challenge: string; deviceName: string; redirect?: { uri: string; state: string } }): string {
  const q = new URLSearchParams({ client: "extension", code_challenge: p.challenge, code_challenge_method: "S256", device_name: p.deviceName });
  if (p.redirect) { q.set("redirect_uri", p.redirect.uri); q.set("state", p.redirect.state); }
  return `${origin}${appUrl("/connect")}?${q}`;
}

export type RedirectOutcome = { ok: true; code: string } | { ok: false; reason: "declined" | "mismatch" | "invalid"; message: string };

/**
 * Read the address the approval page sent the browser to. It must be the extension's own redirect
 * address, carry the state this attempt sent, and name the PURSS it was sent to (`iss`, RFC 9207),
 * so a code from some other PURSS or attempt is never exchanged.
 */
export function readRedirect(finalUrl: string, expected: { redirectUri: string; state: string; origin: string }): RedirectOutcome {
  let u: URL;
  try { u = new URL(finalUrl); } catch { return { ok: false, reason: "invalid", message: extension.connect.unexpectedAnswer }; }
  if (!finalUrl.startsWith(expected.redirectUri)) return { ok: false, reason: "invalid", message: extension.connect.unexpectedAnswer };
  const answer = readConnectAnswer(u.searchParams, { state: expected.state, issuer: expected.origin });
  switch (answer.kind) {
    case "code": return { ok: true, code: answer.code };
    case "declined": return { ok: false, reason: "declined", message: extension.connect.declined };
    case "no-code": return { ok: false, reason: "invalid", message: extension.connect.noCode };
    case "other-attempt":
    case "other-purss": return { ok: false, reason: "mismatch", message: extension.connect.otherAttempt };
  }
}

/** A typed code as your PURSS shows it ("abcd-efgh-ijkm"), forgiving spaces and case. */
export function cleanTypedCode(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toLowerCase();
}

/** "Firefox on Linux": how the PURSS lists this connection until the person renames it. */
export function deviceNameFor(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /OPR\//.test(userAgent) ? "Opera"
    : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iPod/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /CrOS/.test(userAgent) ? "ChromeOS"
    : /Windows/.test(userAgent) ? "Windows" : /Mac OS X|Macintosh/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? extension.connect.deviceName(browser, os) : browser;
}
