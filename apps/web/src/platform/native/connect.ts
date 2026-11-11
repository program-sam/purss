import { parseWorkspaceAddress } from "@purss/domain";
import type { ConnectInfo } from "@purss/domain";

/**
 * Connecting the app to a PURSS (plan/24, plan/31): the pure parts, tested on their own. The app signs
 * in or creates an account itself; for a passkey or a linked account it opens PURSS's /connect page
 * in the system browser with a PKCE challenge, the person approves there, and the browser hands a
 * one-time code to purss://connect.
 */

export const REDIRECT_URI = "purss://connect";

/** Whether an answer from /api/connect/info is a PURSS this app can connect to. */
export function checkInfo(v: unknown): { ok: true; info: ConnectInfo } | { ok: false; message: string } {
  const info = v as Partial<ConnectInfo> | null;
  if (!info || info.service !== "purss" || !info.connect) return { ok: false, message: "That address answers, but it isn't a PURSS." };
  const mobile = info.connect.clients?.mobile;
  if (!info.connect.codeChallengeMethods?.includes("S256") || !mobile?.redirectUris.includes(REDIRECT_URI) || typeof info.connect.page !== "string") {
    return { ok: false, message: "This PURSS can't connect this app. It may need updating." };
  }
  return { ok: true, info: info as ConnectInfo };
}

/** Whether PURSS lets the app sign in itself (an older one only offers its Connect page in the browser). */
/** Whether the phone's passkeys work with this PURSS (it vouches for the app). */
export function passkeysOffered(info: ConnectInfo): boolean {
  const s = (info as Partial<ConnectInfo>).signin;
  return !!s && Array.isArray(s.methods) && s.methods.includes("passkey") && typeof s.passkeyOptions === "string";
}

export function signinOffered(info: ConnectInfo): boolean {
  const s = (info as Partial<ConnectInfo>).signin;
  return !!s && Array.isArray(s.methods) && s.methods.includes("password");
}

/** What PURSS lets the app do to create an account; null when it can't (an older PURSS). */
export function signupOffer(info: ConnectInfo): { open: boolean; passwordMin: number } | null {
  const s = (info as Partial<ConnectInfo>).signup;
  return s && s.invitation === true && typeof s.passwordMin === "number" ? { open: s.open === true, passwordMin: s.passwordMin } : null;
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE verifier (32 random bytes) and its S256 challenge, and a state value (16 random bytes). */
export async function pkce(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = b64url(random(32));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest), state: b64url(random(16)) };
}

/** The approval page's address with everything it needs. */
export function connectPageUrl(page: string, p: { challenge: string; state: string; deviceName: string }): string {
  const q = new URLSearchParams({ client: "mobile", redirect_uri: REDIRECT_URI, state: p.state, code_challenge: p.challenge, code_challenge_method: "S256", device_name: p.deviceName });
  return `${page}?${q}`;
}

export type Callback =
  | { kind: "code"; code: string }
  | { kind: "declined" }
  | { kind: "ignored" }
  | { kind: "error"; message: string };

/**
 * What came back to purss://connect. Only an answer to this app's own request counts: the same state is
 * required (anything else is ignored), and the PURSS it asked must name itself (`iss`).
 */
export function readCallback(url: string, expected: { state: string; issuer: string } | null): Callback {
  // Read by hand: older WebViews parse addresses of custom schemes without a host (purss://connect has path "//connect").
  const [base, rest = ""] = url.split("#")[0]!.split(/\?(.*)/s);
  if (base !== REDIRECT_URI || !expected) return { kind: "ignored" };
  const q = new URLSearchParams(rest);
  if (q.get("state") !== expected.state) return { kind: "ignored" };
  // PURSS names itself (RFC 9207 `iss`); an answer that doesn't, or names another, isn't taken.
  if (q.get("iss") !== expected.issuer) return { kind: "error", message: "A different PURSS answered, or it didn't say which it is. Start connecting again." };
  if (q.get("error") === "access_denied") return { kind: "declined" };
  const code = q.get("code");
  if (!code) return { kind: "error", message: "PURSS didn't send a connection code. Start connecting again." };
  return { kind: "code", code };
}

/** The connection waiting for the browser's answer; kept in case the system stops the app meanwhile. */
export type Pending = { origin: string; issuer: string; verifier: string; state: string; startedAt: number; passkeys?: boolean };
export const PENDING_MAX_AGE_MS = 10 * 60_000;

export function parsePending(raw: string | null, now: number): Pending | null {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<Pending> | null;
    if (!v || typeof v.origin !== "string" || typeof v.issuer !== "string" || typeof v.verifier !== "string" || typeof v.state !== "string" || typeof v.startedAt !== "number") return null;
    return now - v.startedAt <= PENDING_MAX_AGE_MS ? { ...(v as Pending), passkeys: v.passkeys === true } : null;
  } catch { return null; }
}

/** The saved connection: which PURSS, the device token, and whether the phone's passkeys work with it. */
export type Connection = { origin: string; token: string; passkeys?: boolean };

export function parseConnection(v: unknown): Connection | null {
  const c = v as Partial<Connection> | null;
  if (!c || typeof c.origin !== "string" || typeof c.token !== "string" || !c.token.startsWith("purss_dev_")) return null;
  const n = parseWorkspaceAddress(c.origin);
  return n.ok && n.origin === c.origin ? { origin: c.origin, token: c.token, passkeys: c.passkeys === true } : null;
}
