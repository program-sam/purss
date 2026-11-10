import { test } from "node:test";
import assert from "node:assert/strict";
import { firstStrong, hasRtl, isolate } from "./bidi.ts";

const ARABIC = "مرحبا بالعالم: ما الجديد؟";
const MIXED = "مقال عن Rotterdam وأمستردام";
const DUTCH = "Wat is er nieuw in Utrecht?";

test("the first strong letter decides the direction, digits and punctuation do not", () => {
  assert.equal(firstStrong(ARABIC), "rtl");
  assert.equal(firstStrong(DUTCH), "ltr");
  assert.equal(firstStrong(MIXED), "rtl");
  assert.equal(firstStrong("Rotterdam: مرحبا"), "ltr");
  assert.equal(firstStrong("2026 — «مرحبا»"), "rtl");
  assert.equal(firstStrong("שלום עולם"), "rtl");
  assert.equal(firstStrong("12:30 ... !?"), null);
  assert.equal(firstStrong(""), null);
});

test("hasRtl finds right-to-left letters anywhere", () => {
  assert.equal(hasRtl(DUTCH), false);
  assert.equal(hasRtl("Rotterdam en مرحبا"), true);
});

test("isolate wraps a name so a sentence around it keeps its punctuation in place", () => {
  assert.equal(isolate(ARABIC), `⁨${ARABIC}⁩`);
  assert.equal(isolate("Kept in " + ""), "⁨Kept in ⁩");
  assert.equal(`Kept in ${isolate("الأخبار")}.`, "Kept in ⁨الأخبار⁩.");
  assert.equal(isolate(""), "");
});

test("directional overrides that come with a title are removed", () => {
  // U+202E (right-to-left override) would reverse the text that follows it.
  assert.equal(isolate("report‮gpj.exe"), "⁨reportgpj.exe⁩");
  assert.equal(isolate("a⁦b⁩c"), "⁨abc⁩");
});
