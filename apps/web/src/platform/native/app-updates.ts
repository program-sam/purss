import { ANDROID_APK, desktopDownloadUrl, STORE_LISTINGS } from "@purss/domain";
import { parseVersion, plainVersion } from "@purss/domain/version";
import type { AppSource, AppUpdates, AppUpdateState } from "../types.ts";
import type { KeyValue } from "./live-update.ts";

/*
 * New versions of the phone app itself, its native code (plan/39). The screens update from the server; the app around
 * them comes from where it was installed. Google Play, F-Droid and the App Store update it themselves. An APK from the
 * GitHub releases has nobody to do that, so the app checks the newest release once a day and says when it is newer.
 */

/** Where an app came from, as the phone reports it; null when it can't tell (an app built before it could). */
export function sourceOf(o: { platform: string; flavor?: string | null; installer?: string | null }): AppSource | null {
  if (o.platform === "ios") return "appstore";
  if (o.platform !== "android") return null;
  if (o.flavor === "foss") return "fdroid";
  if (o.installer === "com.android.vending") return "play";
  // The full build outside Google Play: the APK from the releases (installed by hand, by a browser or an APK updater).
  return o.flavor === "full" ? "github" : null;
}

/** Where people get a new version, and the address that takes them there when there is one. */
export function whereToGet(source: AppSource | null): { name: string; url: string | null } {
  switch (source) {
    case "github": return { name: "GitHub", url: desktopDownloadUrl(ANDROID_APK) };
    case "play": return { name: "Google Play", url: STORE_LISTINGS.android };
    case "fdroid": return { name: "F-Droid", url: null };
    case "appstore": return { name: "the App Store", url: STORE_LISTINGS.ios };
    default: return { name: "", url: null };
  }
}

/** The version a release manifest names (`26.315.32`), in its plain form; null when it names none. */
export function manifestVersion(manifest: unknown): string | null {
  const v = manifest && typeof manifest === "object" ? (manifest as { version?: unknown }).version : null;
  return typeof v === "string" ? plainVersion(v) : null;
}

/** Whether `published` is a later version than `installed`; never for a build without a version. */
export function isNewer(published: string | null, installed: string | null): boolean {
  if (!published || !installed || !parseVersion(published) || !parseVersion(installed)) return false;
  return published > installed;
}

const LATEST_KEY = "purss:app-latest";
const TOLD_NEWER_KEY = "purss:app-told-newer";
const TOLD_NEEDED_KEY = "purss:app-told-needed";
/** How often the releases are asked. */
export const CHECK_EVERY_MS = 24 * 3600_000;

type Latest = { version: string | null; at: number };

export type Deps = {
  source: () => Promise<AppSource | null>;
  /** The installed app's version, plain; null for a build without one. */
  installed: () => Promise<string | null>;
  /** The newest release's version, plain: null when it names none; rejects when it couldn't be asked. */
  latest: () => Promise<string | null>;
  store: KeyValue;
  now: () => number;
};

export function createAppUpdates(deps: Deps): AppUpdates & { check(): Promise<void> } {
  const listeners = new Set<() => void>();
  let state: AppUpdateState = { known: false, source: null, newer: null, installed: null, toldNewer: false, toldNeeded: false };
  let running: Promise<void> | null = null;

  const readLatest = (): Latest | null => {
    try {
      const v = JSON.parse(deps.store.get(LATEST_KEY) ?? "null") as Latest | null;
      return v && typeof v.at === "number" ? v : null;
    } catch { return null; }
  };
  function set(next: Partial<AppUpdateState>): void {
    state = { ...state, ...next };
    for (const l of listeners) l();
  }

  async function run(): Promise<void> {
    const source = await deps.source();
    const installed = await deps.installed();
    const toldNeeded = installed !== null && deps.store.get(TOLD_NEEDED_KEY) === installed;
    // Known before the releases are asked, so a slow answer doesn't leave the app looking like one of unknown source.
    set({ known: true, source, installed, toldNeeded });
    if (source !== "github") { set({ newer: null, toldNewer: false }); return; }
    let latest = readLatest();
    if (!latest || deps.now() - latest.at >= CHECK_EVERY_MS || latest.at > deps.now()) {
      try {
        latest = { version: await deps.latest(), at: deps.now() };
        deps.store.set(LATEST_KEY, JSON.stringify(latest));
      } catch { /* asked again next time; what was known still counts */ }
    }
    const newer = latest && isNewer(latest.version, installed) ? latest.version : null;
    set({ newer, toldNewer: newer !== null && deps.store.get(TOLD_NEWER_KEY) === newer });
  }

  return {
    state: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    check() {
      if (!running) running = run().catch(() => undefined).finally(() => { running = null; });
      return running;
    },
    markTold(what) {
      if (what === "newer" && state.newer) { deps.store.set(TOLD_NEWER_KEY, state.newer); set({ toldNewer: true }); }
      if (what === "needed" && state.installed) { deps.store.set(TOLD_NEEDED_KEY, state.installed); set({ toldNeeded: true }); }
    },
  };
}
