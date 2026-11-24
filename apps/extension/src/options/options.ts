import { extension } from "@purss/translations/extension";
import "@purss/ui/tokens.css";
import "@purss/ui/primitives.css";
import "../lib/pages.css";
import type { ConnectInfo } from "@purss/domain";
import { randomToken, s256Challenge } from "@purss/domain/connect-protocol";
import { OFFICIAL_PURSS_ORIGIN } from "@purss/domain/distribution";
import { parsePurssAddress, startingServer, UNENCRYPTED_NOTE } from "@purss/domain/purss-address";
import { PurssError, exchangeCode, fetchInfo, purssClient } from "../lib/api.ts";
import type { Connection } from "../lib/api.ts";
import { ext } from "../lib/browser.ts";
import { cleanTypedCode, connectPageUrl, deviceNameFor, readRedirect } from "../lib/connect.ts";
import { followColorScheme, h, show } from "../lib/dom.ts";
import { forgetConnection, getConnection, getServer, getSettings, setBaskets, setConnection, setServer, setSettings } from "../lib/store.ts";

/*
 * Options: connect to a PURSS (code + PKCE through the PURSS's approval page, or a
 * typed code where the browser can't take a redirect) on the official server unless the person
 * chooses another (remembered), disconnect, and the automatic mark setting.
 */

const api = ext();
const app = document.getElementById("app")!;
document.body.classList.add("options");
followColorScheme();

const message = (el: HTMLElement, text: string, kind: "error" | "fine" = "fine") => show(el, h("span", { class: kind, ...(kind === "error" ? { role: "alert" } : {}) }, text));
const errorText = (err: unknown) => (err instanceof Error ? err.message : extension.options.somethingWentWrong);

/** A connection waiting for the person to type the code your PURSS shows. */
let typed: { origin: string; info: ConnectInfo; verifier: string } | null = null;

async function finish(origin: string, info: ConnectInfo, p: { code: string; verifier: string; redirectUri?: string }): Promise<void> {
  const out = await exchangeCode(origin, p);
  const conn: Connection = { origin, name: info.name, token: out.token, deviceId: out.device.id, deviceName: out.device.name, browserCapture: info.features.browserCapture === true };
  await setConnection(conn);
  typed = null;
  await setBaskets(await purssClient(conn).baskets()).catch(() => undefined);
  await render();
}

