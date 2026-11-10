import { appUrl } from "@purss/domain/paths";
import type { ListSearch } from "../nav.ts";
import type { Overlay } from "../state/overlays.tsx";

/** `?dialog=<name>` opens these popups as they are. */
const DIALOGS: Record<string, Overlay> = {
  add: { kind: "add-source" },
  "new-collection": { kind: "new-collection" },
  "customise-home": { kind: "customise-home" },
  settings: { kind: "settings" },
  security: { kind: "settings", tab: "security" },
  apps: { kind: "settings", tab: "apps" },
  notifications: { kind: "settings", tab: "notifications" },
  shortcuts: { kind: "shortcuts" },
  search: { kind: "palette" },
  basket: { kind: "basket-form" },
};

/**
 * The popup a deep link asks for, with what it carries (plan/32). The browser extension and the
 * bookmarklets hand a page over this way:
 * - `?dialog=add&url=…` opens Add source with the link filled in; nothing is looked up until Find.
 * - `?dialog=keep&url=…&title=…` asks to keep the page, in a basket the person picks.
 * - `?dialog=search&q=…` opens search with the words typed in.
 */
export function deepLinkOverlay(s: ListSearch): Overlay | null {
  if (s.dialog === "add" && s.url) return { kind: "add-source", url: s.url };
  if (s.dialog === "keep") return s.url ? { kind: "keep-page", url: s.url, ...(s.title ? { title: s.title } : {}) } : null;
  if (s.dialog === "search" && s.q) return { kind: "palette", query: s.q };
  return s.dialog && Object.hasOwn(DIALOGS, s.dialog) ? DIALOGS[s.dialog]! : null;
}

export type BookmarkletKind = "add" | "keep";

/**
 * A bookmarklet that hands the open page to this PURSS (plan/32). It runs on the page being read,
 * so it only reads that page's address (and title, to keep it) and opens PURSS in a new tab
 * with a deep link; it never calls PURSS's API, so the page's own security policy can't block
 * a request and the page never sees anything of PURSS. `noopener` keeps the two tabs apart.
 * The code avoids "%", which browsers decode in a javascript: address before running it.
 */
export function bookmarklet(origin: string, kind: BookmarkletKind): string {
  const base = JSON.stringify(`${origin}${appUrl("/")}?dialog=${kind}&url=`);
  const title = kind === "keep" ? "+'&title='+encodeURIComponent(document.title.slice(0,300))" : "";
  return `javascript:(function(){window.open(${base}+encodeURIComponent(location.href)${title},'_blank','noopener')})()`;
}
