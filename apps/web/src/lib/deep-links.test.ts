import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { bookmarklet, deepLinkOverlay } from "./deep-links.ts";

test("deep links open the popup they name with what they carry", () => {
  assert.deepEqual(deepLinkOverlay({ dialog: "add", url: "https://quiet.example/feed" }), { kind: "add-source", url: "https://quiet.example/feed" });
  assert.deepEqual(deepLinkOverlay({ dialog: "add" }), { kind: "add-source" });
  assert.deepEqual(deepLinkOverlay({ dialog: "keep", url: "https://quiet.example/a", title: "A" }), { kind: "keep-page", url: "https://quiet.example/a", title: "A" });
  assert.deepEqual(deepLinkOverlay({ dialog: "keep", url: "https://quiet.example/a" }), { kind: "keep-page", url: "https://quiet.example/a" });
  assert.equal(deepLinkOverlay({ dialog: "keep" }), null, "nothing to keep");
  assert.deepEqual(deepLinkOverlay({ dialog: "search", q: "tides" }), { kind: "palette", query: "tides" });
  assert.deepEqual(deepLinkOverlay({ dialog: "search" }), { kind: "palette" });
  assert.deepEqual(deepLinkOverlay({ dialog: "apps" }), { kind: "settings", tab: "apps" });
  assert.deepEqual(deepLinkOverlay({ dialog: "account" }), { kind: "settings", tab: "account" });
  assert.equal(deepLinkOverlay({ dialog: "nope" }), null);
  assert.equal(deepLinkOverlay({ dialog: "constructor" }), null, "only its own names");
});

/** Run a bookmarklet as a browser would, on a page with this address and title; returns what it opened. */
function run(code: string, page: { href: string; title: string }): { url: string; target: string; features: string }[] {
  assert.ok(code.startsWith("javascript:"));
  const source = decodeURIComponent(code.slice("javascript:".length));
  assert.equal(source, code.slice("javascript:".length), "nothing in it changes when the browser decodes the address");
  const opened: { url: string; target: string; features: string }[] = [];
  const fetchCalls: unknown[] = [];
  vm.runInNewContext(source, {
    location: { href: page.href }, document: { title: page.title }, encodeURIComponent,
    window: { open: (url: string, target: string, features: string) => { opened.push({ url, target, features }); return null; } },
    fetch: (...a: unknown[]) => fetchCalls.push(a), XMLHttpRequest: function () { fetchCalls.push("xhr"); },
  });
  assert.deepEqual(fetchCalls, [], "no request from the page");
  return opened;
}

test("the bookmarklets only open PURSS with the page's address (and title)", () => {
  const page = { href: "https://news.example/story?id=7&ref=home#comments", title: "Storms & 100% \"tides\" — " + "x".repeat(400) };
  const [add] = run(bookmarklet("https://ws.example", "add"), page);
  assert.equal(add!.target, "_blank");
  assert.equal(add!.features, "noopener");
  const a = new URL(add!.url);
  assert.equal(a.origin, "https://ws.example");
  assert.deepEqual(Object.fromEntries(a.searchParams), { dialog: "add", url: page.href });

  const [keep] = run(bookmarklet("http://localhost:8940", "keep"), page);
  const k = new URL(keep!.url);
  assert.equal(k.origin, "http://localhost:8940");
  assert.equal(k.searchParams.get("dialog"), "keep");
  assert.equal(k.searchParams.get("url"), page.href);
  assert.equal(k.searchParams.get("title"), page.title.slice(0, 300), "the title, cut to what PURSS accepts");
});
