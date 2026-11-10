import type { z } from "zod";
import type { AssistantAccessLevel, OAuthApproveResult, OAuthRequestSummary, oauthApproveSchema } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { audit, requireRecentAuth } from "../app.ts";
import { HttpError, badRequest, rateLimit } from "../http.ts";
import { CHALLENGE_PATTERN, issueCode } from "../connect/codes.ts";
import { MAX_GRANTS, endpointFor, getAccess, grantCount } from "../services/assistant.ts";
import { isLoopbackRedirect, matchRedirect, resolveClient } from "./clients.ts";
import type { Client } from "./clients.ts";

/*
 * The authorization endpoint (plan/33). GET /app/oauth/authorize is the web app's consent page; it
 * passes the query on as it came to GET /api/assistant/oauth/request, which reads and checks it and
 * answers with the parameters it read, and the signed-in person approves those with
 * POST /api/assistant/oauth/approve (same origin, CSRF header, recent sign-in), which checks them
 * again, issues the one-time code and answers where to send the browser.
 *
 * Order of checks (RFC 6749 §4.1.2.1): until the client and its redirect URI are known good, an
 * error is only shown on the page and nothing is sent anywhere (no open redirect). After that,
 * errors go back to the client's redirect URI. Every response to the client carries `iss`
 * (RFC 9207).
 */

type Checked = { client: Client; redirectUri: string; state: string | null; codeChallenge: string; access: AssistantAccessLevel };
type Check = { ok: true; req: Checked } | { ok: false; message: string; redirectTo: string | null };

/** Add parameters to a redirect URI, keeping any query it already has exactly as it was (RFC 6749 §3.1.2). */
function withParams(uri: string, params: Record<string, string | null>): string {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== null)).toString();
  return `${uri}${uri.includes("?") ? "&" : "?"}${q}`;
}

const back = (app: App, redirectUri: string, state: string | null, params: Record<string, string>) =>
  withParams(redirectUri, { ...params, state, iss: app.config.publicOrigin });

/** RFC 8707 resource as clients send it: the /mcp address, compared after URL normalisation (case of scheme and host, default port, one trailing slash). */
export function isOurResource(app: App, resource: string): boolean {
  let u: URL;
  try { u = new URL(resource); } catch { return false; }
  if (u.search || u.hash || resource.includes("#") || u.username || u.password) return false;
  return `${u.origin}${u.pathname.replace(/(.)\/$/, "$1")}` === endpointFor(app);
}

/** The authorization request's parameters this server reads; anything else in the query is ignored (RFC 6749 §3.1). */
export const AUTHORIZE_PARAMS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"] as const;

/**
 * The protocol parameters of an authorization request, each once, or the first one repeated (RFC 6749
 * §3.1: parameters MUST NOT be included more than once). `resource` too: RFC 8707 allows several,
 * but this server has one resource, so a repeated one is refused like the rest.
 */
export function requestParams(query: URLSearchParams): { ok: true; params: Record<string, string> } | { ok: false; repeated: string } {
  const params: Record<string, string> = {};
  for (const k of AUTHORIZE_PARAMS) {
    const values = query.getAll(k);
    if (values.length > 1) return { ok: false, repeated: k };
    if (values.length === 1) params[k] = values[0]!;
  }
  return { ok: true, params };
}

/** Level asked for: "write" if the scope includes it, otherwise "read". Other values (offline_access, openid…) are ignored. */
export const levelOf = (scope: string | undefined): AssistantAccessLevel => ((scope ?? "").split(" ").includes("write") ? "write" : "read");

