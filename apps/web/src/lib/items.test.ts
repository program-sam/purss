import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@purss/domain";
import { belongsInList, displayAuthors, isNewerCopy, isTimeBased, itemExcerpt, newMarkerCleared, isYouTube, itemDate, lengthText, matchesFilter, itemPicture, playerArtwork, publishedApart, safeHref, safeImage, withNewerState } from "./items.ts";
import { workflowLabel } from "./constants.ts";

const base: ItemDTO = {
  id: "itm_x", number: 1, sourceId: "src_x", sourceTitle: "S", kind: "article", title: "T", url: "https://example.com/a", author: null, excerpt: null, imageUrl: null,
  durationSeconds: null, readMinutes: 4, doi: null, publishedAt: null, discoveredAt: "2026-11-03T08:00:00Z", listedAt: "2026-11-03T08:00:00Z", workflow: "new", revision: 0, workflowRevision: 0, playbackWorkflowSessionId: null, stateVersion: 4, fresh: true,
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

test("an item's date is its time in lists; the publisher's date is shown apart only when it is more than an hour away", () => {
  const late = { ...base, publishedAt: "2026-11-03T03:27:00Z", listedAt: "2026-11-03T17:48:00Z" };
  assert.equal(itemDate(late), "2026-11-03T17:48:00Z");
  assert.equal(publishedApart(late), "2026-11-03T03:27:00Z");
  assert.equal(publishedApart({ ...late, publishedAt: "2026-11-03T17:00:00Z" }), null, "within the hour: one date is enough");
  assert.equal(publishedApart({ ...late, publishedAt: "2026-11-03T17:48:00Z" }), null, "listed at its publication date (back catalogue)");
  assert.equal(publishedApart(base), null, "no publication date");
  // A copy saved on the device by a build whose items had no listedAt.
  const saved = { ...base, publishedAt: "2026-11-01T00:00:00Z" } as Partial<ItemDTO>;
  delete saved.listedAt;
  assert.equal(itemDate(saved as ItemDTO), "2026-11-01T00:00:00Z");
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
  assert.equal(belongsInList({ ...base, workflow: "inprogress" }, "toread", "active"), true, "started: stays on the page, first among what is waiting");
  assert.equal(belongsInList({ ...base, workflow: "inprogress" }, "toread", "inprogress"), true);
  assert.equal(belongsInList({ ...base, workflow: "inprogress" }, "toread", "toread"), false, "the To read filter is what has not been started");
  assert.equal(belongsInList({ ...base, workflow: "new" }, "toread", "active"), false, "not put aside or started");
  assert.equal(belongsInList({ ...base, workflow: "ignored" }, "toread", "all"), false);
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

test("a podcast episode without a picture of its own shows the show's art; nothing else borrows its source's picture", () => {
  const art = "/api/sources/src_1/icon?v=0123456789abcdef";
  assert.equal(itemPicture({ kind: "podcast", imageUrl: null }, art), art);
  assert.equal(itemPicture({ kind: "podcast", imageUrl: "https://cdn.example/ep.jpg" }, art), "https://cdn.example/ep.jpg", "its own picture first");
  assert.equal(itemPicture({ kind: "podcast", imageUrl: "http://cdn.example/ep.jpg" }, art), art, "a picture the page may not show is no picture");
  assert.equal(itemPicture({ kind: "podcast", imageUrl: null }, null), null);
  assert.equal(itemPicture({ kind: "video", imageUrl: null }, art), null);
  assert.equal(itemPicture({ kind: "article", imageUrl: null }, art), null);
  for (const bad of ["https://evil.example/icon?v=1", "//evil.example/api/sources/a/icon?v=1", "/api/items/itm_1/images/img_1", "javascript:alert(1)", "/api/sources/../x/icon?v=1"]) {
    assert.equal(itemPicture({ kind: "podcast", imageUrl: null }, bad), null, bad);
  }
});

test("the player shows an https picture or the show's art as this app serves it, and nothing else", () => {
  const art = "/api/sources/src_1/icon?v=0123456789abcdef";
  assert.equal(playerArtwork(art), art, "an episode without a picture plays with the show's art");
  assert.equal(playerArtwork("https://cdn.example/ep.jpg"), "https://cdn.example/ep.jpg");
  assert.equal(playerArtwork(null), null);
  assert.equal(playerArtwork(undefined), null);
  for (const bad of ["http://cdn.example/ep.jpg", "//evil.example/api/sources/a/icon?v=1", "/api/items/itm_1/images/img_1", "/api/sources/a/icon", "/api/sources/../x/icon?v=1", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
    assert.equal(playerArtwork(bad), null, bad);
  }
});
