import { createBrowserHistory } from "@tanstack/react-router";

/**
 * Where this build of the app is served from: /app/ on a PURSS (the website has the root), and
 * / in the phone apps, which build it with PURSS_WEB_BASE=/ (vite.config.ts). Links within the app use
 * this; links into a PURSS from elsewhere use APP_PATH from @purss/domain, the server's address.
 */
export const APP_BASE: string = import.meta.env?.BASE_URL ?? "/app/";

/** APP_BASE without its trailing slash, or "/" for a build at the root. */
export const ROUTER_BASE = APP_BASE === "/" ? "/" : APP_BASE.replace(/\/$/, "");

/** A path inside the app, such as "/signin", as a link for this build. */
export const inApp = (path: string): string => (ROUTER_BASE === "/" ? path : `${ROUTER_BASE}${path}`);

/** The path inside the app for a path in the address bar. */
export function withinApp(path: string): string {
  if (ROUTER_BASE === "/") return path;
  return path === ROUTER_BASE || path.startsWith(`${ROUTER_BASE}/`) ? path.slice(ROUTER_BASE.length) || "/" : path;
}

/**
 * The router's history: the address bar has the base (/app/c/x), the app sees paths without it (/c/x).
 * Done here rather than with the router's basepath, which writes the address back on every load from
 * what it parsed: that would fold a repeated parameter that the OAuth and connect pages must refuse.
 */
export function appHistory() {
  if (ROUTER_BASE === "/") return createBrowserHistory();
  return createBrowserHistory({
    parseLocation: () => {
      const pathname = withinApp(window.location.pathname);
      const { search, hash } = window.location;
      return { href: `${pathname}${search}${hash}`, pathname, search, hash, state: window.history.state };
    },
    createHref: inApp,
  });
}
