import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { cleanVideoExcerpt, isBoilerplateLine, skipLeadingBoilerplate } from "./feed-text.ts";

test("links, sponsor pitches and empty lines are boilerplate; a description of the video is not", () => {
  assert.equal(isBoilerplateLine(""), true);
  assert.equal(isBoilerplateLine("https://example.com/shop"), true);
  assert.equal(isBoilerplateLine("🖐 ► https://www.youtube.com/noogai89/join"), true);
  assert.equal(isBoilerplateLine("Get Pixicade here: https://www.abacusbrands.com/products/draw"), true);
  assert.equal(isBoilerplateLine("This video is sponsored by NordVPN. Get 70% off at nordvpn.com/x"), true);
  assert.equal(isBoilerplateLine("Thanks to Squarespace for sponsoring this video"), true);
  assert.equal(isBoilerplateLine("Use code BRIDGES for 20% off"), true);
  assert.equal(isBoilerplateLine("Join the Discord", true), true);
  assert.equal(isBoilerplateLine("We made a thing about bridges and how they hold up."), false);
  assert.equal(isBoilerplateLine("The sponsored posts of 2019 were a mistake, and here is why."), false);
  // A long line that happens to carry a link is the description itself.
  assert.equal(isBoilerplateLine("In this episode we walk the whole length of the old canal and look at every bridge on it, with notes at https://example.com/notes"), false);
});

test("an excerpt loses the download mark and the link lines in front of the description", () => {
  assert.equal(cleanVideoExcerpt("💾 💡 Idea & Writer: @its_me_skim 🔶 Animation: @its_me_skim"), "💡 Idea & Writer: @its_me_skim 🔶 Animation: @its_me_skim");
  assert.equal(
    cleanVideoExcerpt("💾 Get Pixicade Here: https://www.abacusbrands.com/products/draw 🖐 BECOME A MEMBER! ► https://www.youtube.com/noogai89/join A short film about animation and games."),
    "A short film about animation and games.");
  assert.equal(cleanVideoExcerpt("This video is sponsored by NordVPN. Get 70% off at https://nordvpn.com/x We made a thing about bridges."), "We made a thing about bridges.");
  assert.equal(cleanVideoExcerpt("💾 Something lives here... 🖐 BECOME A MEMBER! ► https://www.youtube.com/noogai89/join"), "Something lives here... 🖐 BECOME A MEMBER! ► https://www.youtube.com/noogai89/join");
});

test("an excerpt that is only links is kept, without the mark", () => {
  assert.equal(cleanVideoExcerpt("💾 https://a.example/x https://b.example/y"), "https://a.example/x https://b.example/y");
  assert.equal(cleanVideoExcerpt(null), null);
  assert.equal(cleanVideoExcerpt(""), "");
});

function lead(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  skipLeadingBoilerplate(document.body as unknown as Element);
  return document.body.innerHTML;
}

test("a description drops its leading link and sponsor lines, up to the first real line", () => {
  assert.equal(
    lead("<figure><figcaption>Get the kit: https://shop.example/kit<br>\n<br>\nThis video is sponsored by NordVPN.<br>\nWe made a thing about bridges.<br>https://example.com</figcaption></figure>"),
    "<figure><figcaption>\nWe made a thing about bridges.<br>https://example.com</figcaption></figure>");
});

test("a paragraph that is only links goes whole when text follows", () => {
  assert.equal(lead("<p>https://a.example</p><p>The actual description.</p>"), "<p>The actual description.</p>");
  assert.equal(lead("<p><a href=\"https://a.example\">Join</a><br>Real words here.</p>"), "<p>Real words here.</p>");
});

test("a description of only links and sponsor lines is left as it is", () => {
  assert.equal(lead("<p>https://a.example</p>"), "<p>https://a.example</p>");
  assert.equal(lead("<p>Use code BRIDGES<br>https://a.example</p>"), "<p>Use code BRIDGES<br>https://a.example</p>");
});

test("a description that opens with real text is left as it is", () => {
  const html = "<p>Bridges are older than you think.<br>https://example.com</p>";
  assert.equal(lead(html), html);
});

test("a video whose description is only the download mark has no excerpt", () => {
  assert.equal(cleanVideoExcerpt("\u{1F4BE}"), null);
  assert.equal(cleanVideoExcerpt("  \u{1F4BE}  "), null);
});
