import { deepLink, isWebPage } from "./lib/address.ts";
import { signedOut, workspace } from "./lib/api.ts";
import { BADGE_DELAY_MS, Debouncer, KEPT_MARK, KeptCache, mayLookUp } from "./lib/badge.ts";
import { ext } from "./lib/browser.ts";
import type { Tab } from "./lib/browser.ts";
import { menuAction, menuItems } from "./lib/menus.ts";
import { forgetConnection, getBaskets, getConnection, getSettings, setBaskets } from "./lib/store.ts";

/*
 * The extension's background: the right-click menu, address-bar search, and the toolbar mark for kept
 * pages. Listeners are registered at the top level, as Manifest V3 requires (the background stops when
 * idle and is started again for each event).
 */

const api = ext();
const kept = new KeptCache();
const settle = new Debouncer<number>(BADGE_DELAY_MS);
const TITLE = "PURSS";

async function mark(tabId: number | undefined, state: "kept" | "none" | "error", title?: string): Promise<void> {
  if (tabId === undefined) return;
  await api.action.setBadgeText({ tabId, text: state === "kept" ? KEPT_MARK : state === "error" ? "!" : "" }).catch(() => undefined);
  await api.action.setTitle({ tabId, title: title ?? (state === "kept" ? "Kept in your PURSS" : TITLE) }).catch(() => undefined);
}

async function rebuildMenus(): Promise<void> {
  if (!api.contextMenus) return; // iOS Safari has no context menus
  await api.contextMenus.removeAll();
  for (const item of menuItems(!!(await getConnection()), await getBaskets())) api.contextMenus.create(item);
}

/** Refresh the basket names the menu shows. A token that stopped working disconnects the extension. */
async function refreshBaskets(): Promise<void> {
  const conn = await getConnection();
  if (!conn) return;
  try {
    await setBaskets(await workspace(conn).baskets());
  } catch (err) {
    if (signedOut(err)) await forgetConnection();
  }
}

async function start(): Promise<void> {
  await api.action.setBadgeBackgroundColor({ color: "#1260ba" }).catch(() => undefined);
  await rebuildMenus();
  await refreshBaskets();
}
api.runtime.onInstalled.addListener(() => void start());
api.runtime.onStartup.addListener(() => void start());

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.connection || changes.baskets) void rebuildMenus();
  if (changes.connection) kept.clear();
});

// ---------- right-click menu ----------
api.contextMenus?.onClicked.addListener((info, tab) => void (async () => {
  const action = menuAction(info.menuItemId);
  if (!action) return;
  if (action.kind === "connect") { await api.runtime.openOptionsPage(); return; }
  const conn = await getConnection();
  if (!conn) { await api.runtime.openOptionsPage(); return; }
  const url = action.what === "link" ? info.linkUrl : info.pageUrl ?? tab?.url;
  if (!isWebPage(url, conn.origin)) { await mark(tab?.id, "error", "Only web pages can be kept."); return; }
  const basket = (await getBaskets()).find((b) => b.id === action.basketId);
  // Firefox tells the link's text; Chrome doesn't, and the PURSS then names the link by its address.
  const title = (action.what === "page" ? tab?.title : info.linkText)?.trim().slice(0, 300) || undefined;
  try {
    await workspace(conn).keep({ url, basketId: action.basketId, ...(title ? { title } : {}) });
    if (action.what === "page") kept.set(url, true, Date.now());
    await mark(tab?.id, action.what === "page" ? "kept" : "none", `Kept ${action.what === "page" ? "this page" : "the link"} in ${basket?.name ?? "your basket"}`);
  } catch (err) {
    if (signedOut(err)) await forgetConnection();
    await mark(tab?.id, "error", err instanceof Error ? err.message : "Couldn't keep it.");
    if (err instanceof Error && /basket/i.test(err.message)) await refreshBaskets();
  }
})());

// ---------- address bar: "purss <words>" searches the PURSS ----------
api.omnibox?.setDefaultSuggestion({ description: "Search your PURSS for: %s" });
api.omnibox?.onInputEntered.addListener((text, disposition) => void (async () => {
  const conn = await getConnection();
  if (!conn) { await api.runtime.openOptionsPage(); return; }
  const url = deepLink(conn.origin, { kind: "search", q: text });
  if (!url) return;
  if (disposition === "currentTab") await api.tabs.update({ url });
  else await api.tabs.create({ url, active: disposition !== "newBackgroundTab" });
})());

// ---------- the popup tells what it learnt, so the automatic mark agrees with it ----------
api.runtime.onMessage.addListener((message) => {
  const m = message as { type?: string; url?: string; kept?: boolean };
  if (m.type === "looked-up" && typeof m.url === "string") kept.set(m.url, m.kept === true, Date.now());
});

// ---------- the automatic mark (a setting, off unless turned on; see lib/badge.ts) ----------
async function markIfKept(tabId: number, tab: Tab): Promise<void> {
  if (!(await getSettings()).autoBadge || !(await api.permissions.contains({ permissions: ["tabs"] }))) return;
  const conn = await getConnection();
  if (!mayLookUp(tab, conn?.origin ?? null) || !conn || !tab.url) return;
  const url = tab.url;
  const known = kept.get(url, Date.now());
  if (known !== undefined) { await mark(tabId, known ? "kept" : "none"); return; }
  settle.run(tabId, () => void (async () => {
    try {
      const r = await workspace(conn).lookup(url);
      const isKept = !!r.item?.baskets.length;
      kept.set(url, isKept, Date.now());
      // Only if the tab still shows that page.
      if ((await api.tabs.get(tabId).catch(() => null))?.url === url) await mark(tabId, isKept ? "kept" : "none");
    } catch (err) {
      if (signedOut(err)) await forgetConnection();
    }
  })());
}
api.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.status === "complete") void markIfKept(tabId, tab); });
api.tabs.onActivated.addListener(({ tabId }) => void api.tabs.get(tabId).then((tab) => markIfKept(tabId, tab), () => undefined));
