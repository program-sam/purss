import "@purss/ui/tokens.css";
import "@purss/ui/primitives.css";
import "../lib/pages.css";
import type { ConnectInfo } from "@purss/domain";
import { OFFICIAL_WORKSPACE_ORIGIN } from "@purss/domain/distribution";
import { parseWorkspaceAddress, startingServer, UNENCRYPTED_NOTE } from "@purss/domain/workspace-address";
import { WorkspaceError, exchangeCode, fetchInfo, workspace } from "../lib/api.ts";
import type { Connection } from "../lib/api.ts";
import { ext } from "../lib/browser.ts";
import { challengeFor, cleanTypedCode, connectPageUrl, deviceNameFor, randomVerifier, readRedirect } from "../lib/connect.ts";
import { followColorScheme, h, show } from "../lib/dom.ts";
import { forgetConnection, getConnection, getServer, getSettings, setBaskets, setConnection, setServer, setSettings } from "../lib/store.ts";

/*
 * Options: connect to a PURSS (plan/24: code + PKCE through the PURSS's approval page, or a
 * typed code where the browser can't take a redirect) on the official server unless the person
 * chooses another (remembered), disconnect, and the automatic mark setting.
 */

const api = ext();
const app = document.getElementById("app")!;
document.body.classList.add("options");
followColorScheme();

const message = (el: HTMLElement, text: string, kind: "error" | "fine" = "fine") => show(el, h("span", { class: kind, ...(kind === "error" ? { role: "alert" } : {}) }, text));
const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");

/** A connection waiting for the person to type the code your PURSS shows. */
let typed: { origin: string; info: ConnectInfo; verifier: string } | null = null;

async function finish(origin: string, info: ConnectInfo, p: { code: string; verifier: string; redirectUri?: string }): Promise<void> {
  const out = await exchangeCode(origin, p);
  const conn: Connection = { origin, name: info.name, token: out.token, deviceId: out.device.id, deviceName: out.device.name, browserCapture: info.features.browserCapture === true };
  await setConnection(conn);
  typed = null;
  await setBaskets(await workspace(conn).baskets()).catch(() => undefined);
  await render();
}

function connectForm(remembered: string | null): HTMLElement {
  const choice = startingServer(remembered, OFFICIAL_WORKSPACE_ORIGIN);
  const official = startingServer(null, OFFICIAL_WORKSPACE_ORIGIN);
  let other = choice.kind === "other";
  const address = h("input", { class: "in", id: "address", type: "text", inputmode: "url", autocomplete: "url", spellcheck: "false", placeholder: "e.g. purss.example.org" });
  address.value = choice.kind === "other" ? choice.address : "";
  const addressLabel = h("label", { for: "address" }, "Server address");
  const addressBox = h("div", { class: "fill" }, address);
  const server = h("p", { class: "fine", id: "server" });
  function showServer() {
    addressLabel.hidden = addressBox.hidden = !other;
    if (official.kind !== "official") return show(server);
    const host = new URL(official.origin).host;
    const toggle = (to: boolean, text: string) => h("button", { type: "button", class: "link", id: "change-server", onclick: () => { other = to; showServer(); if (other) address.focus(); } }, text);
    show(server, ...(other ? [toggle(false, `Use the official server (${host})`)] : [`Server: ${host} · `, toggle(true, "Change server")]));
  }
  showServer();
  const status = h("p", { id: "connect-status", "aria-live": "polite" });
  const codeInput = h("input", { class: "in", id: "code", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "xxxx-xxxx-xxxx" });
  const typedBox = h("div", { class: "card", id: "typed", hidden: true },
    h("p", {}, "Approve the connection in the tab that opened, then type the code it shows here."),
    h("div", { class: "hrow" }, h("div", { class: "fill" }, codeInput),
      h("button", { class: "btn primary", type: "button", id: "finish", onclick: () => void finishTyped() }, "Finish connecting")));

  async function start(mode: "redirect" | "typed") {
    const parsed = parseWorkspaceAddress(other || official.kind !== "official" ? address.value : official.origin);
    if (!parsed.ok) return message(status, parsed.message, "error");
    message(status, "Looking for your PURSS…");
    try {
      const info = await fetchInfo(parsed.origin);
      await setServer(parsed.origin);
      const verifier = randomVerifier();
      const challenge = await challengeFor(verifier);
      const deviceName = deviceNameFor(navigator.userAgent);
      if (mode === "redirect" && api.identity) {
        const redirectUri = api.identity.getRedirectURL();
        const state = randomVerifier();
        message(status, `Approve the connection in the window that opened.${parsed.unencrypted ? ` ${UNENCRYPTED_NOTE}` : ""}`);
        let final: string | undefined;
        try {
          final = await api.identity.launchWebAuthFlow({ url: connectPageUrl(parsed.origin, { challenge, deviceName, redirect: { uri: redirectUri, state } }), interactive: true });
        } catch {
          return message(status, "The connection wasn't finished: the window was closed or the PURSS couldn't be reached. Try again, or connect with a code instead.", "error");
        }
        const back = readRedirect(final ?? "", { redirectUri, state, origin: parsed.origin });
        if (!back.ok) return message(status, back.message, "error");
        message(status, "Finishing…");
        await finish(parsed.origin, info, { code: back.code, verifier, redirectUri });
      } else {
        typed = { origin: parsed.origin, info, verifier };
        typedBox.hidden = false;
        message(status, "");
        await api.tabs.create({ url: connectPageUrl(parsed.origin, { challenge, deviceName }) });
        codeInput.focus();
      }
    } catch (err) {
      message(status, errorText(err), "error");
    }
  }

  async function finishTyped() {
    if (!typed) return;
    const code = cleanTypedCode(codeInput.value);
    if (!code) return message(status, "Type the code your PURSS shows.", "error");
    message(status, "Finishing…");
    try {
      await finish(typed.origin, typed.info, { code, verifier: typed.verifier });
    } catch (err) {
      message(status, err instanceof WorkspaceError && err.code === "invalid_grant" ? "That code didn't work. It works once, for five minutes. Start connecting again for a new one." : errorText(err), "error");
    }
  }

  // Safari can't take the PURSS's answer directly, so there the code is the way to connect.
  const main = api.identity ? "redirect" : "typed";
  return h("section", { class: "card" },
    h("h2", {}, "Connect to your PURSS"),
    addressLabel,
    h("form", { class: "hrow", onsubmit: (e: Event) => { e.preventDefault(); void start(main); } },
      addressBox, h("button", { class: "btn primary", type: "submit", id: "connect" }, "Connect")),
    server,
    h("p", { class: "fine" }, "You'll approve the connection in your PURSS, signed in as yourself. The extension can then keep pages, look up whether a page is kept, list your baskets and collections, search, and hand sites to Add source; it can't change your account or security settings."),
    api.identity ? h("p", { class: "fine" }, h("button", { type: "button", class: "link", id: "use-code", onclick: () => void start("typed") }, "Connect with a code instead")) : null,
    status, typedBox);
}

