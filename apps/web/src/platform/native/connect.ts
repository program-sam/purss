import { parsePurssAddress } from "@purss/domain";
import { randomToken, readConnectAnswer, readProviderCode, s256Challenge } from "@purss/domain/connect-protocol";
import { APP_PATH } from "@purss/domain/paths";
import type { ConnectInfo } from "@purss/domain";
import { app } from "@purss/translations/app";

const t = app.platform.connect;

/**
 * Connecting the app to a PURSS: the pure parts, tested on their own. The app signs
 * in or creates an account itself; for a passkey or a linked account it opens PURSS's /connect page
 * in the system browser with a PKCE challenge, the person approves there, and the browser hands a
 * one-time code to purss://connect.
 */

export const REDIRECT_URI = "purss://connect";

/** Whether an answer from /api/connect/info is a PURSS this app can connect to. */
export function checkInfo(v: unknown): { ok: true; info: ConnectInfo } | { ok: false; message: string } {
  const info = v as Partial<ConnectInfo> | null;
  if (!info || info.service !== "purss" || !info.connect) return { ok: false, message: app.words.thatAddressAnswersButItIsn };
  const mobile = info.connect.clients?.mobile;
  if (!info.connect.codeChallengeMethods?.includes("S256") || !mobile?.redirectUris.includes(REDIRECT_URI) || typeof info.connect.page !== "string") {
    return { ok: false, message: t.cantConnect };
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

/**
 * What PURSS lets the app do to create an account: accept an invitation, and where sign-up is open (`start`) have a link emailed
 * that finishes it in the browser. Null when it can't (an older PURSS, which sign-up here would not suit).
 */
export function signupOffer(info: ConnectInfo): { start: string | null; passwordMin: number } | null {
  const s = (info as Partial<ConnectInfo>).signup;
  return s && typeof s.passwordMin === "number" && (s.start === null || typeof s.start === "string") ? { start: s.start, passwordMin: s.passwordMin } : null;
}

/** The external sign-ins this PURSS offers (an older one lists none). */
export function providersOffered(info: ConnectInfo): { id: string; label: string; start: string }[] {
  const list = (info as Partial<ConnectInfo>).signin?.providers;
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.label === "string" && typeof p.start === "string") : [];
}

/** A PKCE verifier (32 random bytes) and its S256 challenge, and a state value (16 random bytes). */
export async function pkce(random?: (n: number) => Uint8Array): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomToken(32, random);
  return { verifier, challenge: await s256Challenge(verifier), state: randomToken(16, random) };
}

/** The approval page's address with everything it needs. */
export function connectPageUrl(page: string, p: { challenge: string; state: string; deviceName: string }): string {
  const q = new URLSearchParams({ client: "mobile", redirect_uri: REDIRECT_URI, state: p.state, code_challenge: p.challenge, code_challenge_method: "S256", device_name: p.deviceName });
  return `${page}?${q}`;
}

/**
 * Where "Continue with <provider>" opens in the system browser: the provider's start address, told to land on the approval
 * page afterwards. Signed in there (or with a new account made there), the person presses Connect and the browser hands the
 * code back to purss://connect, exactly as when the Connect page is opened directly.
 */
export function providerStartUrl(start: string, page: string, p: { challenge: string; state: string; deviceName: string }): string {
  const target = new URL(connectPageUrl(page, p));
  const inApp = (target.pathname.startsWith(`${APP_PATH}/`) ? target.pathname.slice(APP_PATH.length) : target.pathname) + target.search;
  return `${start}?next=${encodeURIComponent(inApp)}`;
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
  const answer = readConnectAnswer(new URLSearchParams(rest), expected);
  switch (answer.kind) {
    case "code":
    case "declined": return answer;
    case "other-attempt": return { kind: "ignored" };
    // PURSS names itself (RFC 9207 `iss`); an answer that doesn't, or names another, isn't taken.
    case "other-purss": return { kind: "error", message: t.differentPurss };
    case "no-code": return { kind: "error", message: t.noCode };
  }
}

/**
 * What came back to purss://connect after the system browser signed the person in at a provider for something the app asked: a
 * `link_code` (adding the provider as a way to sign in) or a `confirm_code` (confirming it's you), never `code`, which is a
 * connection's. The code is redeemed at `/api/auth/oidc/<id>/link` or `/confirm` with the app's token and the verifier it made. Only an
 * answer to this request counts: its state, and the PURSS naming itself.
 */
export function readAppCode(url: string, kind: "link" | "confirm", expected: { state: string; issuer: string }): { kind: "code"; code: string } | { kind: "ignored" } {
  const [base, rest = ""] = url.split("#")[0]!.split(/\?(.*)/s);
  if (base !== REDIRECT_URI) return { kind: "ignored" };
  const code = readProviderCode(new URLSearchParams(rest), expected, kind === "link" ? "link_code" : "confirm_code");
  return code ? { kind: "code", code } : { kind: "ignored" };
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
  const n = parsePurssAddress(c.origin);
  return n.ok && n.origin === c.origin ? { origin: c.origin, token: c.token, passkeys: c.passkeys === true } : null;
}
