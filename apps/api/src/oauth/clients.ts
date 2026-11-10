import { safeFetch } from "@purss/connectors";
import type { SafeFetchOptions } from "@purss/connectors";
import { rateLimit } from "../http.ts";

/*
 * Who is asking (plan/33): OAuth clients identify themselves with a Client ID Metadata Document
 * (draft-ietf-oauth-client-id-metadata-document-03). The client_id is an https URL; the document
 * there must name the client and list its redirect URIs. Nothing is registered and nothing is stored
 * about a client beyond the grants people approve, so an operator sets nothing up.
 *
 * Fetching the document is a server-side fetch of a URL a stranger chose, so it goes through
 * safeFetch (every address checked, the connection pinned to it, no private or special-use ranges)
 * with tighter limits: 5 kB, 5 seconds, no redirects, 200 only. Only a signed-in person's consent
 * page triggers a fetch, at most FETCHES_PER_WINDOW uncached fetches per account per 10 minutes.
 * Valid documents are cached for their max-age (at most a day, an hour when unstated); failures are
 * never cached (the draft forbids it).
 */

export const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_SECONDS = 3600;
const MAX_CACHE_SECONDS = 86_400;
const MAX_CACHED = 1000;
const FETCHES_PER_WINDOW = 30;
const MAX_REDIRECT_URIS = 20;

export type Client = {
  id: string;
  /** `client_name` from the document, cleaned and never empty. Self-asserted: always show the host too. */
  name: string;
  /** Host of the client_id URL: who actually vouches for the document. */
  host: string;
  redirectUris: string[];
};
export type ClientResult = { ok: true; client: Client } | { ok: false; message: string };

const cache = new Map<string, { client: Client; until: number }>();

let testHooks: Pick<SafeFetchOptions, "testAllowAddress" | "resolver" | "testTlsCa"> = {};
/**
 * TEST ONLY. Lets tests and the hermetic journey serve a metadata document from a local HTTPS
 * server (safeFetch's in-process escape hatches). A function on purpose: no environment variable or
 * configuration can set it. Also empties the cache.
 */
export function setClientFetchForTests(hooks: typeof testHooks): void {
  testHooks = hooks;
  cache.clear();
}

/**
 * Is this a client_id we accept? An https URL with a path other than "/", no credentials or
 * fragment, already in normal form: client ids are compared as plain strings, never normalised, so
 * a URL the parser would rewrite (upper-case host, dot segments, default port) is refused.
 */
