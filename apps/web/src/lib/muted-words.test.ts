import test from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/copy/app";
import { hiddenByMuted, muteUntil, mutedNoticeShown, withMutedWord } from "./muted-words.ts";

const t = app.lib.mutedWords;

test("a word mutes for a week, a month or until removed", () => {
  const now = new Date("2026-11-06T10:00:00.000Z");
  assert.equal(muteUntil("week", now), "2026-11-13T10:00:00.000Z");
  assert.equal(muteUntil("month", now), "2026-12-06T10:00:00.000Z");
  assert.equal(muteUntil("forever", now), null);
});

test("adding a word again, in any case, replaces it rather than listing it twice", () => {
  const list = withMutedWord([{ text: "Football", until: null }, { text: "bake off", until: "2026-12-01T00:00:00.000Z" }], " football ", "2026-11-13T00:00:00.000Z");
  assert.deepEqual(list, [{ text: "bake off", until: "2026-12-01T00:00:00.000Z" }, { text: "football", until: "2026-11-13T00:00:00.000Z" }]);
});

test("the notice says how many items muted words left out, and 'at least' when only part of a long list was counted", () => {
  assert.equal(hiddenByMuted(1, false), t.hidden(1, "1", false));
  assert.equal(hiddenByMuted(3, false), t.hidden(3, "3", false));
  assert.equal(hiddenByMuted(1200, false), t.hidden(1200, "1,200", false));
  assert.equal(hiddenByMuted(12, true), t.hidden(12, "12", true));
  assert.equal(hiddenByMuted(0, true), t.furtherDown, "none among those counted, but the count stopped early");
});

test("the notice stays whenever items were left out, may have been, or are being shown", () => {
  assert.equal(mutedNoticeShown(0, false, false), false, "nothing was left out");
  assert.equal(mutedNoticeShown(3, false, false), true);
  assert.equal(mutedNoticeShown(0, true, false), true, "the count stopped early and found none: the way to show them stays");
  assert.equal(mutedNoticeShown(0, false, true), true, "while they are shown, the way to hide them again");
});
