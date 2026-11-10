import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { App, Ctx, Principal } from "./app.ts";
import { HttpError, Router, parseCookies, readBody, sendJson, type Req } from "./http.ts";
import { SESSION_COOKIE, renewSessionCookie, resolvePrincipal } from "./auth/accounts.ts";
import { safeEqual } from "./secrets.ts";
import { StorageFull, markPaused } from "./services/storage.ts";
import { handleMcp } from "./mcp/server.ts";
import { checkDeviceRoute, clientGate, type Gate } from "./connect/gate.ts";
import { handleOAuth, isOAuthPath } from "./oauth/endpoints.ts";
import { serveAppAssociation } from "./connect/app-association.ts";
import { assertStillUsable } from "./services/deletion.ts";
import { webRoute } from "./web-routes.ts";
import { APP_PATH } from "@purss/domain/paths";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
// Feed images and publishers' audio and video files may load from anywhere over https; everything else is same-origin.
export const CSP = "default-src 'self'; img-src 'self' https: data:; media-src https:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
};

export type ExtraRouter = { router: Router<Ctx>; prefix: string };

function errorResponse(app: App, res: ServerResponse, err: unknown): void {
  if (err instanceof StorageFull) {
    try { markPaused(app, err); } catch { /* reporting the original error matters more */ }
  }
  if (res.headersSent) { res.end(); return; }
  if (err instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (err.retryAt !== null) headers["retry-after"] = String(Math.max(0, Math.ceil((err.retryAt - Date.now()) / 1000)));
    sendJson(res, err.status, { error: { ...err.details, code: err.code, message: err.message } }, headers);
    return;
  }
  console.error("[api] unexpected error:", err instanceof Error ? err.stack ?? err.message : err);
  sendJson(res, 500, { error: { code: "internal", message: "Something went wrong on our side. Nothing was changed; please try again." } });
}

async function toReq(raw: IncomingMessage, url: URL, params: Record<string, string>, bodyLimit?: number): Promise<Req> {
  return { raw, method: raw.method ?? "GET", path: url.pathname, query: url.searchParams, params, cookies: parseCookies(raw.headers.cookie), body: await readBody(raw, bodyLimit ?? 1_000_000) };
}

