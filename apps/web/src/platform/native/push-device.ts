import { Capacitor, registerPlugin } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { OFFICIAL_PUSH_RELAY } from "@purss/domain/distribution";
import { api } from "../../api/client.ts";
import type { PhonePush } from "../types.ts";
import { PushController } from "./push.ts";
import type { PushPermission } from "./push.ts";

/*
 * The device side of notifications on this phone (plan/37): @capacitor/push-notifications for the system's
 * permission prompt, the push address and taps on iOS; the app's own PurssPush plugin for what the native
 * notification code needs (Android's messaging service and iOS's notification service extension fetch the
 * texts themselves, with the credential handed over here). See push.ts for the rules.
 */

type PurssPushPlugin = {
  /** pushReady: this build can receive pushes. relay and debugToken are set only in Android debug builds made for trying a local relay. */
  config(): Promise<{ pushReady: boolean; relay: string; debugToken: string }>;
  setTarget(options: { origin: string; fetchToken: string }): Promise<void>;
  clearTarget(): Promise<void>;
};
const PurssPush = registerPlugin<PurssPushPlugin>("PurssPush");

export type PushSetup = { relay: string; ready: boolean; debugToken: string };

/** Which relay this build registers with, and whether it can receive pushes. */
export async function pushSetup(): Promise<PushSetup> {
  try {
    const c = await PurssPush.config();
    return { relay: c.relay || OFFICIAL_PUSH_RELAY, ready: c.pushReady, debugToken: c.debugToken };
  } catch {
    return { relay: OFFICIAL_PUSH_RELAY, ready: false, debugToken: "" };
  }
}

const mapPermission = (v: string): PushPermission => (v === "granted" ? "granted" : v === "denied" ? "denied" : "prompt");

export function devicePush(origin: string, setup: PushSetup): { push: PhonePush; forget: () => Promise<void>; onTap: (open: (link: unknown) => void) => () => void } {
  let lastToken: string | null = null;

  /** The phone's push address: the debug build's stand-in, or what the system hands out after register(). */
  function token(): Promise<string> {
    if (setup.debugToken) return Promise.resolve(setup.debugToken);
    return new Promise((resolve, reject) => {
      let done = false;
      const handles = [
        PushNotifications.addListener("registration", (t) => finish(() => { lastToken = t.value; resolve(t.value); })),
        PushNotifications.addListener("registrationError", (e) => finish(() => reject(new Error(e.error)))),
      ];
      const timer = setTimeout(() => finish(() => reject(new Error("The phone didn't hand out a push address in time."))), 20_000);
      function finish(fn: () => void) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const h of handles) void h.then((x) => x.remove());
        fn();
      }
      PushNotifications.register().catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }

  const controller = new PushController({
    platform: Capacitor.getPlatform() === "ios" ? "apns" : "fcm",
    relay: setup.relay,
    ready: setup.ready,
    store: {
      get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* kept for this run */ } },
      remove: (k) => { try { localStorage.removeItem(k); } catch { /* nothing */ } },
    },
    api: (path, init) => api(path, { method: (init?.method ?? "GET") as "GET", body: init?.body, live: true }),
    relayPost: async (path, body) => {
      const res = await fetch(`${setup.relay}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "omit", signal: AbortSignal.timeout(10_000) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    permission: async () => mapPermission((await PushNotifications.checkPermissions()).receive),
    requestPermission: async () => mapPermission((await PushNotifications.requestPermissions()).receive),
    token,
    setTarget: (fetchToken) => PurssPush.setTarget({ origin, fetchToken }),
    clearTarget: () => PurssPush.clearTarget(),
    randomScope: () => { const b = new Uint8Array(24); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  });

  if (setup.ready) {
    // A new push address from the system (Firebase rotates them now and then): register it.
    void PushNotifications.addListener("registration", (t) => { if (lastToken !== null && t.value !== lastToken) { lastToken = t.value; void controller.refresh().catch(() => undefined); } });
    // Once the app has started (the platform must be in place before the first request), quietly bring the registration up to date.
    setTimeout(() => void controller.refresh().catch(() => undefined), 2000);
  }

  const push: PhonePush = {
    status: () => controller.status(),
    enable: () => controller.enable(),
    disable: () => controller.disable(),
  };
  /** iOS: a tapped notification arrives with the `purss://open` link its extension put in it (Android's opens the link itself). */
  const onTap = (open: (link: unknown) => void) => {
    const handle = PushNotifications.addListener("pushNotificationActionPerformed", (a) => open((a.notification.data as Record<string, unknown> | undefined)?.purssOpen));
    return () => { void handle.then((h) => h.remove()); };
  };
  return { push, forget: () => controller.forget(), onTap };
}
