import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPS_GUIDE_URL, DISTRIBUTION, SOURCE_URL, STORE_LISTINGS, STORE_NAMES, publishedStores } from "./distribution.ts";
import type { StoreId } from "./distribution.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes. */
const anchors = (markdown: string) => new Set([...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]!.trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-")));

test("every install link names a file and heading that exist in the repository", () => {
  for (const url of [APPS_GUIDE_URL, DISTRIBUTION.extension.install, DISTRIBUTION.mobile.install]) {
    const m = new RegExp(`^${SOURCE_URL}/blob/main/([^#]+)#(.+)$`).exec(url);
    assert.ok(m, url);
    assert.ok(anchors(readFileSync(path.join(REPO, m[1]!), "utf8")).has(m[2]!), `${m[1]} has a heading for #${m[2]}`);
  }
});

test("store listings are https addresses or not published, and only published ones become buttons", () => {
  for (const [id, url] of Object.entries(STORE_LISTINGS)) {
    assert.ok(STORE_NAMES[id as StoreId]);
    if (url !== null) assert.equal(new URL(url).protocol, "https:", id);
  }
  const listed = (ids: readonly StoreId[]) => ids.filter((id) => STORE_LISTINGS[id] !== null);
  assert.deepEqual(publishedStores("extension").map((s) => s.id), listed(DISTRIBUTION.extension.stores));
  assert.deepEqual(publishedStores("mobile").map((s) => s.id), listed(DISTRIBUTION.mobile.stores));
  const none = Object.fromEntries(Object.keys(STORE_LISTINGS).map((id) => [id, null])) as Record<StoreId, string | null>;
  const firefoxOnly = { ...none, firefox: "https://addons.mozilla.org/firefox/addon/x/" };
  assert.deepEqual(publishedStores("extension", none), []);
  assert.deepEqual(publishedStores("extension", firefoxOnly), [{ id: "firefox", name: "Firefox Add-ons", url: "https://addons.mozilla.org/firefox/addon/x/" }], "setting one address is enough for its button");
  assert.deepEqual(publishedStores("mobile", firefoxOnly), []);
  for (const id of [...DISTRIBUTION.extension.stores, ...DISTRIBUTION.mobile.stores]) assert.ok(id in STORE_LISTINGS, `${id} is a known store`);
  assert.deepEqual([...DISTRIBUTION.extension.stores, ...DISTRIBUTION.mobile.stores].filter((id) => id === "safari" || id === "ios"), [], "Apple's stores are parked: their code stays, they aren't offered");
});
