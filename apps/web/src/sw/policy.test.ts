import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequest, copiesToEvict, isCopyableApi } from "./policy.ts";
import type { RequestInfo } from "./policy.ts";

const ORIGIN = "http://workspace.test";
const precached = new Set(["/app/index.html", "/app/manifest.webmanifest", "/app/icon.svg", "/app/assets/app-abc123.js"]);
const kind = (path: string, over: Partial<RequestInfo> = {}) =>
  classifyRequest({ method: "GET", url: new URL(path, ORIGIN).href, mode: "cors", ...over }, ORIGIN, precached);

test("the person's own reads are kept, nothing else under /api", () => {
  for (const path of ["/api/session", "/api/bootstrap", "/api/preferences", "/api/notifications", "/api/reminders", "/api/item-reminders", "/api/items/itm_01H/reminder", "/api/items?scope=home&filter=active&sort=newest&limit=50", "/api/items/itm_01H", "/api/items/itm_01H/annotations", "/api/stats/sources/src_1", "/api/stats/collections/col_1"]) {
    assert.equal(kind(path), "api", path);
  }
  for (const path of ["/api/events", "/api/auth/oidc/google/start", "/api/auth/logout", "/api/admin/jobs", "/api/admin/accounts", "/api/export", "/api/opml", "/api/account/security", "/api/search?q=a", "/api/publications", "/api/reconcile", "/api/sources/src_1", "/api/items/itm_1/state"]) {
    assert.equal(kind(path), "bypass", path);
  }
});

test("changes are never intercepted", () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD"]) assert.equal(kind("/api/items/itm_1", { method }), "bypass", method);
  assert.equal(kind("/api/session", { method: "POST" }), "bypass");
  for (const method of ["PUT", "DELETE"]) assert.equal(kind("/api/items/itm_1/annotations/ann_1", { method }), "bypass", `annotation ${method}`);
});

test("public pages, the website, the worker itself and other sites are left alone", () => {
  assert.equal(kind("/p/my-shelf", { mode: "navigate" }), "bypass");
  assert.equal(kind("/", { mode: "navigate" }), "bypass");
  assert.equal(kind("/terms.html", { mode: "navigate" }), "bypass");
  assert.equal(kind("/application", { mode: "navigate" }), "bypass");
  assert.equal(kind("/assets/index-9f8e7d.js"), "bypass");
  assert.equal(kind("/p/my-shelf/feed.atom"), "bypass");
  assert.equal(kind("/app/sw.js"), "bypass");
  assert.equal(kind("/api/items", { url: "https://elsewhere.example/api/items" }), "bypass");
  assert.equal(kind("/", { url: "https://elsewhere.example/", mode: "navigate" }), "bypass");
  assert.equal(kind("/img/a.png", { url: "https://cdn.example/a.png" }), "bypass");
});

test("a request that asks not to be kept is passed through", () => {
  const headers = { get: (n: string) => (n === "x-purss-no-copy" ? "1" : null) };
  assert.equal(kind("/api/items?scope=all&filter=toread", { headers }), "bypass");
});

test("built files and the manifest come from the shell, page loads fall back to the app page", () => {
  assert.equal(kind("/app/assets/index-9f8e7d.js"), "static");
  assert.equal(kind("/app/assets/never-listed.css"), "static");
  assert.equal(kind("/app/manifest.webmanifest"), "static");
  assert.equal(kind("/app/icon.svg"), "static");
  assert.equal(kind("/app/", { mode: "navigate" }), "navigation");
  assert.equal(kind("/app", { mode: "navigate" }), "navigation");
  assert.equal(kind("/app/c/col_1?view=board", { mode: "navigate" }), "navigation");
  assert.equal(kind("/app/index.html", { mode: "navigate" }), "navigation");
  assert.equal(kind("/api/export", { mode: "navigate" }), "bypass");
  assert.equal(kind("/app/some/other/file.txt"), "bypass");
});

test("isCopyableApi matches whole paths, not prefixes", () => {
  assert.equal(isCopyableApi("/api/items"), true);
  assert.equal(isCopyableApi("/api/itemsx"), false);
  assert.equal(isCopyableApi("/api/items/a/b"), false);
  assert.equal(isCopyableApi("/api/items/lookup"), false, "the address lookup is never answered from a copy");
  assert.equal(isCopyableApi("/api/items/itm_lookup"), true);
  assert.equal(isCopyableApi("/api/items/ids"), false, "Select all's ids are never answered from a copy");
  assert.equal(isCopyableApi("/api/session/extra"), false);
  assert.equal(isCopyableApi("/api"), false);
});

test("trimming drops the oldest copies and spares what the app needs to start", () => {
  const copies = [
    { url: "http://x/api/session", savedAt: 1 },
    { url: "http://x/api/bootstrap", savedAt: 2 },
    { url: "http://x/api/items/a", savedAt: 5 },
    { url: "http://x/api/items/b", savedAt: 3 },
    { url: "http://x/api/items/c", savedAt: 4 },
  ];
  const keep = (u: string) => /session|bootstrap/.test(u);
  assert.deepEqual(copiesToEvict(copies, 5, keep), []);
  assert.deepEqual(copiesToEvict(copies, 3, keep), ["http://x/api/items/b", "http://x/api/items/c"]);
  assert.deepEqual(copiesToEvict(copies, 0, keep), ["http://x/api/items/b", "http://x/api/items/c", "http://x/api/items/a"]);
});