function connectForm(remembered: string | null): HTMLElement {
  const choice = startingServer(remembered, OFFICIAL_PURSS_ORIGIN);
  const official = startingServer(null, OFFICIAL_PURSS_ORIGIN);
  let other = choice.kind === "other";
  const address = h("input", { class: "in", id: "address", type: "text", inputmode: "url", autocomplete: "url", spellcheck: "false", placeholder: extension.options.connect.addressPlaceholder });
  address.value = choice.kind === "other" ? choice.address : "";
  const addressLabel = h("label", { for: "address" }, extension.options.connect.addressLabel);
  const addressBox = h("div", { class: "fill" }, address);
  const server = h("p", { class: "fine", id: "server" });
  function showServer() {
    addressLabel.hidden = addressBox.hidden = !other;
    if (official.kind !== "official") return show(server);
    const host = new URL(official.origin).host;
    const toggle = (to: boolean, text: string) => h("button", { type: "button", class: "link", id: "change-server", onclick: () => { other = to; showServer(); if (other) address.focus(); } }, text);
    show(server, ...(other ? [toggle(false, extension.options.connect.useOfficial(host))] : [extension.options.connect.server(host), toggle(true, extension.options.connect.changeServer)]));
  }
  showServer();
  const status = h("p", { id: "connect-status", "aria-live": "polite" });
  const codeInput = h("input", { class: "in", id: "code", type: "text", autocomplete: "off", spellcheck: "false", placeholder: extension.options.connect.codePlaceholder });
  const typedBox = h("div", { class: "card", id: "typed", hidden: true },
    h("p", {}, extension.options.connect.typedCode),
    h("div", { class: "hrow" }, h("div", { class: "fill" }, codeInput),
      h("button", { class: "btn primary", type: "button", id: "finish", onclick: () => void finishTyped() }, extension.options.connect.finish)));

  async function start(mode: "redirect" | "typed") {
    const parsed = parsePurssAddress(other || official.kind !== "official" ? address.value : official.origin);
    if (!parsed.ok) return message(status, parsed.message, "error");
    message(status, extension.options.connect.looking);
    try {
      const info = await fetchInfo(parsed.origin);
      await setServer(parsed.origin);
      const verifier = randomToken(32);
      const challenge = await s256Challenge(verifier);
      const deviceName = deviceNameFor(navigator.userAgent);
      if (mode === "redirect" && api.identity) {
        const redirectUri = api.identity.getRedirectURL();
        const state = randomToken(32);
        message(status, extension.options.connect.approve(parsed.unencrypted ? UNENCRYPTED_NOTE : null));
        let final: string | undefined;
        try {
          final = await api.identity.launchWebAuthFlow({ url: connectPageUrl(parsed.origin, { challenge, deviceName, redirect: { uri: redirectUri, state } }), interactive: true });
        } catch {
          return message(status, extension.options.connect.notFinished, "error");
        }
        const back = readRedirect(final ?? "", { redirectUri, state, origin: parsed.origin });
        if (!back.ok) return message(status, back.message, "error");
        message(status, extension.options.finishing);
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
    if (!code) return message(status, extension.options.connect.typeTheCode, "error");
    message(status, extension.options.finishing);
    try {
      await finish(typed.origin, typed.info, { code, verifier: typed.verifier });
    } catch (err) {
      message(status, err instanceof PurssError && err.code === "invalid_grant" ? extension.options.connect.codeDidntWork : errorText(err), "error");
    }
  }

  // Safari can't take the PURSS's answer directly, so there the code is the way to connect.
  const main = api.identity ? "redirect" : "typed";
  return h("section", { class: "card" },
    h("h2", {}, extension.options.connect.title),
    addressLabel,
    h("form", { class: "hrow", onsubmit: (e: Event) => { e.preventDefault(); void start(main); } },
      addressBox, h("button", { class: "btn primary", type: "submit", id: "connect" }, extension.options.connect.button)),
    server,
    h("p", { class: "fine" }, extension.options.connect.explainer),
    api.identity ? h("p", { class: "fine" }, h("button", { type: "button", class: "link", id: "use-code", onclick: () => void start("typed") }, extension.options.connect.useCode)) : null,
    status, typedBox);
}

function connected(conn: Connection): HTMLElement {
  const status = h("p", { "aria-live": "polite" });
  return h("section", { class: "card", id: "connected" },
    h("h2", {}, extension.options.connected.title),
    h("p", {}, extension.options.connected.to(conn.origin, conn.deviceName)),
    h("p", { class: "fine" }, extension.options.connected.hint),
    h("div", { class: "hrow" }, h("button", { class: "btn", type: "button", id: "disconnect", onclick: () => void (async () => {
      message(status, extension.options.connected.disconnecting);
      // Revoke the token on the PURSS; forget it here even if the PURSS can't be reached.
      await purssClient(conn).disconnect().catch(() => undefined);
      await forgetConnection();
      await render();
    })() }, extension.options.connected.disconnect)),
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
    h("h2", {}, extension.options.badge.title),
    h("label", { class: "check" }, box, h("span", {}, extension.options.badge.label)),
    h("p", { class: "fine" }, extension.options.badge.hint));
}

async function render(): Promise<void> {
  const conn = await getConnection();
  show(app, h("div", { class: "pg" },
    h("h1", {}, extension.options.title),
    conn ? connected(conn) : connectForm(await getServer()),
    await badgeSetting(),
    h("section", { class: "card" },
      h("h2", {}, extension.options.search.title),
      h("p", {}, extension.options.search.before, h("code", {}, "purss"), extension.options.search.after)),
    h("section", { class: "card" },
      h("h2", {}, extension.options.sends.title),
      h("p", { class: "fine" }, extension.options.sends.body)),
  ));
}

void render();
