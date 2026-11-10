import { readFileSync } from "node:fs";
import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android and iOS apps: the web app's production build (apps/web/dist) bundled into a Capacitor
 * shell. It talks to the PURSS the person connects to through the API with a device token (plan/31).
 * The PURSS also offers the build of the interface it runs; the app installs it when it fits this app's
 * native code (live updates, plan/39).
 *
 * appId and appName are plain choices the owner can change before the first store release (an app id
 * can't change after that). The iOS share extension's app group follows the app id.
 */
// The bundled interface's build (written by the web build): the updater plugin reports it as this app's own version,
// which is how a live update knows the native code it would run on and whether it is newer.
let builtIn: string | undefined;
try { builtIn = (JSON.parse(readFileSync("../web/dist/app-build.json", "utf8")) as { version: string }).version; } catch { /* not built yet */ }

const passkeyDomains = (process.env.PURSS_APP_PASSKEY_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);

const config: CapacitorConfig = {
  appId: "app.purss",
  appName: "PURSS",
  webDir: "../web/dist",
  // Plain address bars and links stay inside the app only for the bundled interface; anything else opens in the system browser.
  server: { androidScheme: "https", iosScheme: "capacitor" },
  android: {
    // A page loaded over https never loads plain-HTTP content into itself; requests to a local-network PURSS over
    // plain HTTP are the app's own (see res/xml/network_security_config.xml).
    allowMixedContent: false,
  },
  plugins: {
    CapacitorShareTarget: { appGroupId: "group.app.purss" },
    // iOS: a notification that arrives while the app is open still shows (plan/37).
    PushNotifications: { presentationOptions: ["alert", "sound"] },
    // The phone's own passkeys. Android needs nothing here: the PURSS vouches for the app with
    // /.well-known/assetlinks.json (PURSS_APP_ANDROID_CERT_SHA256). iOS only lets the app use the passkeys of
    // domains built into it: list them in PURSS_APP_PASSKEY_DOMAINS (comma-separated) when syncing.
    // autoShim stays off: the app calls the plugin itself (apps/web/src/platform/native/passkeys.ts).
    CapacitorPasskey: { autoShim: false, domains: passkeyDomains },
    // Live updates (plan/39), driven by the app itself (apps/web/src/platform/native/live-update.ts) from the
    // connected PURSS. Never Capgo's service: no automatic checks, no statistics, no channels. Plain http is
    // allowed because a PURSS on the home network may use it (the address rule, plan/31). A store update of
    // the app removes downloaded bundles, so the bundled interface takes over until the PURSS offers one again.
    CapacitorUpdater: {
      autoUpdate: false,
      updateUrl: "",
      statsUrl: "",
      channelUrl: "",
      httpsOnly: false,
      ...(builtIn ? { version: builtIn } : {}),
      resetWhenUpdate: true,
      autoDeleteFailed: true,
      autoDeletePrevious: true,
      keepUrlPathAfterReload: true,
      appReadyTimeout: 15000,
    },
  },
};

export default config;