export function isClientIdUrl(v: string): boolean {
  if (v.length > 2000) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  return u.protocol === "https:" && u.href === v && !u.username && !u.password && !u.hash && !v.includes("#") && u.pathname !== "/";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Redirect URIs we send codes to: https anywhere, or plain http to this computer's loopback
 * interface (programs on the person's own machine, like Claude Code). Never custom schemes, a
 * fragment or credentials (MCP: redirect URIs must be localhost or https).
 */
export function isAcceptableRedirect(v: string): boolean {
  if (v.length > 2000) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.href !== v || u.hash || v.includes("#") || u.username || u.password) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

export const isLoopbackRedirect = (v: string): boolean => { try { return LOOPBACK.has(new URL(v).hostname); } catch { return false; } };

/**
 * Does the requested redirect URI match one the client lists? Exactly, as a string; except that
 * on the loopback interface any port is accepted (RFC 8252 §7.3; the CIMD draft's one exception),
 * since a local program gets whatever port is free.
 */
export function matchRedirect(registered: readonly string[], requested: string): boolean {
  if (!isAcceptableRedirect(requested)) return false;
  if (registered.includes(requested)) return true;
  const req = new URL(requested);
  if (req.protocol !== "http:" || !LOOPBACK.has(req.hostname)) return false;
  req.port = "";
  return registered.some((r) => {
    const u = new URL(r);
    if (u.protocol !== "http:" || u.hostname !== req.hostname) return false;
    u.port = "";
    return u.href === req.href;
  });
}

/** A display name: control and direction-changing characters removed, spaces collapsed, at most 80 characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 80).trim();
}

/** Methods based on a secret shared with the server, which a metadata document must not name (CIMD §4.1). */
const SHARED_SECRET_METHODS = new Set<unknown>(["client_secret_basic", "client_secret_post", "client_secret_jwt"]);

/**
 * Client authentication as the document declares it (CIMD §5). Only "none" is supported here. A
 * shared-secret method in either property refuses the document, whatever else it lists (§4.1). The
 * plural `token_endpoint_auth_methods_supported` is what counts and must include "none"; the singular
 * `token_endpoint_auth_method` (not recommended) must then be one of the plural's values, and alone
 * must be "none". Neither present means "none". Returns why the document is refused, or null.
 */
function authMethodProblem(single: unknown, plural: unknown): string | null {
  const unsupported = "only clients without a secret or key (token endpoint authentication method \"none\") are supported";
  if (single !== undefined && typeof single !== "string") return "the authentication methods aren't a list of names";
  if (plural !== undefined && (!Array.isArray(plural) || !plural.every((m) => typeof m === "string"))) return "the authentication methods aren't a list of names";
  if ([single, ...(plural ?? [])].some((m) => SHARED_SECRET_METHODS.has(m))) return "they name a client secret method, which a metadata document must not";
  if (plural === undefined) return single === undefined || single === "none" ? null : unsupported;
  if (single !== undefined && !plural.includes(single)) return "their token endpoint authentication methods don't agree";
  return plural.includes("none") ? null : unsupported;
}

/** Validate a fetched document against the URL it came from. */
export function parseDocument(clientId: string, body: string): ClientResult {
  const host = new URL(clientId).host;
  const bad = (why: string): ClientResult => ({ ok: false, message: `The assistant's details at ${host} aren't usable: ${why}.` });
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return bad("they aren't valid JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad("they aren't a JSON object");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return bad("the client_id inside doesn't match their address");
  // A metadata document describes a public client; anything secret-based is refused (CIMD §4.1).
  if ("client_secret" in d || "client_secret_expires_at" in d) return bad("they contain a client secret");
  const auth = authMethodProblem(d.token_endpoint_auth_method, d.token_endpoint_auth_methods_supported);
  if (auth) return bad(auth);
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.includes("authorization_code"))) return bad("they don't use the authorization code flow");
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.includes("code"))) return bad("they don't use the authorization code flow");
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0 || d.redirect_uris.length > MAX_REDIRECT_URIS) return bad("they list no usable return addresses");
  // Return addresses we would never send a code to are left out; one usable address is enough.
  const redirectUris = d.redirect_uris.filter((r): r is string => typeof r === "string" && isAcceptableRedirect(r));
  if (redirectUris.length === 0) return bad("they list no usable return addresses (https, or this computer)");
  // The MCP profile requires a name to show; the page shows the host that vouches for it next to it.
  const name = cleanName(d.client_name);
  if (!name) return bad("they don't name the assistant (client_name)");
  return { ok: true, client: { id: clientId, name, host, redirectUris } };
}

function cacheSeconds(cacheControl: string | undefined): number {
  const cc = (cacheControl ?? "").toLowerCase();
  if (/(^|[,\s])(no-store|no-cache)\b/.test(cc)) return 0;
  const m = /(^|[,\s])max-age=(\d+)/.exec(cc);
  return Math.min(m ? Number(m[2]) : DEFAULT_CACHE_SECONDS, MAX_CACHE_SECONDS);
}

/** The client behind a client_id: cached, or fetched safely now on behalf of `accountId`. */
export async function resolveClient(clientId: string, accountId: string): Promise<ClientResult> {
  if (!isClientIdUrl(clientId)) return { ok: false, message: "The assistant didn't identify itself with a usable address (client_id)." };
  const hit = cache.get(clientId);
  if (hit && hit.until > Date.now()) return { ok: true, client: hit.client };
  cache.delete(clientId);
  rateLimit(`oauth-client-fetch:${accountId}`, FETCHES_PER_WINDOW);
  const host = new URL(clientId).host;
  const r = await safeFetch(clientId, {
    ...testHooks,
    maxBytes: MAX_DOCUMENT_BYTES,
    maxRedirects: 0,
    timeoutMs: FETCH_TIMEOUT_MS,
    phaseTimeoutsMs: { resolveMs: 3000, connectMs: 3000, firstByteMs: 4000, idleMs: 3000 },
    accept: "application/json",
  });
  if (!r.ok) {
    const why = r.reason === "toolarge" ? "they are larger than 5 kB" : r.reason === "timeout" ? "the site took too long to answer" : r.reason === "blocked" ? "that address isn't on the public internet" : r.message.replace(/\.$/, "").toLowerCase();
    return { ok: false, message: `We couldn't read the assistant's details at ${host}: ${why}.` };
  }
  if (r.response.status !== 200) return { ok: false, message: `We couldn't read the assistant's details at ${host}: it answered with status ${r.response.status}.` };
  const out = parseDocument(clientId, r.response.body.toString("utf8"));
  const seconds = cacheSeconds(r.response.headers["cache-control"]);
  if (out.ok && seconds > 0) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(clientId, { client: out.client, until: Date.now() + seconds * 1000 });
  }
  return out;
}
