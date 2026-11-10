import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app.ts";
import { HttpError, rateLimit, readBody } from "../http.ts";
import { resolveToken } from "../services/assistant.ts";
import type { AssistantCaller } from "../services/assistant.ts";
import { ACCESS_TOKEN_PREFIX, resolveAccessToken } from "../oauth/grants.ts";
import { resourceMetadataUrl } from "../oauth/endpoints.ts";
import { assertStillUsable } from "../services/deletion.ts";
import { SERVER_INSTRUCTIONS, callTool, describeTools } from "./tools.ts";

/*
 * The MCP endpoint (Streamable HTTP, plan/23): one POST /mcp, JSON answers, no sessions.
 *
 * It speaks both eras of the protocol on the same address:
 * - modern (2026-07-28): every request names its version in params._meta and the
 *   MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, which must match the body;
 *   server/discover, tools/list, tools/call; results carry resultType and serverInfo.
 * - legacy (2025-03-26 to 2025-11-25): an initialize handshake, then ping, tools/list and
 *   tools/call. No session id is minted, so every request stands alone.
 *
 * Authentication is a personal access token, or where the installation offers OAuth an OAuth
 * access token (plan/33), in the Authorization header; both resolve to the same kind of caller.
 * Cookies are ignored, so a browser page can't act for the person. A request from a browser origin
 * other than the PURSS's own is refused (DNS rebinding). With OAuth on, a 401 points the
 * assistant at the protected resource metadata (RFC 9728) to start signing in.
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const SUPPORTED = [MODERN_VERSION, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: "purss", title: "PURSS", version: "1" };
const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;
const CALLS_PER_MINUTE = 120;
const BODY_LIMIT = 256_000;

type Message = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

const rpcError = (id: Message["id"] | null, code: number, message: string, data?: unknown) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

function send(res: ServerResponse, a: Answer): void {
  const headers: Record<string, string> = { "cache-control": "no-store", ...a.headers };
  if (a.body === undefined) { res.writeHead(a.status, headers).end(); return; }
  const body = JSON.stringify(a.body);
  res.writeHead(a.status, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)) }).end(body);
}

/** Header values may be sent as =?base64?…?= when they aren't plain ASCII. */
export function decodeHeaderValue(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : v;
}

function header(raw: IncomingMessage, name: string): string | undefined {
  const v = raw.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export async function handleMcp(app: App, raw: IncomingMessage, res: ServerResponse): Promise<void> {
  send(res, await answer(app, raw));
}

async function answer(app: App, raw: IncomingMessage): Promise<Answer> {
  if (raw.method !== "POST") return { status: 405, headers: { allow: "POST" } };
  const origin = header(raw, "origin");
  if (origin && origin !== app.config.publicOrigin) return { status: 403, body: rpcError(null, -32600, "Requests from other web pages aren't accepted.") };

  const caller = resolveCaller(app, header(raw, "authorization"));
  if ("error" in caller) {
    if (caller.error === "off") return { status: 403, body: rpcError(null, -32600, "Assistant access is turned off for this account or PURSS. Turn it on in the PURSS's Settings → Assistants.") };
    const oauth = app.config.assistantOAuth ? `, resource_metadata="${resourceMetadataUrl(app)}", scope="read write"` : "";
    return {
      status: 401,
      headers: { "www-authenticate": `Bearer realm="PURSS"${caller.error === "invalid" ? ', error="invalid_token"' : ""}${oauth}` },
      body: rpcError(null, -32600, caller.error === "missing" ? "This needs a personal access token from Settings → Assistants." : "That token isn't valid any more. Create a new one in Settings → Assistants."),
    };
  }
  try { rateLimit(`mcp:${caller.tokenId}`, CALLS_PER_MINUTE, 60_000); } catch {
    return { status: 429, headers: { "retry-after": "60" }, body: rpcError(null, -32000, "Too many requests. Wait a minute and try again.") };
  }

  let msg: unknown;
  try {
    msg = await readBody(raw, BODY_LIMIT);
    if (typeof msg === "string") msg = JSON.parse(msg);
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) return { status: 413, body: rpcError(null, -32600, "That request is too large.") };
    return { status: 400, body: rpcError(null, -32700, "The body isn't valid JSON.") };
  }
  // The token may have been revoked, or the account deleted, while the body arrived.
  try { assertStillUsable(app, caller.principal); } catch {
    return { status: 401, headers: { "www-authenticate": 'Bearer realm="PURSS", error="invalid_token"' }, body: rpcError(null, -32600, "That token isn't valid any more. Create a new one in Settings → Assistants.") };
  }
  if (!isMessage(msg)) return { status: 400, body: rpcError(null, -32600, "Send one JSON-RPC 2.0 request or notification per POST.") };
  // Notifications (no id), e.g. notifications/initialized, need no answer.
  if (msg.id === undefined) return { status: 202 };

  const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
  const modernVersion = meta[META.protocolVersion];
  return typeof modernVersion === "string"
    ? modern(app, raw, msg, modernVersion, caller)
    : legacy(app, raw, msg, caller);
}

