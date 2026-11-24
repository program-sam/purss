/*
 * What the app side of connecting an app to a PURSS must get right, once for the apps that connect: the mobile and desktop
 * apps and the browser extension. The PURSS issues a one-time code bound to a PKCE challenge (RFC 7636, S256), and its
 * answer comes back to the app's return address with the `state` the app sent and `iss`, the PURSS's own origin (RFC 9207).
 * An answer is taken only when both are the ones this attempt expects, so a code from another attempt or another PURSS is
 * never exchanged. Web APIs only (no Node, no zod): the web app and the extension import it as `@purss/domain/connect-protocol`.
 */

const base64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** `bytes` random bytes as base64url: 32 make a PKCE verifier of 43 characters (RFC 7636 section 4.1), 16 a `state`. `random` is for tests. */
export function randomToken(bytes: number, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return base64url(random(bytes));
}

/** BASE64URL(SHA-256(verifier)), the S256 challenge the PURSS checks the verifier against. */
export async function s256Challenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** What an answer to the app's request says, read in this order: whose it is, then what it says. */
export type ConnectAnswer =
  | { kind: "code"; code: string }
  | { kind: "declined" }
  /** Nothing to exchange, from the right PURSS and attempt. */
  | { kind: "no-code" }
  /** Its `state` is not the one this attempt sent. */
  | { kind: "other-attempt" }
  /** Its `iss` names another PURSS, or none. */
  | { kind: "other-purss" };

export type ExpectedAnswer = { state: string; issuer: string };

function whose(q: URLSearchParams, expected: ExpectedAnswer): "other-attempt" | "other-purss" | null {
  if (q.get("state") !== expected.state) return "other-attempt";
  return q.get("iss") === expected.issuer ? null : "other-purss";
}

/** The answer to a connection request: the PURSS's `code`, or `error=access_denied` when the person declined. */
export function readConnectAnswer(q: URLSearchParams, expected: ExpectedAnswer): ConnectAnswer {
  const other = whose(q, expected);
  if (other) return { kind: other };
  if (q.get("error") === "access_denied") return { kind: "declined" };
  const code = q.get("code");
  return code ? { kind: "code", code } : { kind: "no-code" };
}

/** The code in the answer to a request to link a sign-in provider (`link_code`) or confirm it's the person (`confirm_code`), when it is this attempt's from this PURSS; else null. */
export function readProviderCode(q: URLSearchParams, expected: ExpectedAnswer, param: "link_code" | "confirm_code"): string | null {
  const code = q.get(param);
  return code && !whose(q, expected) ? code : null;
}
