import { test } from "node:test";
import assert from "node:assert/strict";
import { app } from "@purss/translations/app";
import { plural } from "../lib/format.ts";
import { droppedLine, sentLine } from "./messages.ts";

const t = app.outbox.messages;

test("late results are said once, plainly", () => {
  assert.equal(sentLine(1), t.sentOne);
  assert.equal(sentLine(4), t.sentMany(plural(4, app.words.change)));
  const one = { reason: "conflict", message: app.outbox.entries.conflict } as const;
  assert.equal(droppedLine([one]), app.outbox.entries.conflict);
  assert.equal(droppedLine([one, one, one]), t.conflicts(3));
  assert.equal(droppedLine([one, { reason: "rejected", message: app.outbox.entries.rejected("That item wasn't found.") }]), t.notApplied(plural(2, app.words.change)));
});
