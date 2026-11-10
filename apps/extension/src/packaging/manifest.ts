/*
 * The Manifest V3 file for each browser, from one description. The code is the same everywhere; only
 * how the background runs and a few browser-specific keys differ.
 */

import { dottedVersion } from "@purss/domain/version";

export const TARGETS = ["chromium", "firefox", "safari"] as const;
export type Target = (typeof TARGETS)[number];

/**
 * The extension's version: the product's (plan/40) in the dotted spelling the stores accept (2631214 is
 * 26.312.14), so each build from main is higher than the last, as the stores require. A build without a
 * version (no history) is 0.0.1.
 */
export function extensionVersion(version: string | null): string {
  return (version && dottedVersion(version)) ?? "0.0.1";
}

/**
 * Firefox's add-on id. It must stay the same once published (AMO ties the listing and updates to it),
 * and the PURSS's connect flow derives the extension's return address from it. Pick the final one
 * before the first upload to addons.mozilla.org.
 */
export const FIREFOX_ID = "purss@purss";

const ICONS = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };

export function manifestFor(target: Target, version: string | null): Record<string, unknown> {
  const permissions = [
    "activeTab", // read the one page the person opens the popup or right-click menu on
    "scripting", // run the page reader in that page
    "storage", // the connection and settings
    "contextMenus", // "Keep page in" / "Keep link in"
    ...(target === "safari" ? [] : ["identity"]), // launchWebAuthFlow; Safari has none and connects with a typed code
  ];
  return {
    manifest_version: 3,
    name: "PURSS",
    short_name: "PURSS",
    description: "Keep pages in your own PURSS, follow the sites you read, and search it from the address bar.",
    version: extensionVersion(version),
    icons: ICONS,
    action: { default_title: "PURSS", default_popup: "popup/popup.html", default_icon: ICONS },
    options_ui: { page: "options/options.html", open_in_tab: true },
    // Chrome and Edge run the background as a service worker; Firefox as an event page; Safari takes either.
    background: target === "firefox" ? { scripts: ["background.js"] } : { service_worker: "background.js" },
    permissions,
    // Only for the opt-in toolbar mark, asked for when the person turns it on.
    optional_permissions: ["tabs"],
    // No host permissions: the PURSS answers the extension's requests (CORS for extension origins,
    // plan/24), and pages are read only through activeTab.
    omnibox: { keyword: "purss" },
    ...(target === "chromium" ? { minimum_chrome_version: "120" } : {}),
    ...(target === "firefox" ? {
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ID,
          // 140 (an ESR) is the first to read the data-collection declaration below.
          strict_min_version: "140.0",
          // Firefox's data-collection disclosure: page addresses and, on request, page text go to the
          // PURSS the person connected (theirs, not the extension developer's).
          data_collection_permissions: { required: ["browsingActivity", "websiteContent"] },
        },
      },
    } : {}),
    ...(target === "safari" ? { browser_specific_settings: { safari: { strict_min_version: "16.4" } } } : {}),
  };
}