export async function checkRequest(app: App, accountId: string, q: Record<string, string | undefined>): Promise<Check> {
  const stop = (message: string): Check => ({ ok: false, message, redirectTo: null });
  if (!app.config.assistantOAuth) return stop("This PURSS doesn't let assistants connect with a sign-in page. Use a personal access token from Settings → Assistants instead.");
  if (!q.client_id) return stop("This sign-in link doesn't say which assistant is asking (no client_id).");
  const client = await resolveClient(q.client_id, accountId);
  if (!client.ok) return stop(client.message);
  const redirectUri = q.redirect_uri;
  if (!redirectUri || !matchRedirect(client.client.redirectUris, redirectUri)) {
    return stop(`This sign-in link would send you to an address that ${client.client.host} doesn't list as its own, so it was stopped.`);
  }
  const state = q.state ?? null;
  const fail = (error: string, description: string, message: string): Check =>
    ({ ok: false, message, redirectTo: back(app, redirectUri, state, { error, error_description: description }) });
  if (state !== null && (state.length > 2000 || !/^[\x20-\x7e]+$/.test(state))) return fail("invalid_request", "state is too long or not printable ASCII", "The assistant's request isn't valid.");
  if (q.response_type !== "code") return fail("unsupported_response_type", "only response_type=code is supported", "The assistant asked for a kind of sign-in this PURSS doesn't offer.");
  if (q.code_challenge_method !== "S256" || !q.code_challenge || !CHALLENGE_PATTERN.test(q.code_challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required", "The assistant's request isn't secure enough (it needs PKCE with S256).");
  }
  if (q.resource !== undefined && !isOurResource(app, q.resource)) {
    return fail("invalid_target", `tokens are only issued for ${endpointFor(app)}`, "The assistant asked for access to something other than this PURSS.");
  }
  return { ok: true, req: { client: client.client, redirectUri, state, codeChallenge: q.code_challenge, access: levelOf(q.scope) } };
}

/**
 * What the consent page shows, from the query exactly as the assistant sent it. A repeated parameter
 * is only explained on the page: which value was meant (even which state to return) is unknown, so
 * nothing is sent back. The summary carries the parameters read, which the page approves with.
 */
export async function describeRequest(app: App, p: Principal, query: URLSearchParams): Promise<OAuthRequestSummary> {
  const read = requestParams(query);
  if (!read.ok) return { kind: "error", message: `This sign-in link gives “${read.repeated}” more than once, so it can't be trusted. Start connecting again from the assistant.`, redirectTo: null };
  const c = await checkRequest(app, p.accountId, read.params);
  if (!c.ok) return { kind: "error", message: c.message, redirectTo: c.redirectTo };
  const { client, redirectUri, state, access } = c.req;
  const { available, enabled } = getAccess(app, p);
  return {
    kind: "ask", request: read.params, clientId: client.id, clientName: client.name, clientHost: client.host, redirectHost: new URL(redirectUri).host,
    loopbackRedirect: isLoopbackRedirect(redirectUri), access, declineUrl: back(app, redirectUri, state, { error: "access_denied" }), available, enabled,
  };
}

/** The person approved: issue the one-time code, bound to the client, redirect URI, PKCE challenge and chosen level. */
export async function approveRequest(app: App, p: Principal, body: z.infer<typeof oauthApproveSchema>): Promise<OAuthApproveResult> {
  const c = await checkRequest(app, p.accountId, body.request);
  if (!c.ok) throw badRequest(c.message, "oauth_request");
  const { client, redirectUri, state, codeChallenge, access } = c.req;
  const status = getAccess(app, p);
  if (!status.available) throw new HttpError(403, "assistant_unavailable", "Your administrator hasn't turned on assistant access for this PURSS.");
  if (!status.enabled) throw new HttpError(403, "assistant_off", "Turn on assistant access first.");
  // A connected assistant holds a long-lived credential: like a new token, approving one needs a recent sign-in.
  requireRecentAuth(p);
  rateLimit(`oauth-approve:${p.accountId}`, 30);
  if (body.access === "write" && access !== "write") throw badRequest("The assistant only asked to read. It can't be allowed more than it asked for.", "oauth_scope");
  if (grantCount(app, p.accountId) >= MAX_GRANTS) throw new HttpError(409, "too_many_grants", `You can connect up to ${MAX_GRANTS} assistants. Disconnect one you no longer use in Settings → Assistants first.`);
  const code = issueCode(app, { accountId: p.accountId, kind: "oauth", clientId: client.id, redirectUri, label: client.name, scope: body.access }, codeChallenge, "redirect");
  audit(app, p.accountId, "assistant_oauth_approve", null, "success", `${body.access} ${client.host}`);
  return { redirectTo: back(app, redirectUri, state, { code }) };
}
