import assert from "node:assert/strict";
import { test } from "node:test";
import { initialsFor } from "./initials.ts";

test("a source's initials are its title's first two words' first letters, or a one-word title's first two letters", () => {
  assert.equal(initialsFor("Welcome to Night Vale"), "WT");
  assert.equal(initialsFor("xkcd"), "XK");
  assert.equal(initialsFor("Hand-Tool Rescue"), "HT");
  assert.equal(initialsFor("“Élan” journal"), "ÉJ");
  assert.equal(initialsFor("!!!"), "?");
});