/** A personal access token or an OAuth access token: the same kind of caller either way. */
function resolveCaller(app: App, authorization: string | undefined): AssistantCaller | { error: "missing" | "invalid" | "off" } {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return m && m[1]!.startsWith(ACCESS_TOKEN_PREFIX) ? resolveAccessToken(app, m[1]!) : resolveToken(app, authorization);
}

function isMessage(v: unknown): v is Message {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && (m.params === undefined || (typeof m.params === "object" && m.params !== null && !Array.isArray(m.params)))
    && (m.id === undefined || m.id === null || typeof m.id === "string" || typeof m.id === "number");
}

type Caller = AssistantCaller;

async function modern(app: App, raw: IncomingMessage, msg: Message, version: string, caller: Caller): Promise<Answer> {
  if (version !== MODERN_VERSION) {
    return { status: 400, body: rpcError(msg.id, -32022, "Unsupported protocol version", { supported: SUPPORTED, requested: version }) };
  }
  const mismatch = (what: string) => ({ status: 400, body: rpcError(msg.id, -32020, `Header mismatch: ${what}`) });
  if (header(raw, "mcp-protocol-version") !== version) return mismatch("MCP-Protocol-Version must match the request's protocol version.");
  if (header(raw, "mcp-method") !== msg.method) return mismatch("Mcp-Method must match the request's method.");
  if (msg.method === "tools/call" && decodeHeaderValue(header(raw, "mcp-name")) !== msg.params?.name) return mismatch("Mcp-Name must match the tool's name.");

  const done = (result: Record<string, unknown>) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", ...result, _meta: { [META.serverInfo]: SERVER_INFO } } } });
  switch (msg.method) {
    case "server/discover":
      return done({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "private" });
    case "tools/list":
      return done({ tools: describeTools(caller.access), ttlMs: 3_600_000, cacheScope: "private" });
    case "tools/call": {
      const r = await toolResult(app, msg, caller);
      return "error" in r ? { status: 200, body: r } : done(r.result);
    }
    default:
      return { status: 404, body: rpcError(msg.id, -32601, `Method not found: ${msg.method}`) };
  }
}

async function legacy(app: App, raw: IncomingMessage, msg: Message, caller: Caller): Promise<Answer> {
  const ok = (result: Record<string, unknown>) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, result } });
  if (msg.method === "initialize") {
    const requested = msg.params?.protocolVersion;
    const version = LEGACY_VERSIONS.find((v) => v === requested) ?? LEGACY_VERSIONS[0];
    return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
  }
  const headerVersion = header(raw, "mcp-protocol-version");
  if (headerVersion !== undefined && !(LEGACY_VERSIONS as readonly string[]).includes(headerVersion)) {
    return { status: 400, body: rpcError(msg.id, -32600, `Unsupported protocol version ${headerVersion}. Supported: ${SUPPORTED.join(", ")}.`) };
  }
  switch (msg.method) {
    case "ping": return ok({});
    case "tools/list": return ok({ tools: describeTools(caller.access) });
    case "tools/call": {
      const r = await toolResult(app, msg, caller);
      return "error" in r ? { status: 200, body: r } : ok(r.result);
    }
    default: return { status: 200, body: rpcError(msg.id, -32601, `Method not found: ${msg.method}`) };
  }
}

async function toolResult(app: App, msg: Message, caller: Caller): Promise<{ result: Record<string, unknown> } | ReturnType<typeof rpcError>> {
  const name = msg.params?.name;
  if (typeof name !== "string") return rpcError(msg.id, -32602, "tools/call needs a tool name.");
  const out = await callTool(app, caller.principal, caller.access, caller.tokenId, name, msg.params?.arguments);
  if (!out) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
  if (!out.ok) return { result: { content: [{ type: "text", text: out.message }], isError: true } };
  return { result: { content: [{ type: "text", text: JSON.stringify(out.value) }], structuredContent: out.value, isError: false } };
}
