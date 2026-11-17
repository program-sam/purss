import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { removeConsentBanners } from "./consent-banners.ts";
import type { ConsentDocument } from "./consent-banners.ts";

const BODY = `<main><article><h1>Title</h1><p>${"The article text goes on for a good while. ".repeat(30)}</p></article></main>`;

function strip(markup: string): { removed: number; html: string } {
  const { document } = parseHTML(`<!DOCTYPE html><html><head><title>t</title></head>${markup}</html>`);
  const removed = removeConsentBanners(document as unknown as ConsentDocument);
  return { removed, html: document.documentElement.outerHTML };
}

test("the banners of the common consent tools and of GOV.UK are taken out, by the names the markup gives them", () => {
  for (const banner of [
    `<section class="govuk-cookie-banner" aria-label="Cookies on Find an apprenticeship"><p>x</p></section>`,
    `<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk">x</div></div>`,
    `<div id="CybotCookiebotDialog">x</div>`,
    `<div class="cc-window cc-banner cc-type-info">x</div>`,
    `<div id="didomi-host">x</div>`,
    `<div id="usercentrics-root">x</div>`,
    `<div class="qc-cmp2-container">x</div>`,
    `<div id="sp_message_container_12345">x</div>`,
    `<div id="cmplz-cookiebanner-container">x</div>`,
    `<div id="cookie-law-info-bar">x</div>`,
    `<div class="cookie-notice-container" id="cookie-notice">x</div>`,
    `<div class="js-cookie-consent cookie-consent">x</div>`,
    `<div class="gdpr-banner">x</div>`,
    `<div class="CookieBanner__root">x</div>`,
    `<div aria-label="Cookie settings">x</div>`,
    `<div aria-label="Cookies">x</div>`,
  ]) {
    const { removed, html } = strip(`<body>${banner}${BODY}</body>`);
    assert.ok(removed >= 1, banner);
    assert.doesNotMatch(html, />x</, banner);
    assert.match(html, /The article text goes on/, banner);
  }
});

test("a banner inside another is taken out once, and the rest of the page is untouched", () => {
  const { removed, html } = strip(`<body><div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk"><p>gone</p></div></div>${BODY}<footer><a href="/cookies">Cookies</a></footer></body>`);
  assert.equal(removed, 2 - 1 + 1 - 1 + 0 + 0 + 1 - 1 + 0 + 0 + 0 + 1 - 1 + 1 - 1, "the outer block counts, and the one inside it was already gone with it");
  assert.doesNotMatch(html, /gone/);
  assert.match(html, /<a href="\/cookies">Cookies<\/a>/, "a footer link about cookies is not a banner");
});

test("what only mentions cookies, or carries a banner's state, is not a banner", () => {
  for (const markup of [
    `<body class="cookie-banner-open">${BODY}</body>`,
    `<html class="has-cookie-banner"><body>${BODY}</body></html>`,
    `<body><div class="page has-cookie-banner"><div class="cookie-banner-visible-wrapper">${BODY}</div></div></body>`,
    `<body><div id="cookie-banner-open">${BODY}</div></body>`,
    `<body><div class="cookie-banner">${BODY}</div></body>`,
    `<body><div class="recipes cookie-recipes">${BODY}</div></body>`,
    `<body><nav aria-label="Cookie recipes"><a href="/a">Oatmeal</a></nav>${BODY}</body>`,
    `<body><section class="cookie-policy"><h2>Our cookie policy</h2><p>${"We explain cookies here. ".repeat(40)}</p></section></body>`,
  ]) {
    const { removed, html } = strip(markup);
    assert.equal(removed, 0, markup.slice(0, 80));
    assert.match(html, /The article text goes on|We explain cookies here/, markup.slice(0, 80));
  }
});

test("a block that is the page's own content is never taken out, whatever its class says, as one that holds it is not", () => {
  for (const markup of [
    `<body><div role="main" class="cookie-consent"><h1>Vacancy</h1><p>Closing date: Friday.</p></div></body>`,
    `<body><div itemprop="articleBody" class="consent-banner"><p>The notice itself, which is short.</p></div><p>Home</p></body>`,
    `<body><section role="main" id="cookie-notice"><p>Short page.</p></section><p>Home</p></body>`,
    `<body><div class="cookie-consent"><div role="main"><p>Short page.</p></div></div><p>Home</p></body>`,
  ]) {
    const { removed, html } = strip(markup);
    assert.equal(removed, 0, markup);
    assert.match(html, /Closing date|The notice itself|Short page/, markup);
  }
  // A banner next to the content still goes.
  const { removed, html } = strip(`<body><div class="cookie-consent"><p>gone</p></div><div role="main" class="cookie-consent"><p>kept words</p></div></body>`);
  assert.equal(removed, 1);
  assert.doesNotMatch(html, /gone/);
  assert.match(html, /kept words/);
});

test("a block called a banner that is most of the page's text is left for the capture check to name", () => {
  const { removed } = strip(`<body><div class="cookie-banner"><p>${"We use cookies. ".repeat(60)}</p></div><p>Home</p></body>`);
  assert.equal(removed, 0);
});
