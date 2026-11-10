import { APP_PATH } from "@purss/domain/paths";
import { NO_COPY_HEADER } from "./protocol.ts";

/**
 * Which requests the worker touches. Everything not listed here goes straight to the network:
 * live updates, sign-in, administration, downloads, public pages, the website and every change a person makes.
 */
export type RouteClass =
  /** A page load: network first, the saved app shell when there is no network. */
  | "navigation"
  /** A built file or the manifest and icons: from the app shell cache. */
  | "static"
  /** A read of the person's own data: network first, this device's copy when there is no network. */
  | "api"
  | "bypass";

export type RequestInfo = {
  method: string;
  url: string;
  mode: string;
  /** Header names are matched in lower case. */
  headers?: { get(name: string): string | null };
};

/**
 * The reads worth keeping a copy of. An allow-list on purpose: account security, administration,
 * sign-in, exports and search are never kept on the device.
 */
const API_COPIES: readonly RegExp[] = [
  /^\/api\/session$/,
  /^\/api\/bootstrap$/,
  /^\/api\/preferences$/,
  /^\/api\/notifications$/,
  /^\/api\/reminders$/,
  // The days set with Remind me: Home's Coming up, and the reminder on one item.
  /^\/api\/item-reminders$/,
  /^\/api\/items\/[^/]+\/reminder$/,
  /^\/api\/items$/,
  /^\/api\/home$/,
  // An item's details; not the address lookup, whose answer goes stale as soon as something is kept, nor "Select all"'s ids.
  /^\/api\/items\/(?!(?:lookup|ids)$)[^/]+$/,
  /^\/api\/items\/[^/]+\/annotations$/,
  /^\/api\/stats\/(?:collections|sources)\/[^/]+$/,
];

export function isCopyableApi(pathname: string): boolean {
  return API_COPIES.some((re) => re.test(pathname));
}

/** Built files live under /app/assets/; the manifest and icons are listed in the build's precache. Only the app's own pages are page loads. */
export function classifyRequest(req: RequestInfo, origin: string, precached: ReadonlySet<string>): RouteClass {
  if (req.method !== "GET") return "bypass";
  let url: URL;
  try { url = new URL(req.url); } catch { return "bypass"; }
  if (url.origin !== origin) return "bypass";
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) {
    if (req.headers?.get(NO_COPY_HEADER)) return "bypass";
    return isCopyableApi(path) ? "api" : "bypass";
  }
  if (path === "/p" || path.startsWith("/p/")) return "bypass";
  if (path === `${APP_PATH}/sw.js`) return "bypass";
  if (path.startsWith(`${APP_PATH}/assets/`) || (precached.has(path) && path !== `${APP_PATH}/index.html`)) return "static";
  if (req.mode === "navigate" && (path === APP_PATH || path.startsWith(`${APP_PATH}/`))) return "navigation";
  return "bypass";
}

export type Copy = { url: string; savedAt: number };

/** URLs to drop so that no more than `max` copies remain: the oldest first, never one `keep` protects. */
export function copiesToEvict(copies: readonly Copy[], max: number, keep: (url: string) => boolean): string[] {
  const excess = copies.length - max;
  if (excess <= 0) return [];
  return [...copies]
    .filter((c) => !keep(c.url))
    .sort((a, b) => a.savedAt - b.savedAt)
    .slice(0, excess)
    .map((c) => c.url);
}
