import test from "node:test";
import assert from "node:assert/strict";
import { buildWidgetSnapshot, parseWidgetSnapshot, sameWidget, WIDGET_TO_READ, WIDGET_TO_READ_QUERY } from "./widget.ts";
import type { WidgetInput } from "./widget.ts";

const AT = Date.parse("2026-11-06T09:00:00Z");
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `itm_${i}`, title: `Title ${i}`, sourceTitle: `Source ${i}` }));
const input = (over: Partial<WidgetInput> = {}): WidgetInput => ({ theme: "system", eink: false, toRead: { items: items(2), total: 2 }, now: null, previous: null, at: AT, ...over });

test("the snapshot holds the next To read items and the episode, titles only", () => {
  const s = buildWidgetSnapshot(input({ toRead: { items: items(8), total: 8 }, now: { itemId: "itm_p", title: " Episode ", sourceTitle: "Slow Radio", playing: false, position: 754.6, duration: 3600.2 } }));
  assert.equal(s.toRead.length, WIDGET_TO_READ);
  assert.deepEqual(s.toRead[0], { id: "itm_0", title: "Title 0", sourceTitle: "Source 0" });
  assert.equal(s.toReadTotal, 8);
  assert.deepEqual(s.episode, { id: "itm_p", title: "Episode", sourceTitle: "Slow Radio", playing: false, loaded: true, positionSeconds: 754, durationSeconds: 3600 });
  assert.equal(s.updatedAt, "2026-11-06T09:00:00.000Z");
  assert.deepEqual(Object.keys(s).sort(), ["appearance", "episode", "toRead", "toReadTotal", "updatedAt"], "nothing else: no token, no address");
});

test("while playing the position moves by the minute, so the widget isn't redrawn every second", () => {
  const at = (position: number) => buildWidgetSnapshot(input({ now: { itemId: "e", title: "E", sourceTitle: "S", playing: true, position, duration: null } }));
  assert.equal(at(61).episode!.positionSeconds, 60);
  assert.ok(sameWidget(at(61), at(119)));
  assert.ok(!sameWidget(at(61), at(121)));
});

test("the last played episode stays, paused, once nothing is loaded; a failed read keeps the last To read list", () => {
  const first = buildWidgetSnapshot(input({ now: { itemId: "e", title: "E", sourceTitle: "S", playing: true, position: 30, duration: 90 } }));
  const later = buildWidgetSnapshot(input({ toRead: null, now: null, previous: first, at: AT + 1000 }));
  assert.deepEqual(later.episode, { ...first.episode!, playing: false, loaded: false });
  assert.deepEqual(later.toRead, first.toRead);
  assert.equal(later.toReadTotal, 2);
  assert.equal(buildWidgetSnapshot(input()).episode, null);
});

test("appearance: the app's theme, and e-ink over any theme", () => {
  assert.equal(buildWidgetSnapshot(input({ theme: "dark" })).appearance, "dark");
  assert.equal(buildWidgetSnapshot(input({ theme: "dark", eink: true })).appearance, "eink");
});

test("long and empty titles", () => {
  const s = buildWidgetSnapshot(input({ toRead: { items: [{ id: "a", title: "x".repeat(500), sourceTitle: "" }, { id: "b", title: "  ", sourceTitle: "S" }], total: 2 } }));
  assert.equal(s.toRead[0]!.title.length, 200);
  assert.ok(s.toRead[0]!.title.endsWith("…"));
  assert.equal(s.toRead[1]!.title, "Untitled");
});

test("a stored snapshot reads back; damage reads as none", () => {
  const s = buildWidgetSnapshot(input());
  assert.deepEqual(parseWidgetSnapshot(JSON.stringify(s)), s);
  assert.equal(parseWidgetSnapshot("{"), null);
  assert.equal(parseWidgetSnapshot('{"toRead":1}'), null);
  assert.equal(parseWidgetSnapshot(null), null);
  assert.equal(sameWidget(null, s), false);
});

test("the widget asks only for items of sources that aren't private", () => {
  assert.equal(WIDGET_TO_READ_QUERY.exceptPrivate, "1");
});
