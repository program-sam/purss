import { APP_PATH } from "@purss/domain/paths";

/**
 * What the server answers for an address outside /api and the published pages (/p). The web app
 * lives under /app/. In hosted mode the public website has the rest, including the root, also for
 * someone signed in (its header then offers Go to your PURSS, see `markSignedIn`). A self-hosted
 * installation has no website: its root opens the app.
 */
export type WebRoute =
  | { kind: "app"; file: string }
  | { kind: "site"; file: string }
  | { kind: "redirect"; to: string }
  | { kind: "missing" };

export function webRoute(pathname: string, opts: { withSite: boolean }): WebRoute {
  if (pathname === APP_PATH) return { kind: "redirect", to: `${APP_PATH}/` };
  if (pathname.startsWith(`${APP_PATH}/`)) return { kind: "app", file: pathname.slice(APP_PATH.length) };
  if (pathname === "/" && !opts.withSite) return { kind: "redirect", to: `${APP_PATH}/` };
  if (!opts.withSite) return { kind: "missing" };
  return { kind: "site", file: pathname === "/" ? "/index.html" : pathname };
}

/** Marks a website page as seen by someone signed in, so its header shows Go to your PURSS instead of sign-up. */
export function markSignedIn(html: string): string {
  return html.replace(/<html(?=[\s>])/i, "<html data-session");
}
