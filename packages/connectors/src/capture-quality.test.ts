import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessCapture, partialReasonText } from "./capture-quality.ts";

// The first three are invented text shaped like real captures: a journal paper that came out as its reference list,
// a news paywall notice and a members-only notice.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/captures/${name}`, import.meta.url), "utf8");

const paragraph = (n: number) => `Paragraph ${n} of an article about sediment moving down a river in spring, with its own sentences and details to read. `.repeat(3).trim();
const article = (paragraphs: number) => Array.from({ length: paragraphs }, (_, i) => paragraph(i + 1)).join("\n\n");

test("a journal page whose capture is the reference list is only part of the page", () => {
  const verdict = assessCapture({ text: fixture("esurf-references.txt"), feedTextLength: 800 });
  assert.deepEqual(verdict, { full: false, reason: "references" });
});

test("a subscription page captured in place of the article is only part of the page", () => {
  assert.deepEqual(assessCapture({ text: fixture("marsactu-paywall.txt"), feedTextLength: 350 }), { full: false, reason: "gated" });
  // Whatever the feed gave: the wall is the wall.
  assert.deepEqual(assessCapture({ text: fixture("marsactu-paywall.txt"), feedTextLength: 0 }), { full: false, reason: "gated" });
});

test("a members-only notice captured in place of the post is only part of the page, even when the feed's post is shorter", () => {
  assert.deepEqual(assessCapture({ text: fixture("kottke-members.txt"), feedTextLength: 97 }), { full: false, reason: "gated" });
});

test("walls in other languages and cookie pages are recognised", () => {
  const walls = [
    "Zum Weiterlesen bitte anmelden. Dieser Artikel ist nur für Abonnenten.",
    "Contenido solo para suscriptores. Suscríbete para seguir leyendo.",
    "Riservato agli abbonati. Accedi per leggere l'articolo completo.",
    "Dit artikel is alleen voor abonnees. Log in om verder te lezen.",
    "We use cookies to improve your experience. Accept all cookies or manage cookie settings.",
    "Checking your browser before accessing the site. Please verify you are a human.",
    "Subscribe to continue reading. Already a subscriber? Sign in.",
  ];
  for (const text of walls) assert.deepEqual(assessCapture({ text, feedTextLength: 0 }), { full: false, reason: "gated" }, text);
});

test("an article that is cut off by a wall near its start is only part of the page", () => {
  const text = `${paragraph(1)}\n\n${paragraph(2)}\n\nSubscribe to continue reading this article. Already a subscriber? Sign in.`;
  assert.ok(text.length < 1500);
  assert.deepEqual(assessCapture({ text, feedTextLength: 0 }), { full: false, reason: "gated" });
});

test("a whole article passes, with or without the feed's text, and whatever it says about newsletters and comments", () => {
  const body = article(12);
  assert.deepEqual(assessCapture({ text: body, feedTextLength: 0 }), { full: true });
  assert.deepEqual(assessCapture({ text: body, feedTextLength: 400 }), { full: true });
  const ends = `${body}\n\nSubscribe to our newsletter for the week's best reading.\n\nLog in to comment. Share this article.`;
  assert.deepEqual(assessCapture({ text: ends, feedTextLength: 400 }), { full: true });
  // A long article can quote the words of a wall without being one.
  const quoting = `${body}\n\nThe site told readers to subscribe to continue reading, and many did.\n\n${article(6)}`;
  assert.deepEqual(assessCapture({ text: quoting, feedTextLength: 0 }), { full: true });
});

test("an article with a reference list after its text passes; the references have to be most of it", () => {
  const references = Array.from({ length: 12 }, (_, i) => `Author${i}, A. B. and Other, C.: A study of rivers number ${i}, Earth Surf. Dynam., 10, 81–96, https://doi.org/10.5194/esurf-10-${i}-2022, 2022.`).join("\n\n");
  const paper = `${article(14)}\n\nReferences\n\n${references}`;
  assert.ok(references.length / paper.length < 0.4);
  assert.deepEqual(assessCapture({ text: paper, feedTextLength: 800 }), { full: true });
  assert.deepEqual(assessCapture({ text: `References\n\n${references}`, feedTextLength: 0 }), { full: false, reason: "references" });
  // Four references are a citation list inside a short text, not a reference page.
  assert.deepEqual(assessCapture({ text: references.split("\n\n").slice(0, 4).join("\n\n"), feedTextLength: 0 }), { full: true });
});

