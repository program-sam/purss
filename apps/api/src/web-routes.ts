import { APP_PATH } from "@purss/domain/paths";

/**
 * What the server answers for an address outside /api and the published pages (/p). The web app
 * lives under /app/. In hosted mode the public website has the rest, and someone already signed in
 * who opens the root goes straight to the app. A self-hosted installation has no website: its root
 * opens the app.
 */
export type WebRoute =
  | { kind: "app"; file: string }
  | { kind: "site"; file: string }
  | { kind: "redirect"; to: string }
  | { kind: "missing" };

export function webRoute(pathname: string, opts: { withSite: boolean; signedIn: boolean }): WebRoute {
  if (pathname === APP_PATH) return { kind: "redirect", to: `${APP_PATH}/` };
  if (pathname.startsWith(`${APP_PATH}/`)) return { kind: "app", file: pathname.slice(APP_PATH.length) };
  if (pathname === "/" && (opts.signedIn || !opts.withSite)) return { kind: "redirect", to: `${APP_PATH}/` };
  if (!opts.withSite) return { kind: "missing" };
  return { kind: "site", file: pathname === "/" ? "/index.html" : pathname };
}
