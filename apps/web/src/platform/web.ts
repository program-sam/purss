import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { HtmlMediaBackend } from "../player/html-backend.ts";
import { notifyPermission, requestNotifyPermission } from "../lib/browser-notify.ts";
import type { Notifier, Platform } from "./types.ts";
import { webOffline } from "./web-offline.ts";

/** The browser's notifications for this page (Settings → Notifications → browser alerts). */
export const browserNotifier: Notifier = {
  kind: "browser",
  permission: notifyPermission,
  request: requestNotifyPermission,
  show(note, onClick) {
    try {
      const popup = new Notification(note.title, { body: note.body, tag: note.tag });
      popup.onclick = () => { window.focus(); onClick(); popup.close(); };
    } catch { /* the browser refused; the bell still has it */ }
  },
};

/** The web app in a browser: the page is served by PURSS itself, so everything is same-origin with the session cookie. */
export const webPlatform: Platform = {
  kind: "web",
  interfaceUpdates: null,
  appVersion: async () => null,
  transport: {
    fetch: (path, init) => fetch(path, { ...init, credentials: "same-origin" }),
    events: (onMessage) => {
      if (typeof EventSource === "undefined") return () => {};
      const es = new EventSource("/api/events");
      es.onmessage = (ev: MessageEvent<string>) => onMessage(ev.data);
      return () => es.close();
    },
  },
  offline: webOffline,
  createPlayerBackend: () => new HtmlMediaBackend(),
  downloads: null,
  connection: null,
  passkeys: typeof window !== "undefined" && window.isSecureContext && browserSupportsWebAuthn()
    ? { create: (optionsJSON) => startRegistration({ optionsJSON }), get: (optionsJSON) => startAuthentication({ optionsJSON }) }
    : null,
  async saveFile(data, filename) {
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
  openExternal: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
  publicOrigin: () => location.origin,
  onShare: () => () => {},
  widget: null,
  push: null,
  onOpen: () => () => {},
  onConnectReturn: () => () => {},
  notifier: browserNotifier,
  badge: null,
  onIntake: () => () => {},
  desktop: null,
};
