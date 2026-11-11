/*
 * Where people get the browser extension, the phone apps and the desktop app (plan/31, plan/32, plan/42): the one
 * place that knows. A store listing is null until the owner publishes there; until then Settings → Connected apps
 * says "Not in the stores yet" and links to the install instructions, and the website shows no store button.
 * Setting a listing's address is all it takes for its store button to appear in both. No dependencies, so the website can
 * import it.
 */

export type StoreId = "chrome" | "edge" | "firefox" | "safari" | "android" | "ios";

/** Store listings, by store. null: not published there yet. */
export const STORE_LISTINGS: Readonly<Record<StoreId, string | null>> = {
  chrome: "https://chromewebstore.google.com/detail/purss/hbchpheipggpppbilgepkalcnnemnldl",
  edge: null,
  firefox: null,
  safari: null,
  android: null,
  ios: null,
};

export const STORE_NAMES: Readonly<Record<StoreId, string>> = {
  chrome: "Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox Add-ons",
  safari: "Mac App Store",
  android: "Google Play",
  ios: "App Store",
};

/**
 * The official PURSS server: what the phone apps and the browser extension connect to unless the
 * person chooses another server. Change this value to move the official server; an empty string means
 * there is none, and the apps and the extension ask for an address instead.
 */
export const OFFICIAL_WORKSPACE_ORIGIN = "https://purss.app";

/** The source code and its documentation. */
export const SOURCE_URL = "https://github.com/program-sam/purss";
const doc = (file: string, anchor?: string) => `${SOURCE_URL}/blob/main/${file}${anchor ? `#${anchor}` : ""}`;

export type Distributed = "extension" | "mobile";

export const DISTRIBUTION: Readonly<Record<Distributed, { stores: readonly StoreId[]; platforms: string; install: string }>> = {
  extension: { stores: ["chrome", "edge", "firefox"], platforms: "Chrome, Edge and Firefox", install: doc("apps/extension/README.md", "try-it-unpacked") },
  mobile: { stores: ["android"], platforms: "Android", install: doc("apps/mobile/README.md", "build") },
};

/**
 * The desktop app (plan/42): GitHub releases of this repository, built by .github/workflows/desktop.yml. Every release
 * carries the same file names, so `releases/latest/download/<name>` always reaches the newest. The repository must be
 * public for these to download.
 */
export type DesktopPackage = {
  /** The name the file has in every release. */
  file: string;
  /** What the website and the README call it. */
  label: string;
  os: "windows" | "macos" | "linux";
  /** The keys of latest.json this file answers (the updater looks for `<os>-<arch>-<package>`, then `<os>-<arch>`). */
  updates: string[];
  /** The file Tauri made, found by its ending in the bundle folder. */
  made: { folder: string; ending: string };
  /** Made only for the updater (with the updater key), never downloaded by people. */
  updaterOnly?: boolean;
};

export const DESKTOP_PACKAGES: readonly DesktopPackage[] = [
  { file: "PURSS-windows-x64-setup.exe", label: "Windows (64-bit)", os: "windows", updates: ["windows-x86_64-nsis", "windows-x86_64"], made: { folder: "nsis", ending: "-setup.exe" } },
  { file: "PURSS-macos.dmg", label: "macOS (Apple silicon and Intel)", os: "macos", updates: [], made: { folder: "dmg", ending: ".dmg" } },
  { file: "PURSS-macos.app.tar.gz", label: "macOS update", updaterOnly: true, os: "macos", updates: ["darwin-aarch64-app", "darwin-x86_64-app", "darwin-aarch64", "darwin-x86_64"], made: { folder: "macos", ending: ".app.tar.gz" } },
  { file: "PURSS-linux-x86_64.AppImage", label: "Linux AppImage (any distribution)", os: "linux", updates: ["linux-x86_64-appimage", "linux-x86_64"], made: { folder: "appimage", ending: ".AppImage" } },
  { file: "PURSS-linux-amd64.deb", label: "Linux .deb (Debian, Ubuntu)", os: "linux", updates: ["linux-x86_64-deb"], made: { folder: "deb", ending: ".deb" } },
  { file: "PURSS-linux-x86_64.rpm", label: "Linux .rpm (Fedora, openSUSE)", os: "linux", updates: ["linux-x86_64-rpm"], made: { folder: "rpm", ending: ".rpm" } },
];

/** The files people download (the macOS update archive is for the updater only). */
export const DESKTOP_DOWNLOADS: readonly DesktopPackage[] = DESKTOP_PACKAGES.filter((p) => !p.updaterOnly);

/** The Android app outside the stores: a signed APK in the same releases (built by the same workflow). */
export const ANDROID_APK = "PURSS-android.apk";

export const DESKTOP_RELEASES_URL = `${SOURCE_URL}/releases/latest`;
export const desktopDownloadUrl = (file: string): string => `${SOURCE_URL}/releases/latest/download/${file}`;

/** The user guide's section on all of them. */
export const APPS_GUIDE_URL = doc("docs/user-guide.md", "apps-and-extensions");

/** The stores where one of them is published, with their addresses. */
export function publishedStores(what: Distributed, listings: Readonly<Record<StoreId, string | null>> = STORE_LISTINGS): { id: StoreId; name: string; url: string }[] {
  return DISTRIBUTION[what].stores.flatMap((id) => {
    const url = listings[id];
    return url ? [{ id, name: STORE_NAMES[id], url }] : [];
  });
}

/**
 * The project's push relay (plan/37, apps/push-relay). It holds the phone apps' Firebase and Apple push
 * credentials and wakes a phone when its PURSS has something new, never with any content. The apps
 * register with it; every PURSS sends through it unless its operator sets PURSS_PUSH_RELAY_URL. The value
 * to change once the owner has deployed the relay at its final address.
 */
export const OFFICIAL_PUSH_RELAY = "https://push.purss.app";
