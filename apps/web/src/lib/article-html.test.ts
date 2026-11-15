import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { isCitationLead, prepareArticleHtml, showStoredPictures } from "./article-html.ts";

/** The browser's DOMParser for a fragment: the markup lands in a body, as it does there. */
(globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
  parseFromString(html: string): Document { return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document; }
};

test("a journal citation paragraph is recognised, ordinary text is not", () => {
  assert.equal(isCitationLead("Nature, Published online: 04 November 2026; doi:10.1038/d41586-026-03544-8"), true);
  assert.equal(isCitationLead("  Nature Physics, Published online: 1 May 2026;  doi:10.1038/s41567-026-0001-x "), true);
  assert.equal(isCitationLead("Nature, Published online: 04 November 2026; doi:10.1038/d41586-026-03544-8 It might seem"), false);
  assert.equal(isCitationLead("We published online: a note; doi is a word"), false);
  assert.equal(isCitationLead("It might seem counterproductive to put more people in nature."), false);
});

const YOUTUBE = `<figure><p><img src="https://i1.ytimg.com/vi/dz04yXwSkQY/hqdefault.jpg" alt="" title="Animation vs. Game Design" /></p>`
  + `<p><a href="https://www.youtube.com/v/dz04yXwSkQY?version=3" title="Animation vs. Game Design">💾</a></p>`
  + `<figcaption>Get Pixicade Here: https://www.abacusbrands.com/products/draw<br />\n<br />\n🖐 BECOME A MEMBER! ► https://www.youtube.com/noogai89/join <br />\n<br />\nA short film about animation and games.</figcaption></figure>`;

test("a video's description loses the download mark, the thumbnail the reader already shows, and the link lines it opens with", () => {
  const html = prepareArticleHtml(YOUTUBE, { video: { pictureUrl: "https://i3.ytimg.com/vi/dz04yXwSkQY/maxresdefault.jpg" } });
  assert.ok(!html.includes("💾"), "no download mark");
  assert.ok(!html.includes("youtube.com/v/"), "no link to the dead media address");
  assert.ok(!html.includes("<img"), "the picture is the same video's, so it is not shown twice");
  assert.ok(!html.includes("Pixicade") && !html.includes("BECOME A MEMBER"), "the link lines in front are gone");
  assert.ok(html.includes("A short film about animation and games."), "the description is kept");
});

test("another picture stays; a description that is not a video's is not touched", () => {
  const other = prepareArticleHtml(YOUTUBE, { video: { pictureUrl: "https://i1.ytimg.com/vi/someOtherVideo/hqdefault.jpg" } });
  assert.ok(other.includes("<img"), "a picture that is not the one shown above stays");
  const article = prepareArticleHtml(YOUTUBE);
  assert.ok(article.includes("💾") && article.includes("Pixicade"), "without video, the feed's own text is shown as it came");
});

test("a picture kept with the copy is shown from what the platform gives for its address; a planted marker is not trusted", async () => {
  const html = prepareArticleHtml(`<p><img src="/api/items/itm_1/images/img_2" alt="Chart"></p><p><img src="https://pub.example/a.png" data-stored-src="/api/items/itm_9/images/img_9"></p><img src="/elsewhere.png">`);
  const { document } = parseHTML(`<!doctype html><html><body><div id="prose">${html}</div></body></html>`);
  const imgs = [...document.querySelectorAll("img")];
  assert.equal(imgs.length, 2, "a picture at no https address and not stored is dropped");
  assert.equal(imgs[0]!.getAttribute("src"), null, "the page doesn't ask its own origin for PURSS's path");
  assert.equal(imgs[1]!.getAttribute("src"), "https://pub.example/a.png");
  assert.equal(imgs[1]!.getAttribute("data-stored-src"), null);

  const asked: string[] = [];
  showStoredPictures(document.getElementById("prose")!, (path) => { asked.push(path); return `blob:app/${path.split("/").pop()}`; });
  assert.deepEqual(asked, ["/api/items/itm_1/images/img_2"]);
  assert.equal(imgs[0]!.getAttribute("src"), "blob:app/img_2");

  const { document: later } = parseHTML(`<!doctype html><html><body><div id="prose">${html}</div></body></html>`);
  showStoredPictures(later.getElementById("prose")!, () => Promise.reject(new Error("offline")));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(later.querySelectorAll("img").length, 1, "a kept picture that can't be fetched leaves no broken image");
});