function connected(conn: Connection): HTMLElement {
  const status = h("p", { "aria-live": "polite" });
  return h("section", { class: "card", id: "connected" },
    h("h2", {}, "Connected"),
    h("p", {}, `Connected to ${conn.origin} as “${conn.deviceName}”.`),
    h("p", { class: "fine" }, "You can also disconnect this extension in your PURSS, under Settings → Connected apps."),
    h("div", { class: "hrow" }, h("button", { class: "btn", type: "button", id: "disconnect", onclick: () => void (async () => {
      message(status, "Disconnecting…");
      // Revoke the token on the PURSS; forget it here even if the PURSS can't be reached.
      await workspace(conn).disconnect().catch(() => undefined);
      await forgetConnection();
      await render();
    })() }, "Disconnect")),
    status);
}

async function badgeSetting(): Promise<HTMLElement> {
  const settings = await getSettings();
  const has = await api.permissions.contains({ permissions: ["tabs"] });
  const box = h("input", { type: "checkbox", id: "auto-badge", ...(settings.autoBadge && has ? { checked: true } : {}) });
  box.addEventListener("change", () => {
    if (box.checked) {
      // Asked for only now, while the person is turning it on: reading each tab's address needs it.
      void api.permissions.request({ permissions: ["tabs"] }).then(async (granted) => {
        box.checked = granted;
        await setSettings({ autoBadge: granted });
      });
    } else {
      void setSettings({ autoBadge: false }).then(() => api.permissions.remove({ permissions: ["tabs"] }));
    }
  });
  return h("section", { class: "card" },
    h("h2", {}, "Mark pages you've kept"),
    h("label", { class: "check" }, box, h("span", {}, "Show a ✓ on the toolbar button when the page you open is already kept")),
    h("p", { class: "fine" }, "Off unless you turn it on. When it's on, the extension asks your PURSS about each page you open in a normal window (never in a private window), so your PURSS learns those addresses. When it's off, it asks only when you open the extension's popup on a page."));
}

async function render(): Promise<void> {
  const conn = await getConnection();
  show(app, h("div", { class: "pg" },
    h("h1", {}, "PURSS extension"),
    conn ? connected(conn) : connectForm(await getServer()),
    await badgeSetting(),
    h("section", { class: "card" },
      h("h2", {}, "Search from the address bar"),
      h("p", {}, "Type ", h("code", {}, "ws"), ", a space and what you're looking for, then press Enter.")),
    h("section", { class: "card" },
      h("h2", {}, "What the extension sends"),
      h("p", { class: "fine" }, "Only to your own PURSS, and only when you use it: the page's address and title when you keep it or open the popup; the readable text of the page when you choose to keep its text; your search words. It reads a page only when you open the popup on it or use the right-click menu. It sends nothing anywhere else.")),
  ));
}

void render();
