/*
 * Connecting the extension to a PURSS (plan/24): authorization code with PKCE (S256). Where the
 * browser has identity.launchWebAuthFlow (Chrome, Edge, Firefox), the PURSS's approval page
 * redirects to the extension's own address, which the browser intercepts; elsewhere (Safari) the page
 * shows a short code that the person types into the options page. Either way the code is exchanged
 * with the verifier at /api/connect/token for the device token.
 */

import { appUrl } from "@purss/domain/paths";

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 32 random bytes, base64url: a 43-character verifier (RFC 7636 section 4.1). */
export function randomVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** BASE64URL(SHA-256(verifier)), the S256 challenge. */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

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
  try { u = new URL(finalUrl); } catch { return { ok: false, reason: "invalid", message: "The PURSS sent back something unexpected. Try connecting again." }; }
  if (!finalUrl.startsWith(expected.redirectUri)) return { ok: false, reason: "invalid", message: "The PURSS sent back something unexpected. Try connecting again." };
  if (u.searchParams.get("state") !== expected.state || u.searchParams.get("iss") !== expected.origin) {
    return { ok: false, reason: "mismatch", message: "That answer didn't come from this connection attempt. Try connecting again." };
  }
  if (u.searchParams.get("error") === "access_denied") return { ok: false, reason: "declined", message: "You chose not to connect." };
  const code = u.searchParams.get("code");
  return code ? { ok: true, code } : { ok: false, reason: "invalid", message: "The PURSS didn't send a connection code. Try connecting again." };
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
  return os ? `${browser} on ${os}` : browser;
}
