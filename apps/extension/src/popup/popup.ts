import { appUrl } from "@purss/domain/paths";
import "@purss/ui/tokens.css";
import "@purss/ui/primitives.css";
import "../lib/pages.css";
import type { BasketDTO, UrlLookup } from "@purss/domain";
import { deepLink, isWebPage, itemLink } from "../lib/address.ts";
import { signedOut, workspace } from "../lib/api.ts";
import type { Connection } from "../lib/api.ts";
import { KEPT_MARK } from "../lib/badge.ts";
import { ext } from "../lib/browser.ts";
import type { Tab } from "../lib/browser.ts";
import { followColorScheme, h, shortDate, show } from "../lib/dom.ts";
import { followLine, initialBasket, keepButton, keptLine, sourceOffers, statusLine, textHint } from "../lib/popup-model.ts";
import { pageInfoOf, readableIn } from "../lib/tab-scripts.ts";
import { forgetConnection, getConnection, getLastBasket, getSettings, setBaskets, setLastBasket, setSettings } from "../lib/store.ts";

/*
 * The toolbar popup for the page that is open (plan/32): whether it is already kept and where, Keep
 * with a basket picker (and, on request, the page's text as the browser shows it), and "Add as a
 * source" when the page advertises a feed or is a YouTube channel or video, which hands over to the
 * PURSS's guided Add source. Opening the popup is what lets the extension read this one page.
 */

const api = ext();
const app = document.getElementById("app")!;
document.body.classList.add("popup");
followColorScheme();

const spinner = (text: string) => h("p", { class: "state" }, h("span", { class: "spin", "aria-hidden": "true" }), text);

async function openTab(url: string): Promise<void> {
  await api.tabs.create({ url });
  window.close();
}

function notConnected(message?: string): void {
  show(app, h("div", { class: "pg" },
    h("h1", {}, "PURSS"),
    message ? h("p", { class: "error", role: "alert" }, message) : null,
    h("p", {}, "Connect this extension to your PURSS to keep pages, follow sites and search from here."),
    h("button", { class: "btn primary", type: "button", id: "connect", onclick: () => void api.runtime.openOptionsPage().then(() => window.close()) }, "Connect…"),
  ));
}

function footer(conn: Connection) {
  return h("div", { class: "foot" },
    h("button", { type: "button", class: "link", onclick: () => void openTab(`${conn.origin}${appUrl("/")}`) }, "Open your PURSS"),
    h("button", { type: "button", class: "link", onclick: () => void api.runtime.openOptionsPage().then(() => window.close()) }, "Options"));
}

async function main(): Promise<void> {
  const conn = await getConnection();
  if (!conn) return notConnected();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isWebPage(tab.url, conn.origin)) {
    show(app, h("div", { class: "pg" }, h("h1", {}, "Nothing to keep here"), h("p", { class: "fine" }, "Open a web page to keep it or follow its site. Browser pages and the PURSS itself can't be kept."), footer(conn)));
    return;
  }
  await showPage(conn, tab as Tab & { id: number; url: string });
}

