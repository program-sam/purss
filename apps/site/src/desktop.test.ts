import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopOs, pickDesktopDownload } from "./desktop.ts";

test("the visitor's system picks the main download; Android gets the app; iPhones, iPads and the unknown keep the list", () => {
  assert.equal(desktopOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"), "windows");
  assert.equal(desktopOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"), "macos");
  assert.equal(desktopOs("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"), "linux");
  assert.equal(desktopOs("Mozilla/5.0 (X11; Fedora; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"), "linux");
  assert.equal(desktopOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", 5), null, "an iPad asking for the desktop site");
  assert.equal(desktopOs("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36"), "android");
  assert.equal(desktopOs("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), null);
  assert.equal(desktopOs("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"), null);
  assert.equal(desktopOs("curl/8.0"), null);
});

test("the button gets the visitor's file and the link to other systems appears; elsewhere the button stays on the release page", () => {
  const page = () => {
    const main = { href: "releases", textContent: "Download", dataset: { windows: "win.exe", macos: "mac.dmg", linux: "linux.AppImage", android: "app.apk" } as Record<string, string> };
    const other = { hidden: true };
    const doc = { querySelector: (s: string) => (s === "[data-desktop-main]" ? main : s === "[data-desktop-other]" ? other : null) } as unknown as Pick<Document, "querySelector">;
    return { main, other, doc };
  };
  const mac = page();
  pickDesktopDownload(mac.doc, { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" });
  assert.deepEqual([mac.main.href, mac.main.textContent, mac.other.hidden], ["mac.dmg", "Download for Mac", false]);
  const android = page();
  pickDesktopDownload(android.doc, { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36" });
  assert.deepEqual([android.main.href, android.main.textContent], ["app.apk", "Download for Android"]);
  const phone = page();
  pickDesktopDownload(phone.doc, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
  assert.deepEqual([phone.main.href, phone.main.textContent, phone.other.hidden], ["releases", "Download", true]);
});
