declare const __PURSS_VERSION__: string | null | undefined;

/** This page's version (plan/40), compiled in by the build; null where it was built without one, and in tests. */
export const PAGE_VERSION: string | null = typeof __PURSS_VERSION__ === "undefined" ? null : __PURSS_VERSION__;

/**
 * The line at the bottom of Settings: this page's version, the installed app's in the apps, and the server's
 * where it differs from the page's. Null when nothing is known.
 */
export function versionLine(o: { page: string | null; app: string | null; server: string | null }): string | null {
  const parts = [o.page ? `Version ${o.page}` : null, o.app ? `app ${o.app}` : null, o.server && o.server !== o.page ? `server ${o.server}` : null].filter(Boolean);
  if (!parts.length) return null;
  const [first, ...rest] = parts as string[];
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(" · ");
}