test("a capture shorter than what the feed already gave is only part of the page; a little shorter is not", () => {
  const feedLength = 3000;
  assert.deepEqual(assessCapture({ text: "x ".repeat(500), feedTextLength: feedLength }), { full: false, reason: "short" });
  // The page leaves out the site's footer that the feed carried: still the article.
  assert.deepEqual(assessCapture({ text: "x ".repeat(1200), feedTextLength: feedLength }), { full: true });
  // A feed that gave only a line says nothing about the page.
  assert.deepEqual(assessCapture({ text: "x ".repeat(100), feedTextLength: 150 }), { full: true });
});

/** An ordinary article paragraph about cookie rules: it names a cookie policy and accepting cookies, as prose. */
const COOKIE_EXPLAINER = "Since the European rules on tracking changed, almost every site asks visitors about cookies, and most of what they ask is badly designed. "
  + "Researchers who studied thousands of banners found that a site's cookie policy is usually longer than the privacy notice it replaced, that the button to accept all cookies is "
  + "often bigger and brighter than the one to refuse them, and that managing consent takes three or four clicks where agreeing takes one. The regulators' position is that "
  + "refusing must be as easy as accepting, which in practice means a visible reject button on the first screen, and a handful of countries have started to fine the sites that ignore this. "
  + "Publishers answer that they need the money from advertising, and that readers who decline tracking should pay with a subscription instead, which is how the pay-or-consent model arrived. "
  + "Whether that model is lawful is still being argued in court, and the answer will decide whether free reading with fewer cookies is possible at all, or whether the choice for most readers "
  + "will be between being followed around the web and paying for every site they visit. The people who work on the browsers are trying a third way, a single signal sent from the browser itself, "
  + "so that the question is asked once, in one place, and answered the same way everywhere, instead of once on every page by a different pop-up in a different corner of the screen. "
  + "Advertisers are not convinced, since a single signal is easy to turn off by default for everyone and then to argue about for years, and several large publishers have said they would ignore it "
  + "unless the law forces them to listen. Meanwhile the small sites, the ones run by one person after work, mostly copy a banner from somewhere and hope nobody reads the cookie policy "
  + "they pasted underneath it, because writing a real one would mean finding out what the embedded video player, the font service and the comment widget actually do with the visitors who load them. "
  + "That, more than any fine, is what the rules have changed: a lot of people now know what is on their own pages, and some of them have quietly taken the trackers out.";

test("an article that talks about cookie policies is an article, not a cookie page", () => {
  assert.ok(COOKIE_EXPLAINER.length > 1500, `a long paragraph, ${COOKIE_EXPLAINER.length} characters`);
  assert.deepEqual(assessCapture({ text: COOKIE_EXPLAINER, feedTextLength: 400 }), { full: true }, "alone");
  assert.deepEqual(assessCapture({ text: `${paragraph(1)}\n\n${COOKIE_EXPLAINER}\n\n${paragraph(2)}`, feedTextLength: 0 }), { full: true }, "among others");
  // A short text whose one long paragraph is the explainer is not a wall either: a wall is short blocks, or one block that is nothing else.
  const short = COOKIE_EXPLAINER.slice(0, 900);
  assert.deepEqual(assessCapture({ text: short, feedTextLength: 0 }), { full: true });
});

test("a consent page is a wall, whether it comes as short blocks or as one long block of nothing else", () => {
  const blocks = "We use cookies to improve your experience.\n\nAccept all cookies\n\nManage cookie settings";
  assert.deepEqual(assessCapture({ text: blocks, feedTextLength: 0 }), { full: false, reason: "gated" });
  const oneBlock = "We and our partners store and access information on your device and process personal data. We use cookies and similar technologies for analytics, personalised ads and content. "
    + "You can accept all cookies, reject all cookies, or manage your cookie settings at any time. Your choices apply to this site only, and you can read the cookie policy for details. "
    + "Accept all cookies to continue. Manage cookie preferences. Reject non-essential cookies. ".repeat(3);
  assert.deepEqual(assessCapture({ text: oneBlock, feedTextLength: 0 }), { full: false, reason: "gated" });
});