async function showPage(conn: Connection, tab: Tab & { id: number; url: string }): Promise<void> {
  const ws = workspace(conn);
  const settings = await getSettings();
  const status = h("div", { id: "status" }, spinner("Checking your PURSS…"));
  const result = h("p", { class: "result", id: "result", role: "status" });
  const basketSelect = h("select", { class: "in", id: "basket", "aria-label": "Basket" });
  const keepText = h("input", { type: "checkbox", id: "keep-text", ...(settings.keepText ? { checked: true } : {}) });
  const textNote = h("span", { class: "fine", id: "keep-text-hint" });
  const keepBtn = h("button", { class: "btn primary", type: "button", id: "keep", disabled: true }, "Keep");
  const offers = h("div", { class: "offers", id: "offers" });
  let lookup: UrlLookup | null = null;
  let baskets: BasketDTO[] = [];

  show(app, h("div", { class: "pg" },
    h("div", {}, h("div", { class: "page-t", id: "page-title" }, tab.title || tab.url), h("div", { class: "host" }, new URL(tab.url).host)),
    status,
    h("div", { class: "card" },
      h("h2", {}, "Keep this page"),
      h("div", { class: "hrow" }, h("div", { class: "fill" }, basketSelect), keepBtn),
      conn.browserCapture ? h("label", { class: "check" }, keepText, h("span", {}, "Also keep its text as you see it", h("br"), textNote)) : null,
      result),
    offers,
    footer(conn)));

  const chosen = () => baskets.find((b) => b.id === basketSelect.value) ?? null;
  const refreshButton = () => {
    const b = keepButton(lookup, chosen(), conn.browserCapture && keepText.checked);
    keepBtn.textContent = b.label;
    keepBtn.disabled = !b.enabled;
  };
  basketSelect.addEventListener("change", refreshButton);
  keepText.addEventListener("change", () => { refreshButton(); void setSettings({ keepText: keepText.checked }); });

  const signedOutNow = async (err: unknown) => {
    if (!signedOut(err)) return false;
    await forgetConnection();
    notConnected(err instanceof Error ? err.message : undefined);
    return true;
  };

  const renderStatus = () => {
    if (!lookup) return;
    const s = statusLine(lookup);
    const follow = followLine(lookup);
    const item = lookup.item;
    show(status,
      h("p", { class: `status${s.kept ? " kept" : ""}` }, s.kept ? `${KEPT_MARK} ` : "", s.text),
      follow ? h("p", { class: "fine" }, follow) : null,
      item ? h("button", { type: "button", class: "link", id: "open-item", onclick: () => void openTab(itemLink(conn.origin, item.id, item.baskets[0]?.id ?? null)) }, "Open it in your PURSS") : null);
    textNote.textContent = textHint(lookup, shortDate);
    void api.action.setBadgeText({ tabId: tab.id, text: s.kept ? KEPT_MARK : "" }).catch(() => undefined);
    void api.runtime.sendMessage({ type: "looked-up", url: tab.url, kept: s.kept }).catch(() => undefined);
    refreshButton();
  };

  const lookUp = async () => {
    lookup = await ws.lookup(tab.url);
    renderStatus();
  };

  // What the PURSS has, its baskets, and what the page offers to follow, side by side.
  const [looked, basketList, info] = await Promise.allSettled([lookUp(), ws.baskets(), pageInfoOf(tab.id)]);
  for (const r of [looked, basketList]) if (r.status === "rejected" && await signedOutNow(r.reason)) return;
  if (looked.status === "rejected") show(status, h("p", { class: "error", role: "alert" }, looked.reason instanceof Error ? looked.reason.message : "Couldn't check your PURSS."));
  if (basketList.status === "fulfilled") {
    baskets = basketList.value;
    void setBaskets(baskets);
    if (!baskets.length) {
      show(basketSelect.parentElement!.parentElement!, h("p", { class: "fine" }, "You don't have a basket yet. ",
        h("button", { type: "button", class: "link", onclick: () => void openTab(`${conn.origin}${appUrl("/")}?dialog=basket`) }, "Create one in your PURSS"), "."));
    }
    const start = initialBasket(baskets, await getLastBasket());
    show(basketSelect, ...baskets.map((b) => h("option", { value: b.id, ...(b.id === start ? { selected: true } : {}) }, b.name)));
    refreshButton();
  }

  const sources = sourceOffers(info.status === "fulfilled" ? info.value : null);
  if (sources.length) {
    const [first, ...rest] = sources;
    const handOff = (url: string) => {
      const link = deepLink(conn.origin, { kind: "add", url });
      if (link) void openTab(link);
    };
    show(offers,
      h("h2", {}, "Add as a source"),
      h("button", { class: "btn", type: "button", id: "add-source", onclick: () => handOff(first!.url) }, first!.label),
      ...rest.map((o) => h("button", { class: "btn", type: "button", onclick: () => handOff(o.url) }, o.label)),
      h("p", { class: "fine" }, "Opens Add source in your PURSS, where you check what was found and choose a collection."));
  }

  keepBtn.addEventListener("click", () => void (async () => {
    const basket = chosen();
    if (!basket) return;
    keepBtn.disabled = true;
    const wantText = conn.browserCapture && keepText.checked;
    show(result, spinner(wantText ? "Reading the page and keeping it…" : "Keeping…"));
    const title = tab.title?.trim().slice(0, 300) || undefined;
    try {
      let line: string;
      if (wantText) {
        const readable = await readableIn(tab.id);
        if (readable.ok) {
          line = keptLine(await ws.keepWithText({ url: tab.url, basketId: basket.id, html: readable.html, ...(title ? { title } : {}) }), basket.name);
        } else {
          line = keptLine(await ws.keep({ url: tab.url, basketId: basket.id, ...(title ? { title } : {}) }), basket.name, readable.reason);
        }
      } else {
        line = keptLine(await ws.keep({ url: tab.url, basketId: basket.id, ...(title ? { title } : {}) }), basket.name);
      }
      await setLastBasket(basket.id);
      show(result, line);
      await lookUp().catch(() => undefined);
    } catch (err) {
      if (await signedOutNow(err)) return;
      show(result, h("span", { class: "error", role: "alert" }, err instanceof Error ? err.message : "Couldn't keep this page."));
      refreshButton();
    }
  })());
}

void main().catch((err) => show(app, h("div", { class: "pg" }, h("p", { class: "error", role: "alert" }, err instanceof Error ? err.message : "Something went wrong."))));
