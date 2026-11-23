import test from "node:test";
import assert from "node:assert/strict";
import type { UrlLookup } from "@purss/domain";
import { extension } from "@purss/translations/extension";
import { followLine, initialBasket, keepButton, keptLine, sourceOffers, statusLine, textHint } from "./popup-model.ts";

const reading = { id: "bsk_r", name: "Reading" };
const papers = { id: "bsk_p", name: "Papers" };
const later = { id: "bsk_l", name: "Later" };
const none: UrlLookup = { item: null, followedSources: [] };
const have = (baskets: { id: string; name: string }[], browserCapturedAt: string | null = null): UrlLookup => ({
  item: { id: "itm_1", title: "T", url: "https://a.example/", workflow: "undecided", baskets, browserCapturedAt }, followedSources: [],
});

const t = extension.popup;

test("the status line says whether and where the page is kept", () => {
  assert.deepEqual(statusLine(none), { kept: false, text: t.status.notYet });
  assert.deepEqual(statusLine(have([])), { kept: false, text: t.status.inYourPurss });
  assert.deepEqual(statusLine(have([reading])), { kept: true, text: t.status.keptIn(t.names(["Reading"])) });
  assert.deepEqual(statusLine(have([reading, papers, later])), { kept: true, text: t.status.keptIn(t.names(["Reading", "Papers", "Later"])) });
  assert.equal(followLine(none), null);
  assert.equal(followLine({ item: null, followedSources: [{ id: "s1", title: "Tidal Notes" }, { id: "s2", title: "Quiet Harbour" }] }), t.following(t.names(["Tidal Notes", "Quiet Harbour"])));
});

test("the basket picker starts where the person kept last, if that basket still exists", () => {
  assert.equal(initialBasket([reading, papers], "bsk_p"), "bsk_p");
  assert.equal(initialBasket([reading, papers], "bsk_gone"), "bsk_r");
  assert.equal(initialBasket([], "bsk_p"), null);
});

test("the Keep button has nothing to do when the page is already in that basket, unless its text is wanted", () => {
  assert.deepEqual(keepButton(none, reading, false), { label: t.keepButton.keepIn("Reading"), enabled: true });
  assert.deepEqual(keepButton(have([reading]), reading, false), { label: t.keepButton.alreadyIn("Reading"), enabled: false });
  assert.deepEqual(keepButton(have([reading]), reading, true), { label: t.keepButton.keepText, enabled: true });
  assert.deepEqual(keepButton(have([reading]), papers, false), { label: t.keepButton.keepIn("Papers"), enabled: true });
  assert.deepEqual(keepButton(null, null, false), { label: t.keep.button, enabled: false });
  assert.equal(textHint(none, (d) => d), t.textHint.saves);
  assert.equal(textHint(have([], "2026-11-03T10:00:00.000Z"), () => "3 Nov"), t.textHint.replaces("3 Nov"));
});

test("after keeping, one line says what happened, including to the text", () => {
  const base = { itemId: "itm_1", captureQueued: false, captureNote: null };
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false }, "Reading"), t.kept.keptIn("Reading"));
  assert.equal(keptLine({ ...base, existing: true, alreadyInBasket: false }, "Reading"), t.kept.keptAgain("Reading"));
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false }, "Reading", "empty"), `${t.kept.keptIn("Reading")}. ${t.missingText.empty}`);
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false }, "Reading", "too_large"), `${t.kept.keptIn("Reading")}. ${t.missingText.too_large}`);
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false, textSaved: true, textReplaced: false, textNote: null }, "Reading"), `${t.kept.keptIn("Reading")}. ${t.kept.textSaved}`);
  assert.equal(keptLine({ ...base, existing: true, alreadyInBasket: true, textSaved: true, textReplaced: true, textNote: null }, "Reading"), `${t.kept.alreadyIn("Reading")}. ${t.kept.textReplaced}`);
  assert.equal(keptLine({ ...base, existing: false, alreadyInBasket: false, textSaved: false, textReplaced: false, textNote: "There isn't enough storage for the text, so only the link was kept." }, "Reading"),
    `${t.kept.keptIn("Reading")}. There isn't enough storage for the text, so only the link was kept.`);
  assert.equal(keptLine({ ...base, captureNote: "Kept with its details and feed content. A readable copy wasn't made because this account is out of space.", existing: false, alreadyInBasket: false }, "Archive"),
    `${t.kept.keptIn("Archive")}. Kept with its details and feed content. A readable copy wasn't made because this account is out of space.`);
});

test("Add as a source offers the channel or the advertised feeds, and nothing otherwise", () => {
  assert.deepEqual(sourceOffers(null), []);
  assert.deepEqual(sourceOffers({ feeds: [], youtube: null }), []);
  assert.deepEqual(sourceOffers({ feeds: [{ url: "https://q.example/feed", title: "Quiet Harbour" }, { url: "https://q.example/c", title: null }], youtube: null }),
    [{ label: t.offers.followFeedTitled("Quiet Harbour"), url: "https://q.example/feed" }, { label: t.offers.followFeed(2), url: "https://q.example/c" }]);
  assert.deepEqual(sourceOffers({ feeds: [{ url: "https://q.example/feed", title: null }], youtube: null }), [{ label: t.offers.followSite, url: "https://q.example/feed" }]);
  assert.deepEqual(sourceOffers({ feeds: [], youtube: { url: "https://www.youtube.com/@t", name: "Tide Tables", exact: true } }), [{ label: t.offers.followChannel("Tide Tables"), url: "https://www.youtube.com/@t" }]);
  assert.deepEqual(sourceOffers({ feeds: [], youtube: { url: "https://www.youtube.com/watch?v=x", name: null, exact: false } }), [{ label: t.offers.followVideoChannel, url: "https://www.youtube.com/watch?v=x" }]);
});
