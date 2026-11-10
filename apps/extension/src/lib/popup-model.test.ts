import test from "node:test";
import assert from "node:assert/strict";
import type { UrlLookup } from "@purss/domain";
import { followLine, initialBasket, keepButton, keptLine, sourceOffers, statusLine, textHint } from "./popup-model.ts";

const reading = { id: "bsk_r", name: "Reading" };
const papers = { id: "bsk_p", name: "Papers" };
const later = { id: "bsk_l", name: "Later" };
const none: UrlLookup = { item: null, followedSources: [] };
const have = (baskets: { id: string; name: string }[], browserCapturedAt: string | null = null): UrlLookup => ({
  item: { id: "itm_1", title: "T", url: "https://a.example/", workflow: "new", baskets, browserCapturedAt }, followedSources: [],
});

test("the status line says whether and where the page is kept", () => {
  assert.deepEqual(statusLine(none), { kept: false, text: "Not in your PURSS yet" });
  assert.deepEqual(statusLine(have([])), { kept: false, text: "In your PURSS, not kept in a basket" });
  assert.deepEqual(statusLine(have([reading])), { kept: true, text: "Kept in Reading" });
  assert.deepEqual(statusLine(have([reading, papers, later])), { kept: true, text: "Kept in Reading, Papers and Later" });
  assert.equal(followLine(none), null);
  assert.equal(followLine({ item: null, followedSources: [{ id: "s1", title: "Tidal Notes" }, { id: "s2", title: "Quiet Harbour" }] }), "You follow Tidal Notes and Quiet Harbour on this site");
});

test("the basket picker starts where the person kept last, if that basket still exists", () => {
  assert.equal(initialBasket([reading, papers], "bsk_p"), "bsk_p");
  assert.equal(initialBasket([reading, papers], "bsk_gone"), "bsk_r");
  assert.equal(initialBasket([], "bsk_p"), null);
});

test("the Keep button has nothing to do when the page is already in that basket, unless its text is wanted", () => {
  assert.deepEqual(keepButton(none, reading, false), { label: "Keep in Reading", enabled: true });
  assert.deepEqual(keepButton(have([reading]), reading, false), { label: "Already in Reading", enabled: false });
  assert.deepEqual(keepButton(have([reading]), reading, true), { label: "Keep its text", enabled: true });
  assert.deepEqual(keepButton(have([reading]), papers, false), { label: "Keep in Papers", enabled: true });
  assert.deepEqual(keepButton(null, null, false), { label: "Keep", enabled: false });
  assert.match(textHint(none, (d) => d), /as your browser shows it/);
  assert.match(textHint(have([], "2026-11-03T10:00:00.000Z"), () => "3 Nov"), /Replaces the text kept from your browser on 3 Nov/);
});

test("after keeping, one line says what happened, including to the text", () => {
  const base = { itemId: "itm_1", captureQueued: false, captureNote: null };
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false }, "Reading"), "Kept in Reading");
  assert.equal(keptLine({ ...base, existing: true, alreadyInBasket: false }, "Reading"), "Kept in Reading (you already had this page)");
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false }, "Reading", "empty"), "Kept in Reading. No readable text was found on the page, so only the link was kept.");
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false }, "Reading", "too_large"), "Kept in Reading. The page's text is too long to keep, so only the link was kept.");
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false, textSaved: true, textReplaced: false, textNote: null }, "Reading"), "Kept in Reading. Its text was saved as your browser shows it.");
  assert.equal(keptLine({ ...base, existing: true, alreadyInBasket: true, textSaved: true, textReplaced: true, textNote: null }, "Reading"), "Already in Reading. Its text was replaced with what you see now.");
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false, textSaved: false, textReplaced: false, textNote: "There isn't enough storage for the text, so only the link was kept." }, "Reading"),
    "Kept in Reading. There isn't enough storage for the text, so only the link was kept.");
  assert.equal(keptLine({ ...base, captureNote: "Kept with its details and feed content. A readable copy wasn't made because this workspace is out of space.", existing: false, alreadyInBasket: false }, "Archive"),
    "Kept in Archive. Kept with its details and feed content. A readable copy wasn't made because this workspace is out of space.");
});

test("Add as a source offers the channel or the advertised feeds, and nothing otherwise", () => {
  assert.deepEqual(sourceOffers(null), []);
  assert.deepEqual(sourceOffers({ feeds: [], youtube: null }), []);
  assert.deepEqual(sourceOffers({ feeds: [{ url: "https://q.example/feed", title: "Quiet Harbour" }, { url: "https://q.example/c", title: null }], youtube: null }),
    [{ label: "Follow “Quiet Harbour”", url: "https://q.example/feed" }, { label: "Follow feed 2", url: "https://q.example/c" }]);
  assert.deepEqual(sourceOffers({ feeds: [{ url: "https://q.example/feed", title: null }], youtube: null }), [{ label: "Follow this site", url: "https://q.example/feed" }]);
  assert.deepEqual(sourceOffers({ feeds: [], youtube: { url: "https://www.youtube.com/@t", name: "Tide Tables", exact: true } }), [{ label: "Follow Tide Tables", url: "https://www.youtube.com/@t" }]);
  assert.deepEqual(sourceOffers({ feeds: [], youtube: { url: "https://www.youtube.com/watch?v=x", name: null, exact: false } }), [{ label: "Follow this video's channel", url: "https://www.youtube.com/watch?v=x" }]);
});
