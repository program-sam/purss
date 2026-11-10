import test from "node:test";
import assert from "node:assert/strict";
import { BADGE_TTL_MS, Debouncer, KeptCache, mayLookUp } from "./badge.ts";
import { menuAction, menuItems } from "./menus.ts";

test("the right-click menu offers each basket for pages and links, or connecting", () => {
  assert.deepEqual(menuItems(false, []).map((m) => m.id), ["connect"]);
  assert.deepEqual(menuItems(true, []).map((m) => [m.id, m.enabled]), [["no-baskets", false]]);
  const items = menuItems(true, [{ id: "bsk_r", name: "Reading" }, { id: "bsk_p", name: "Papers" }]);
  assert.deepEqual(items.map((m) => [m.id, m.parentId ?? null, m.title, m.contexts.join()]), [
    ["keep-page", null, "Keep page in", "page"], ["keep-page:bsk_r", "keep-page", "Reading", "page"], ["keep-page:bsk_p", "keep-page", "Papers", "page"],
    ["keep-link", null, "Keep link in", "link"], ["keep-link:bsk_r", "keep-link", "Reading", "link"], ["keep-link:bsk_p", "keep-link", "Papers", "link"],
  ]);
  assert.equal(menuItems(true, Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `B${i}` }))).length, 2 + 2 * 12, "a long list is cut");
  assert.deepEqual(menuAction("keep-link:bsk_r"), { kind: "keep", what: "link", basketId: "bsk_r" });
  assert.deepEqual(menuAction("keep-page:bsk_p"), { kind: "keep", what: "page", basketId: "bsk_p" });
  assert.deepEqual(menuAction("connect"), { kind: "connect" });
  assert.equal(menuAction("keep-page"), null, "the parent entry does nothing");
  assert.equal(menuAction(7), null);
});

test("the automatic mark never looks at private windows, other schemes or the PURSS itself", () => {
  const ws = "https://ws.example";
  assert.ok(mayLookUp({ url: "https://news.example/a", incognito: false }, ws));
  assert.ok(!mayLookUp({ url: "https://news.example/a", incognito: true }, ws), "private window");
  assert.ok(!mayLookUp({ url: "https://news.example/a", incognito: false }, null), "not connected");
  assert.ok(!mayLookUp({ url: "chrome://newtab/", incognito: false }, ws));
  assert.ok(!mayLookUp({ url: "https://ws.example/b/x", incognito: false }, ws));
  assert.ok(!mayLookUp({ incognito: false }, ws), "no address without the tabs permission");
});

test("answers are remembered per page (not per fragment) for a while, and the oldest go first", () => {
  const c = new KeptCache();
  c.set("https://a.example/p#one", true, 1000);
  assert.equal(c.get("https://a.example/p#two", 2000), true);
  assert.equal(c.get("https://a.example/p", 1000 + BADGE_TTL_MS), undefined, "expired");
  for (let i = 0; i < 600; i++) c.set(`https://a.example/${i}`, false, 5000);
  assert.equal(c.get("https://a.example/0", 5000), undefined, "evicted");
  assert.equal(c.get("https://a.example/599", 5000), false);
  c.clear();
  assert.equal(c.get("https://a.example/599", 5000), undefined);
});

test("a tab is asked about once it settles", async () => {
  const d = new Debouncer<number>(20);
  const ran: string[] = [];
  d.run(1, () => ran.push("1a"));
  d.run(1, () => ran.push("1b"));
  d.run(2, () => ran.push("2"));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ran.sort(), ["1b", "2"]);
});
