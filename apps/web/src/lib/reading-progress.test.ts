import test from "node:test";
import assert from "node:assert/strict";
import { Dwell, FITS_DWELL_MS, isScrollKey, keyScrollsReader, markPaging, resumeTop, scrollFraction } from "./reading-progress.ts";

test("how far an article is scrolled: 0 at the top, 1 at the end, nothing for text that fits the screen", () => {
  assert.equal(scrollFraction(0, 3000, 1000), 0);
  assert.equal(scrollFraction(1000, 3000, 1000), 0.5);
  assert.equal(scrollFraction(2000, 3000, 1000), 1);
  assert.equal(scrollFraction(5000, 3000, 1000), 1, "overscroll stays at 1");
  assert.equal(scrollFraction(0, 1030, 1000), null, "a few lines past the screen: nothing to scroll");
  assert.equal(scrollFraction(0, 900, 1000), null);
  assert.equal(scrollFraction(100, 1200, 1000), null, "a short abstract that goes a little past the screen is read by looking at it");
  assert.equal(scrollFraction(250, 1250, 1000), 1, "a quarter of the screen past it, scrolling counts");
});

test("reopening goes back to the saved place, unless there is none worth going back to or it was read to the end", () => {
  assert.equal(resumeTop(0.43, 3000, 1000), 860);
  assert.equal(resumeTop(0.01, 3000, 1000), null, "a glance");
  assert.equal(resumeTop(0, 3000, 1000), null);
  assert.equal(resumeTop(0.95, 3000, 1000), null, "read to the end starts at the top");
  assert.equal(resumeTop(1, 3000, 1000), null);
  assert.equal(resumeTop(0.5, 1020, 1000), null, "text that fits has no place to go back to");
  assert.equal(resumeTop(0.5, 1200, 1000), null, "nor text that nearly fits");
});

test("an item that fits the screen counts after it has been visible long enough, with hidden time left out", () => {
  const d = new Dwell(FITS_DWELL_MS);
  assert.equal(d.remaining(0), null, "not counting yet");
  d.show(1000);
  assert.equal(d.remaining(1000), FITS_DWELL_MS);
  assert.equal(d.remaining(1000 + 5000), FITS_DWELL_MS - 5000);
  d.hide(1000 + 8000);
  assert.equal(d.remaining(60_000), null, "hidden: no time passes");
  d.show(100_000);
  assert.equal(d.remaining(100_000), FITS_DWELL_MS - 8000, "8 s were seen before");
  assert.equal(d.remaining(100_000 + FITS_DWELL_MS), 0);
  d.show(120_000);
  assert.equal(d.remaining(100_000 + 1_000_000), 0, "never negative");
});

test("only keys that scroll a page are reading; Tab, Enter and letters are not", () => {
  for (const key of [" ", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"]) assert.equal(isScrollKey(key), true, key);
  for (const key of ["Tab", "Enter", "j", "Escape", "ArrowLeft"]) assert.equal(isScrollKey(key), false, key);
});

test("a paging control tells the area it scrolls, so a keyboard or synthesized press counts like any other", () => {
  const seen: string[] = [];
  const area = new EventTarget() as unknown as HTMLElement;
  area.addEventListener("purss:paging", () => seen.push("paging"));
  markPaging(area);
  assert.deepEqual(seen, ["paging"]);
});

test("a scrolling key scrolls the reader when focus is in it, or on the page after a press in it; not with focus on another control or while typing", () => {
  const base = { key: "PageDown", inReader: false, onPage: false, editable: false, pressedInReader: false };
  assert.equal(keyScrollsReader({ ...base, inReader: true }), true, "focus in the reader");
  assert.equal(keyScrollsReader({ ...base, onPage: true, pressedInReader: true }), true, "after a click in the text focus is on the page");
  assert.equal(keyScrollsReader({ ...base, onPage: true }), false, "focus on the page after a press elsewhere");
  assert.equal(keyScrollsReader({ ...base, pressedInReader: true }), false, "focus on another control");
  assert.equal(keyScrollsReader({ ...base, inReader: true, editable: true }), false, "typing in a note");
  assert.equal(keyScrollsReader({ ...base, inReader: true, key: "Tab" }), false, "Tab only moves focus");
  assert.equal(keyScrollsReader({ ...base, onPage: true, pressedInReader: true, key: " " }), true, "Space");
});