// Synthetic samples of what the first version of the rule got wrong, in both directions.
const INTRO = "The regional council voted on Tuesday night to approve a long-delayed plan to rebuild the harbour wall, ending two years of argument about who should pay for it. "
  + "Engineers say the work will take eighteen months and close the eastern quay to visitors for most of that time, while the fishing fleet moves to temporary berths further along the coast. "
  + "Local traders, who had warned that the closure would cost them the summer season, said they were relieved that a compensation scheme had been added at the last minute, although the final figures remain to be agreed. ";

test("a cut-off preview is a wall even when the call to subscribe shares its block with the intro", () => {
  for (const callToAction of ["Subscribe to read the full article.", "You've reached your free article limit. Create a free account or subscribe to keep reading.", "Sign in or subscribe to continue reading this story."]) {
    const text = INTRO + callToAction;
    assert.ok(text.length > 500 && text.length < 800, `one block over 500 characters (${text.length})`);
    assert.deepEqual(assessCapture({ text, feedTextLength: 0 }), { full: false, reason: "gated" }, callToAction);
  }
  // The same call to subscribe at the end of a long whole article is not enough: the preview is short.
  const whole = Array.from({ length: 30 }, (_, i) => `${INTRO.slice(0, 300)} (${i})`).join("\n\n");
  assert.deepEqual(assessCapture({ text: `${whole}\n\nSubscribe to read more from the council reporters.`, feedTextLength: 0 }), { full: true });
});

test("one long block that is nothing but a consent page is a wall", () => {
  const consent = "We and our 214 partners store and access information on your device, such as cookies and unique identifiers, and process personal data such as IP addresses and browsing data. "
    + "This lets us show personalised advertising and content, measure how well they perform, and understand the audiences that see them, and to develop and improve our services for everyone. "
    + "With your permission we and our partners may use precise geolocation data and identification through device scanning, and may store information on your device for the purposes below. "
    + "You can click to consent to the processing described above, or you can use cookies only where they are strictly necessary for the site to work. "
    + "We use cookies for these purposes, and you may change your choices at any time by returning to this page. "
    + "Some of the processing described here relies on our legitimate interests rather than on consent, and you have the right to object to it at any time, in which case we will stop unless we can show compelling reasons that outweigh your interests. "
    + "The purposes include storing and accessing information on a device, selecting basic and personalised advertising, creating profiles for personalised content, and measuring performance. "
    + "Your choices apply across our family of sites, which are listed in full in the partner list, together with the purposes each partner pursues and the length of time it keeps what it collects. "
    + "If you accept all cookies you agree to every purpose, and you can still manage cookie settings for individual partners from the preference centre, where each purpose can be switched on or off, and the cookie policy sets out what each one does. ";
  assert.ok(consent.length > 1520 && consent.length < 1900, `${consent.length}`);
  assert.deepEqual(assessCapture({ text: consent, feedTextLength: 0 }), { full: false, reason: "gated" });
});

test("a short piece about cookies is a piece, not a cookie page", () => {
  const brief = "Meta said on Monday that it will change its cookie policy for users in Europe from next month, giving people a clearer choice about how their activity on other sites is used to personalise advertising. "
    + "The company said the new policy follows talks with regulators in Ireland and Germany, and that users who do nothing will keep their current settings until they are asked again in the spring. "
    + "Privacy groups welcomed the change but said it came years too late, and that the company should have asked first.";
  assert.ok(brief.length > 350 && brief.length < 600, `${brief.length}`);
  assert.deepEqual(assessCapture({ text: brief, feedTextLength: 0 }), { full: true });
  const advice = "Never accept all cookies just because a banner makes it the easy button. The sites that make refusing hard are the ones that most want the data, and a few extra clicks cost you less than a year of tracking. "
    + "Look for the smaller link beside the big one, choose the necessary cookies only, and your browser will remember the choice for next time. If a site will not let you in without agreeing, close the tab.";
  assert.ok(advice.length > 250 && advice.length < 500, `${advice.length}`);
  assert.deepEqual(assessCapture({ text: advice, feedTextLength: 0 }), { full: true });
});

test("every reason has words the reader can show", () => {
  for (const reason of ["gated", "references", "short"] as const) assert.match(partialReasonText(reason), /^Only part of the page could be saved: /);
});
