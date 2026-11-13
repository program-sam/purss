import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { itemListQuerySchema } from "@purss/domain";
import { buildWidgetSnapshot, isWidgetList, parseWidgetSnapshot, sameWidget, widgetListPlace } from "./widget.ts";
import type { WidgetInput } from "./widget.ts";

const AT = Date.parse("2026-11-06T09:00:00Z");
const input = (over: Partial<WidgetInput> = {}): WidgetInput => ({ theme: "system", eink: false, now: null, previous: null, at: AT, ...over });

test("the snapshot holds the look and the episode, titles only", () => {
  const s = buildWidgetSnapshot(input({ now: { itemId: "itm_p", title: " Episode ", sourceTitle: "Slow Radio", playing: false, position: 754.6, duration: 3600.2 } }));
  assert.deepEqual(s.episode, { id: "itm_p", title: "Episode", sourceTitle: "Slow Radio", playing: false, loaded: true, positionSeconds: 754, durationSeconds: 3600 });
  assert.equal(s.updatedAt, "2026-11-06T09:00:00.000Z");
  assert.deepEqual(Object.keys(s).sort(), ["appearance", "episode", "updatedAt"], "nothing else: no token, no address, no lists");
});

test("while playing the position moves by the minute, so the widget isn't redrawn every second", () => {
  const at = (position: number) => buildWidgetSnapshot(input({ now: { itemId: "e", title: "E", sourceTitle: "S", playing: true, position, duration: null } }));
  assert.equal(at(61).episode!.positionSeconds, 60);
  assert.ok(sameWidget(at(61), at(119)));
  assert.ok(!sameWidget(at(61), at(121)));
});

test("the last played episode stays, paused, once nothing is loaded", () => {
  const first = buildWidgetSnapshot(input({ now: { itemId: "e", title: "E", sourceTitle: "S", playing: true, position: 30, duration: 90 } }));
  const later = buildWidgetSnapshot(input({ now: null, previous: first, at: AT + 1000 }));
  assert.deepEqual(later.episode, { ...first.episode!, playing: false, loaded: false });
  assert.equal(buildWidgetSnapshot(input()).episode, null);
});

test("appearance: the app's theme, and e-ink over any theme", () => {
  assert.equal(buildWidgetSnapshot(input({ theme: "dark" })).appearance, "dark");
  assert.equal(buildWidgetSnapshot(input({ theme: "dark", eink: true })).appearance, "eink");
});

test("long and empty titles", () => {
  const long = buildWidgetSnapshot(input({ now: { itemId: "e", title: "x".repeat(500), sourceTitle: "", playing: false, position: 0, duration: null } }));
  assert.equal(long.episode!.title.length, 200);
  assert.ok(long.episode!.title.endsWith("…"));
  assert.equal(buildWidgetSnapshot(input({ now: { itemId: "e", title: "  ", sourceTitle: "S", playing: false, position: 0, duration: null } })).episode!.title, "Untitled");
});

test("a stored snapshot reads back; damage reads as none", () => {
  const s = buildWidgetSnapshot(input());
  assert.deepEqual(parseWidgetSnapshot(JSON.stringify(s)), s);
  assert.equal(parseWidgetSnapshot("{"), null);
  assert.equal(parseWidgetSnapshot('{"toRead":1}'), null);
  assert.equal(parseWidgetSnapshot('{"appearance":"dark","updatedAt":"x","episode":3}'), null);
  assert.equal(parseWidgetSnapshot(null), null);
  assert.equal(sameWidget(null, s), false);
});

type Fixture = { lists: { key: string; path: string; open: { place: unknown; search?: unknown } }[]; invalid: string[] };
const fixture = JSON.parse(readFileSync(new URL("../../../mobile/widget-lists.json", import.meta.url), "utf8")) as Fixture;

test("a panel's heading opens the list it shows (the table the native sides follow)", () => {
  for (const l of fixture.lists) {
    assert.ok(isWidgetList(l.key), l.key);
    assert.deepEqual(widgetListPlace(l.key), l.open, l.key);
  }
  for (const bad of fixture.invalid) {
    assert.equal(isWidgetList(bad), false, bad);
    assert.equal(widgetListPlace(bad), null, bad);
  }
});

test("every panel asks only for items of sources that aren't private, and a handful of them", () => {
  for (const l of fixture.lists) {
    const q = new URL(l.path, "https://x.example").searchParams;
    assert.equal(q.get("exceptPrivate"), "1", l.key);
    assert.equal(q.get("limit"), "10", l.key);
    assert.equal(new URL(l.path, "https://x.example").pathname, "/api/items", l.key);
    assert.ok(itemListQuerySchema.safeParse(Object.fromEntries(q)).success, `the server takes ${l.key}'s request`);
  }
});