export function publicServer(app: App, routers: Router<Ctx>[], extra: { publicPages?: Router<Ctx>; events: (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => void }): Server {
  return createServer(async (raw, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(raw.url ?? "/", app.config.publicOrigin);
    const method = raw.method ?? "GET";
    try {
      // Assistants (MCP) authenticate with a token only; session cookies never apply there.
      if (url.pathname === "/mcp") { await handleMcp(app, raw, res); return; }
      // The phone apps this PURSS vouches for (passkeys and links): two public files, no cookies.
      if (serveAppAssociation(app, url.pathname, res)) return;
      // OAuth metadata, token and revocation endpoints for assistants (plan/33): no cookies either.
      if (isOAuthPath(url.pathname)) { await handleOAuth(app, raw, res, url.pathname); return; }
      // Connected apps use a device token instead of cookies on /api (connect/gate.ts, plan/24).
      const gate: Gate = url.pathname.startsWith("/api/") ? clientGate(app, raw, res, url.pathname, method) : { kind: "browser" };
      if (gate.kind === "done") return;
      let principal: Principal | null = null;
      if (gate.kind === "device") principal = gate.principal;
      else if (gate.kind === "browser") {
        const cookies = parseCookies(raw.headers.cookie);
        principal = resolvePrincipal(app, cookies[SESSION_COOKIE]);
        if (principal?.renewed) renewSessionCookie(app, res, cookies[SESSION_COOKIE]!);
      }
      const ctx: Ctx = { app, principal };

      if (url.pathname.startsWith("/api/")) {
        if (gate.kind === "browser" && method !== "GET" && method !== "HEAD") {
          // Mutations: same-origin only, plus the per-session CSRF token when signed in.
          const origin = raw.headers.origin;
          if (!origin || origin !== app.config.publicOrigin) throw new HttpError(403, "origin", "This request didn't come from the PURSS page.");
          if (principal && !safeEqual(String(raw.headers["x-purss-csrf"] ?? ""), principal.csrf)) {
            throw new HttpError(403, "csrf", "Your session changed. Please reload the page.");
          }
        }
        if (url.pathname === "/api/events" && method === "GET") {
          checkDeviceRoute(gate, method, url.pathname);
          if (!principal) throw new HttpError(401, "signed_out", "Please sign in again.");
          extra.events(raw, res, ctx);
          return;
        }
        for (const router of routers) {
          const m = router.match(method, url.pathname);
          if (m === "method") throw new HttpError(405, "method", "That isn't supported here.");
          if (!m) continue;
          checkDeviceRoute(gate, method, m.pattern);
          const req = await toReq(raw, url, m.params, m.options.bodyLimit);
          if (gate.kind !== "browser") req.cookies = {};
          // Reading the body can take a while: the account may have been deleted or signed out meanwhile.
          if (principal) assertStillUsable(app, principal);
          const out = await m.handler(req, ctx, res);
          if (!res.headersSent && out !== undefined) sendJson(res, 200, out);
          return;
        }
        throw new HttpError(404, "not_found", "That doesn't exist.");
      }

      // A page has one address. A trailing or doubled slash redirects to it (never off the site: the
      // result always starts with a single "/"); the API and the endpoints above stay strict. The app's
      // home is /app/, with its slash: the service worker's scope covers only addresses under /app/.
      if ((method === "GET" || method === "HEAD") && url.pathname !== "/" && url.pathname !== `${APP_PATH}/` && /\/$|\/\//.test(url.pathname)) {
        const canonical = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
        res.writeHead(301, { location: canonical + url.search, "cache-control": "no-cache" }).end();
        return;
      }
      if (extra.publicPages) {
        const m = extra.publicPages.match(method, url.pathname);
        if (m && m !== "method") {
          const req = await toReq(raw, url, m.params);
          await m.handler(req, ctx, res);
          return;
        }
      }
      serveStatic(app, url, !!principal, res);
    } catch (err) {
      errorResponse(app, res, err);
    }
  });
}

function serveStatic(app: App, url: URL, signedIn: boolean, res: ServerResponse): void {
  const siteRoot = path.resolve(app.config.siteDist);
  const withSite = app.config.mode === "hosted" && existsSync(path.join(siteRoot, "index.html"));
  const route = webRoute(url.pathname, { withSite, signedIn });
  if (route.kind === "redirect") { res.writeHead(302, { location: route.to, "cache-control": "no-store" }).end(); return; }
  if (route.kind === "missing") { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found"); return; }
  const root = path.resolve(route.kind === "app" ? app.config.webDist : siteRoot);
  let decoded: string;
  try { decoded = decodeURIComponent(route.file); } catch { res.writeHead(400).end(); return; }
  let file = path.normalize(path.join(root, decoded));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(400).end(); return; }
  let status = 200;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // The app's own routes all load its page; the website answers an unknown address with its 404 page.
    if (route.kind === "app") file = path.join(root, "index.html");
    else { file = path.join(root, "404.html"); status = 404; }
  }
  if (!existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The web app hasn't been built yet. Run `npm run build`.");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(status, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-security-policy": CSP,
    "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

/** Internal listener: service token required; only worker routes are mounted here. */
export function internalServer(app: App, router: Router<{ app: App }>): Server {
  return createServer(async (raw, res) => {
    try {
      const auth = String(raw.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), app.serviceToken)) throw new HttpError(401, "unauthorized", "Service authentication required.");
      const url = new URL(raw.url ?? "/", "http://internal");
      const m = router.match(raw.method ?? "GET", url.pathname);
      if (!m || m === "method") throw new HttpError(404, "not_found", "Unknown internal route.");
      const req = await toReq(raw, url, m.params, m.options.bodyLimit);
      const out = await m.handler(req, { app }, res);
      if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      errorResponse(app, res, err);
    }
  });
}
