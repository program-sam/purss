import { createHmac } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { App } from "../app.ts";
import { clearRateLimit, rateLimit, setCookie } from "../http.ts";
import { ensureSecret, randomToken, safeEqual } from "../secrets.ts";
import { normalizeEmail } from "./passwords.ts";

/*
 * Password guesses per account. Each attempt takes one of 10 tries per 15 minutes before the password
 * is checked (so parallel guesses can't slip past), and a correct password gives the tries back.
 * A browser (or phone app) that has signed in to the account before carries a value that gives it tries of its own:
 * someone spending the shared tries on purpose can't keep the account's person out of a browser or app they use.
 * A browser that never signed in to the account shares the account's tries: that much lockout is the price of the limit.
 */
const TRIES = 10;
const KNOWN_CHECKS = 30;
const WINDOW_MS = 15 * 60_000;
export const KNOWN_COOKIE = "purss_known";
const KNOWN_DAYS = 400;

const keys = new WeakMap<App, string>();
function key(app: App): string {
  let k = keys.get(app);
  if (!k) keys.set(app, (k = ensureSecret(app.config.secretsDir, "sign-in-key")));
  return k;
}
const mac = (app: App, nonce: string, email: string) => createHmac("sha256", key(app)).update(`${nonce}\n${email}`).digest("base64url");

/**
 * The tries bucket for this sign-in: the browser's own when its cookie was given for this address (`known`),
 * otherwise the shared one. A known browser also skips the per-network-address limit: its own tries already
 * bound it, and others failing on the same network (shared Wi-Fi, an office) mustn't keep it out.
 */
export type Tries = { bucket: string; known: boolean; address: string };
export function triesKey(app: App, email: string, knownCookie: string | undefined): Tries {
  const address = normalizeEmail(email);
  for (const entry of (knownCookie ?? "").split(",").slice(0, 8)) {
    const [nonce, sig] = entry.split(".");
    if (nonce && sig && safeEqual(sig, mac(app, nonce, address))) return { bucket: `password-user:${address}:${nonce}`, known: true, address };
  }
  return { bucket: `password-user:${address}`, known: false, address };
}

/**
 * Takes one try, or refuses with 429 when none are left. A known browser or app, which skips the per-network-address
 * limit and gets its tries back with each correct password, also has a fixed number of password checks per window that
 * nothing gives back: signing in over and over with its own password can't keep the server hashing or pile up sessions.
 */
export function takeTry(tries: Tries): void {
  // Per address, not per known value: each sign-in hands out a fresh value. Only callers holding a valid value for the
  // address (someone who signed in with its password) count here, so nobody else can spend it.
  if (tries.known) rateLimit(`password-checks:${tries.address}`, KNOWN_CHECKS, WINDOW_MS);
  rateLimit(tries.bucket, TRIES, WINDOW_MS);
}

/**
 * After a correct password: the tries come back, and this browser (or phone app) gets its own for the address. Returns
 * the value to keep; with `res`, it's set as the browser's cookie, while the phone app keeps it and sends it back itself.
 */
export function signedIn(app: App, res: ServerResponse | null, bucket: string, email: string, knownCookie: string | undefined): string {
  clearRateLimit(bucket);
  const address = normalizeEmail(email);
  // One entry per address signed in from this browser, newest first, at most 8.
  const kept = (knownCookie ?? "").split(",").filter((e) => {
    const [nonce, sig] = e.split(".");
    return nonce && sig && !safeEqual(sig, mac(app, nonce, address));
  }).slice(0, 7);
  const nonce = randomToken(12);
  const value = [`${nonce}.${mac(app, nonce, address)}`, ...kept].join(",");
  if (res) setCookie(res, KNOWN_COOKIE, value, { maxAge: KNOWN_DAYS * 86400, secure: app.config.publicOrigin.startsWith("https:"), path: "/api/auth/" });
  return value;
}
