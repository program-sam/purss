import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectClientKind } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { HttpError } from "../http.ts";
import { deviceMayUse, isClientOrigin } from "./clients.ts";
import { DEVICE_TOKEN_PREFIX, resolveDeviceToken } from "./devices.ts";

/*
 * How a request to /api/* is authenticated (plan/24). Decided before cookies are read:
 *
 * - "device": `Authorization: Bearer purss_dev_…`. Cookies are ignored and the Origin/CSRF check
 *   doesn't apply: a bearer token is never attached by the browser on its own, so a page can't
 *   make a request carry it (cross-site request forgery needs an ambient credential).
 * - "open": the endpoints an app calls before it has a token (server info, code exchange, signing in, creating an
 *   account, asking for a password reset email), the interface update it may install and its zip (plan/39), and the phone's
 *   notification fetch. No cookie or device token is
 *   read and nothing there acts for a signed-in person; the fetch checks its own credential, which reaches only that
 *   phone's waiting notifications.
 * - "browser": everything else, exactly as before: session cookie, same-origin and CSRF checks.
 *   Other Authorization headers (HTTP Basic from a reverse proxy, an assistant token) are ignored
 *   here as they always were.
 *
 * CORS: the Capacitor WebView and extension pages are other origins, so they need CORS answers.
 * Only origins from isClientOrigin() get them, only for "device" and "open" requests (and their
 * preflights), and never with Access-Control-Allow-Credentials, so a browser never exposes a
 * cookie-authenticated response cross-origin. A preflight can't show the token (browsers send none),
 * so it is answered for any request that announces an Authorization header; the real request then
 * needs a valid token.
 */

export type Gate =
  | { kind: "done" }
  | { kind: "browser" }
  | { kind: "open" }
  | { kind: "device"; principal: Principal; client: ConnectClientKind; deviceId: string };

/**
 * Endpoints for apps that aren't connected yet, and the phone's notification fetch, which carries its own
 * narrow credential (purss_push_…, checked by the route; plan/37).
 */
const OPEN = new Set(["GET /api/connect/info", "GET /api/app/bundle", "POST /api/connect/token", "POST /api/connect/signin", "POST /api/connect/passkey/options", "POST /api/connect/signup", "POST /api/connect/keep-account",
  "POST /api/signup/start", "POST /api/password-reset", "POST /api/password-reset/confirm", "POST /api/email/verify", "POST /api/push/pending"]);
/** The interface's zip (plan/39): the desktop app's page fetches it itself (plan/42), the phones' updater natively. */
const BUNDLE_FILE = /^\/api\/app\/bundle\/[\w.-]+\.zip$/;
const isOpen = (method: string, path: string): boolean => OPEN.has(`${method} ${path}`) || (method === "GET" && BUNDLE_FILE.test(path));
const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE";
const ALLOW_HEADERS = "authorization, content-type, x-purss-csrf";

const bearerOf = (raw: IncomingMessage): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(raw.headers.authorization ?? ""));
  return m && m[1]!.startsWith(DEVICE_TOKEN_PREFIX) ? m[1]! : null;
};

function allowOrigin(res: ServerResponse, origin: string): void {
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-expose-headers", "retry-after, www-authenticate");
  res.setHeader("vary", "Origin");
}

/** Authenticate a request to /api/*. A "device" answer still needs checkDeviceRoute() once the route is known. */
export function clientGate(app: App, raw: IncomingMessage, res: ServerResponse, path: string, method: string): Gate {
  const origin = typeof raw.headers.origin === "string" ? raw.headers.origin : null;
  const crossOrigin = origin !== null && origin !== app.config.publicOrigin;
  const clientOrigin = crossOrigin && isClientOrigin(origin) ? origin : null;

  if (method === "OPTIONS" && clientOrigin && raw.headers["access-control-request-method"]) {
    const wanted = String(raw.headers["access-control-request-method"]).toUpperCase();
    const announcesToken = String(raw.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").some((h) => h.trim() === "authorization");
    if (announcesToken || isOpen(wanted, path)) {
      res.writeHead(204, {
        "access-control-allow-origin": clientOrigin,
        "access-control-allow-methods": ALLOW_METHODS,
        "access-control-allow-headers": ALLOW_HEADERS,
        "access-control-max-age": "600",
        vary: "Origin",
      }).end();
      return { kind: "done" };
    }
    return { kind: "browser" };
  }

  if (isOpen(method === "HEAD" ? "GET" : method, path)) {
    if (clientOrigin) allowOrigin(res, clientOrigin);
    return { kind: "open" };
  }

  const secret = bearerOf(raw);
  if (!secret) return { kind: "browser" };
  // A token used from some other web page: refuse, as /mcp does (a page has no business holding one).
  if (crossOrigin && !clientOrigin) throw new HttpError(403, "origin", "Requests from other web pages aren't accepted.");
  if (clientOrigin) allowOrigin(res, clientOrigin);
  const caller = resolveDeviceToken(app, secret);
  if (!caller) {
    res.setHeader("www-authenticate", 'Bearer realm="PURSS", error="invalid_token"');
    throw new HttpError(401, "device_signed_out", "This app isn't connected to the PURSS any more. Connect it again.");
  }
  return { kind: "device", principal: caller.principal, client: caller.kind, deviceId: caller.deviceId };
}

/**
 * Refuse a device token on a route its app may not use. Called with the route the router matched (its
 * pattern as registered, e.g. `/api/connect/devices/:id`), never with the raw path, so another
 * spelling of a path can't reach a route the check didn't see.
 */
export function checkDeviceRoute(gate: Gate, method: string, route: string): void {
  if (gate.kind !== "device" || deviceMayUse(gate.client, method, route)) return;
  throw new HttpError(403, "not_for_apps", gate.client === "extension"
    ? "The extension can't do that. Open PURSS in your browser for it."
    : "That can only be done in PURSS in a web browser.");
}
