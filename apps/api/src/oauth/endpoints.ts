import { appUrl } from "@purss/domain";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app.ts";
import { HttpError, SIGNED_OUT_PACE, addressSender, clientAddress, readBody } from "../http.ts";
import { endpointFor } from "../services/assistant.ts";
import { isOurResource } from "./authorize.ts";
import { exchangeCode, refreshTokens, revokeByToken } from "./grants.ts";

/*
 * The OAuth endpoints on the public listener (plan/33), served only when the installation offers
 * OAuth for assistants (config.assistantOAuth); otherwise these paths don't exist.
 *
 * - GET /.well-known/oauth-protected-resource/mcp (and at the root): RFC 9728 metadata for /mcp.
 * - GET /.well-known/oauth-authorization-server: RFC 8414 metadata. The issuer is the public origin.
 * - POST /oauth/token: authorization_code (PKCE S256) and refresh_token grants, public clients only.
 *   Refreshes are limited per grant and per account (grants.ts); over the limit answers 429.
 * - POST /oauth/revoke: RFC 7009.
 * The authorization endpoint, /app/oauth/authorize, is a page of the web app (see authorize.ts).
 *
 * None of these read cookies or answer CORS: assistants call them from their own servers or from
 * programs, not from web pages. Bodies are form-encoded, at most 8 kB.
 */

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";
const PATHS = new Set([PROTECTED_RESOURCE_PATH, "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/revoke"]);
const BODY_LIMIT = 8 * 1024;
/** Scopes are the access levels of personal access tokens. */
export const SCOPES = ["read", "write"] as const;

export const isOAuthPath = (path: string): boolean => PATHS.has(path);

export function resourceMetadataUrl(app: App): string {
  return `${app.config.publicOrigin}${PROTECTED_RESOURCE_PATH}`;
}

export function protectedResourceMetadata(app: App) {
  return {
    resource: endpointFor(app),
    authorization_servers: [app.config.publicOrigin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "PURSS",
  };
}

export function authorizationServerMetadata(app: App) {
  const o = app.config.publicOrigin;
  return {
    issuer: o,
    authorization_endpoint: `${o}${appUrl("/oauth/authorize")}`,
    token_endpoint: `${o}/oauth/token`,
    revocation_endpoint: `${o}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

function send(res: ServerResponse, status: number, body: unknown, cache = "no-store", extra: Record<string, string> = {}): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = { "cache-control": cache, ...extra };
  if (cache === "no-store") headers.pragma = "no-cache";
  if (text) { headers["content-type"] = "application/json; charset=utf-8"; headers["content-length"] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers).end(text);
}

const oauthError = (res: ServerResponse, error: string, description: string, status = 400) => send(res, status, { error, error_description: description });

/** A form-encoded body as single-valued parameters; null when it isn't one or repeats a parameter (RFC 6749 §3.2). */
async function formOf(app: App, raw: IncomingMessage): Promise<Record<string, string> | null> {
  if (!String(raw.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const text = await readBody(raw, BODY_LIMIT, SIGNED_OUT_PACE, addressSender(clientAddress(raw, app.config.trustProxy)));
  const params = new URLSearchParams(typeof text === "string" ? text : "");
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k in out) return null;
    out[k] = v;
  }
  return out;
}

export async function handleOAuth(app: App, raw: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!app.config.assistantOAuth) throw new HttpError(404, "not_found", "That doesn't exist.");
  const method = raw.method === "HEAD" ? "GET" : raw.method;

  if (path.startsWith("/.well-known/")) {
    if (method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return; }
    send(res, 200, path === "/.well-known/oauth-authorization-server" ? authorizationServerMetadata(app) : protectedResourceMetadata(app), "public, max-age=300");
    return;
  }
  if (method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
  let form: Record<string, string> | null;
  try { form = await formOf(app, raw); } catch (err) {
    if (err instanceof HttpError && err.status === 413) return oauthError(res, "invalid_request", "The request is too large.");
    throw err;
  }
  if (!form) return oauthError(res, "invalid_request", "Send the parameters form-encoded (application/x-www-form-urlencoded), each once.");

  if (path === "/oauth/revoke") {
    if (!form.token) return oauthError(res, "invalid_request", "token is required.");
    revokeByToken(app, form.token);
    send(res, 200, undefined);
    return;
  }

  // Public clients only: there is no secret to check, so a client claiming one is refused (RFC 6749 §5.2).
  if (raw.headers.authorization || form.client_secret !== undefined || form.client_assertion !== undefined) {
    return oauthError(res, "invalid_client", "Only public clients (token_endpoint_auth_method \"none\") are supported.", 401);
  }
  if (!form.client_id) return oauthError(res, "invalid_request", "client_id is required.");
  if (form.resource !== undefined && !isOurResource(app, form.resource)) return oauthError(res, "invalid_target", `Tokens are only issued for ${endpointFor(app)}.`);

  if (form.grant_type === "authorization_code") {
    if (!form.code || !form.code_verifier) return oauthError(res, "invalid_request", "code and code_verifier are required.");
    // OAuth 2.1 dropped redirect_uri from this request; OAuth 2.0 clients still send it, and then it must match.
    const out = exchangeCode(app, { code: form.code, codeVerifier: form.code_verifier, clientId: form.client_id, redirectUri: form.redirect_uri ?? null });
    return "error" in out ? oauthError(res, out.error, out.error_description) : send(res, 200, out);
  }
  if (form.grant_type === "refresh_token") {
    if (!form.refresh_token) return oauthError(res, "invalid_request", "refresh_token is required.");
    const out = refreshTokens(app, { refreshToken: form.refresh_token, clientId: form.client_id });
    if (!("error" in out)) return send(res, 200, out);
    if (out.error === "temporarily_unavailable") {
      return send(res, 429, { error: out.error, error_description: out.error_description }, "no-store", { "retry-after": String(out.retryAfter) });
    }
    return oauthError(res, out.error, out.error_description);
  }
  return oauthError(res, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}
