import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * The signature behind the engine's addresses at the egress listeners (the bridge router's `/b/…` and the feed gateway's
 * `/t/…`): an address is its own credential, made by the worker and the API and checked by the listener, with a key only
 * those hold. One place makes the signature and compares it, so an address and its check cannot disagree.
 */

/** HMAC-SHA-256 of what an address names, base64url. */
export function signRoute(secret: string, named: string): string {
  return createHmac("sha256", secret).update(named).digest("base64url");
}

/** Whether `given` is the signature of `named` under `secret`, compared in constant time. */
export function routeSignatureMatches(secret: string, named: string, given: string): boolean {
  const want = Buffer.from(signRoute(secret, named));
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}
