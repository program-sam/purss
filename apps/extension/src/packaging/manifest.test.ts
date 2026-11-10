import test from "node:test";
import assert from "node:assert/strict";
import { TARGETS, extensionVersion, manifestFor } from "./manifest.ts";

test("every build asks for the same narrow permissions, and none for sites", () => {
  for (const t of TARGETS) {
    const m = manifestFor(t, "2631214");
    assert.equal(m.manifest_version, 3, t);
    assert.equal(m.host_permissions, undefined, `${t}: no standing access to any site`);
    assert.equal((m as { content_scripts?: unknown }).content_scripts, undefined, `${t}: nothing runs on pages by itself`);
    assert.deepEqual(m.optional_permissions, ["tabs"], `${t}: tabs only for the opt-in mark`);
    const perms = m.permissions as string[];
    for (const p of ["activeTab", "scripting", "storage", "contextMenus"]) assert.ok(perms.includes(p), `${t}: ${p}`);
    for (const p of ["tabs", "<all_urls>", "cookies", "webRequest", "history", "bookmarks"]) assert.ok(!perms.includes(p), `${t}: no ${p}`);
    assert.deepEqual(m.omnibox, { keyword: "purss" });
    assert.equal(m.version, "26.312.14", t);
  }
});

test("each browser gets the background and keys it understands", () => {
  const chromium = manifestFor("chromium", "2631214");
  assert.deepEqual(chromium.background, { service_worker: "background.js" });
  assert.ok((chromium.permissions as string[]).includes("identity"));
  assert.equal(chromium.browser_specific_settings, undefined);

  const firefox = manifestFor("firefox", "2631214");
  assert.deepEqual(firefox.background, { scripts: ["background.js"] }, "Firefox runs an event page, not a service worker");
  const gecko = (firefox.browser_specific_settings as { gecko: { id: string; strict_min_version: string } }).gecko;
  assert.match(gecko.id, /^[\w.-]+@[\w.-]+$/);
  assert.equal(firefox.minimum_chrome_version, undefined);

  const safari = manifestFor("safari", "2631214");
  assert.ok(!(safari.permissions as string[]).includes("identity"), "Safari has no identity API; it connects with a typed code");
});

test("the version is the product's in the stores' dotted spelling; a build without one is 0.0.1", () => {
  assert.equal(extensionVersion("2600101"), "26.1.1");
  assert.equal(extensionVersion(null), "0.0.1");
});
