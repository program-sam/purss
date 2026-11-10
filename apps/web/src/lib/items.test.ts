import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { belongsInList, displayAuthors, isNewerCopy, isTimeBased, itemExcerpt, newMarkerCleared, isYouTube, itemDate, lengthText, matchesFilter, safeHref, safeImage, withNewerState } from "./items.ts";
import { workflowLabel } from "./constants.ts";

const base: ItemDTO = {
  id: "itm_x", sourceId: "src_x", sourceTitle: "S", kind: "article", title: "T", url: "https://example.com/a", author: null, excerpt: null, imageUrl: null,
  durationSeconds: null, readMinutes: 4, doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", workflow: "new", revision: 0, stateVersion: 4, fresh: true,
  progress: 0, opened: false, basketIds: [], curatorNote: null, media: null, annotatedAt: null,
};

test("filters judge workflow and freshness independently", () => {
  assert.equal(matchesFilter(base, "active"), true);
  assert.equal(matchesFilter({ ...base, workflow: "ignored" }, "active"), false);
  assert.equal(matchesFilter({ ...base, workflow: "ignored" }, "all"), true);
  assert.equal(matchesFilter({ ...base, workflow: "ignored" }, "fresh"), false);
  assert.equal(matchesFilter({ ...base, workflow: "toread" }, "toread"), true);
  assert.equal(matchesFilter({ ...base, workflow: "toread" }, "finished"), false);
  assert.equal(matchesFilter({ ...base, fresh: false, workflow: "finished" }, "fresh"), false);
  assert.equal(matchesFilter({ ...base, workflow: "toread" }, "open"), true);
  assert.equal(matchesFilter({ ...base, workflow: "finished" }, "open"), false);
  assert.equal(matchesFilter({ ...base, workflow: "ignored" }, "open"), false);
});

test("item date prefers publication, falls back to arrival", () => {
  assert.equal(itemDate(base), "2026-11-03T08:00:00Z");
  assert.equal(itemDate({ ...base, publishedAt: "2026-11-01T00:00:00Z" }), "2026-11-01T00:00:00Z");
});

test("length text: minutes for reading, a clock for video", () => {
  assert.equal(lengthText(base), "4 min");
  assert.equal(lengthText({ ...base, kind: "video", durationSeconds: 1122 }), "18:42");
  assert.equal(lengthText({ ...base, readMinutes: null }), "");
});

test("only http(s) links and https images are used", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("https://a.example/x"), "https://a.example/x");
  assert.equal(safeHref("not a url"), null);
  assert.equal(safeImage("http://a.example/i.png"), null);
  assert.equal(safeImage("https://a.example/i.png"), "https://a.example/i.png");
  assert.equal(isYouTube("https://www.youtube.com/watch?v=1"), true);
  assert.equal(isYouTube("https://notyoutube.com/x"), false);
});

test("videos and podcasts are told apart from text, and their to-do state has its own word", () => {
  assert.equal(isTimeBased("video"), true);
  assert.equal(isTimeBased("podcast"), true);
  assert.equal(isTimeBased("article"), false);
  assert.equal(workflowLabel("toread", "video"), "To watch");
  assert.equal(workflowLabel("toread", "podcast"), "To listen");
  assert.equal(workflowLabel("toread", "paper"), "To read");
  assert.equal(workflowLabel("toread"), "To read");
  assert.equal(workflowLabel("finished", "video"), "Finished");
  assert.equal(workflowLabel("new", "podcast"), "Undecided");
});

test("a change that took the New marker away is told apart from one that left it", () => {
  assert.equal(newMarkerCleared({ fresh: true }, { fresh: false }), true, "opened, or something done with it: the counts must follow");
  assert.equal(newMarkerCleared({ fresh: true }, { fresh: true }), false);
  assert.equal(newMarkerCleared({ fresh: false }, { fresh: false }), false);
  assert.equal(newMarkerCleared({ fresh: false }, { fresh: true }), false);
});

test("copies are ordered by their state version alone", () => {
  const c = (stateVersion: number) => ({ stateVersion });
  assert.equal(isNewerCopy(c(6), c(5)), true, "a higher state version wins");
  assert.equal(isNewerCopy(c(5), c(5)), false, "equal copies: neither is newer");
  assert.equal(isNewerCopy(c(4), c(5)), false);
  // The revision is for conflicts only: a copy with a higher revision but a lower state version is not newer.
  const higherRevision: ItemDTO = { ...base, revision: 9, stateVersion: 3 };
  const lowerRevision: ItemDTO = { ...base, revision: 5, stateVersion: 4 };
  assert.equal(isNewerCopy(higherRevision, lowerRevision), false);
});

test("a journal's author line of surnames and initials reads as names", () => {
  assert.equal(displayAuthors("Kaur; S.; Turin; T. C."), "Kaur S., Turin T. C.");
  assert.equal(displayAuthors("Meyer; J.-P.; Dubois; AB"), "Meyer J.-P., Dubois AB");
  assert.equal(displayAuthors("Jane Doe; John Smith; Ana Ruiz"), "Jane Doe, John Smith, Ana Ruiz");
  assert.equal(displayAuthors("Kaur; S.; Turin"), "Kaur, S., Turin", "a list that does not pair up is only given commas");
  assert.equal(displayAuthors("Jane Doe, John Smith"), "Jane Doe, John Smith");
  assert.equal(displayAuthors("Maria Popova"), "Maria Popova");
  assert.equal(displayAuthors(null), null);
});

test("only a video's excerpt loses its download mark and leading link lines", () => {
  assert.equal(itemExcerpt({ kind: "video", excerpt: "💾 Get it: https://shop.example/x A film about bridges." }), "A film about bridges.");
  assert.equal(itemExcerpt({ kind: "article", excerpt: "💾 Get it: https://shop.example/x A film about bridges." }), "💾 Get it: https://shop.example/x A film about bridges.");
  assert.equal(itemExcerpt({ kind: "video", excerpt: null }), null);
});

test("the To read page keeps only To read items, whatever its filter", () => {
  assert.equal(belongsInList({ ...base, workflow: "toread" }, "toread", "active"), true);
  assert.equal(belongsInList({ ...base, workflow: "finished" }, "toread", "active"), false, "marked Finished: leaves the To read page");
  assert.equal(belongsInList({ ...base, workflow: "finished" }, "toread", "all"), false);
  assert.equal(belongsInList({ ...base, workflow: "finished" }, "collection:col_1", "active"), true, "other pages go by their filter");
});

test("a reloaded copy keeps the newer state of the item, and its own content", () => {
  const finished: ItemDTO = { ...base, workflow: "finished", revision: 2, stateVersion: 6, fresh: false, opened: true, progress: 1 };
  const saved: ItemDTO = { ...base, title: "Renamed", workflow: "toread", revision: 1, stateVersion: 5 };
  const merged = withNewerState(saved, finished);
  assert.deepEqual([merged.workflow, merged.revision, merged.stateVersion, merged.fresh, merged.opened, merged.progress], ["finished", 2, 6, false, true, 1]);
  assert.equal(merged.title, "Renamed");
  const fresher: ItemDTO = { ...base, workflow: "new", stateVersion: 7 };
  assert.equal(withNewerState(fresher, finished), fresher, "a newer answer wins as it is");
  assert.equal(withNewerState(saved, undefined), saved);
});
