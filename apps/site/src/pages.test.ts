import assert from "node:assert/strict";
import test from "node:test";
import * as copy from "@purss/translations/site";
import { PAGES, render, sitemap, type PageKey } from "./pages.ts";
import { siteFrom } from "./site.ts";

const site = siteFrom({});
/** Text as it stands in a page's source, ready for a regular expression. */
const literally = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keys = Object.keys(PAGES) as PageKey[];
const html = (key: PageKey, s = site) => render(s, key);
const text = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const VOID = new Set(["area", "br", "hr", "img", "input", "link", "meta", "wbr"]);
const INTERACTIVE = /^(a|button|input|select|textarea|summary|details)$/;

/** Controls inside a `role="img"` picture that assistive technology or the keyboard could still reach. */
function exposedInsidePictures(h: string): string[] {
  const found: string[] = [];
  const stack: { picture: boolean; hidden: boolean }[] = [];
  for (const m of h.replace(/<style>[\s\S]*?<\/style>/g, "").matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, close, tag, attrs] = m as unknown as [string, string, string, string];
    if (close) { stack.pop(); continue; }
    const insidePicture = stack.some((s) => s.picture);
    const hiddenAbove = stack.some((s) => s.hidden);
    const hidden = /\baria-hidden="true"/.test(attrs);
    if (insidePicture && !hiddenAbove && !hidden && (INTERACTIVE.test(tag) || /\b(tabindex|role)=/.test(attrs))) found.push(`<${tag}${attrs}>`);
    if (!VOID.has(tag) && !attrs.endsWith("/")) stack.push({ picture: /\brole="img"/.test(attrs), hidden });
  }
  return found;
}

test("every link goes somewhere: no bare # links, every #anchor exists, every site page is real", () => {
  const pages = new Set(Object.values(PAGES).map((p) => p.path));
  for (const key of keys) {
    const h = html(key);
    const ids = new Set([...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, href] of h.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g) as Iterable<[string, string]>) {
      assert.notEqual(href, "", `${key}: empty link`);
      assert.notEqual(href, "#", `${key}: link to #`);
      if (href.startsWith("#")) assert.ok(ids.has(href.slice(1)), `${key}: ${href} has no target`);
      else if (href.startsWith("/") && !href.startsWith("/app")) {
        const [path, hash] = href.split("#") as [string, string | undefined];
        assert.ok(pages.has(path), `${key}: ${href} is not a page of this site`);
        if (hash && path === PAGES.index.path) assert.ok(new Set([...html("index").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])).has(hash), `${key}: ${href} has no target`);
      } else assert.match(href, /^(\/app|https:\/\/)/, `${key}: ${href}`);
    }
  }
});

test("the sign-up and dashboard links go to the app, and the repository links follow SITE_REPO_URL", () => {
  const h = html("index", siteFrom({ SITE_APP_URL: "https://app.example.org", SITE_REPO_URL: "https://git.example.org/team/purss" }));
  assert.match(h, /href="https:\/\/app\.example\.org\/signup"/);
  assert.match(h, /href="https:\/\/app\.example\.org\/"/);
  assert.match(h, /href="https:\/\/git\.example\.org\/team\/purss\/blob\/main\/docs\/install\.md"/);
  assert.match(text(h).replace(/ /g, ""), /gitclonehttps:\/\/git\.example\.org\/team\/purss\.gitpurss/);
  assert.doesNotMatch(h, /&lt;repository&gt;|<repository>/);
});

test("every page's header has sign-up for visitors and Go to your PURSS for someone signed in", () => {
  for (const key of keys) {
    const nav = /<header class="(?:s|pf)-nav">[\s\S]*?<\/header>/.exec(html(key))?.[0] ?? "";
    assert.match(nav, /<a class="btn primary s-out" href="\/app\/signup">/, key);
    assert.ok(nav.includes(`<a class="btn primary s-in" href="/app/">${copy.kit.actions.signedIn}</a>`), key);
  }
});

test("pictures of PURSS keep their buttons away from assistive technology and the keyboard", () => {
  for (const key of keys) assert.deepEqual(exposedInsidePictures(html(key)), [], key);
  assert.ok((html("index").match(/role="img"/g) ?? []).length >= 1, "the home page shows its Home screen as a picture");
  // The checker itself finds an exposed control.
  assert.equal(exposedInsidePictures('<div role="img" aria-label="x"><button>Go</button></div>').length, 1);
  assert.equal(exposedInsidePictures('<div role="img" aria-label="x"><div aria-hidden="true"><button>Go</button></div></div>').length, 0);
});

test("pricing is two doors, you run it and we run it, and there is no separate self-hosting section", () => {
  const h = html("index");
  const at = (id: string) => h.indexOf(`id="${id}"`);
  assert.ok(at("apps") < at("pricing") && at("pricing") < at("self-host") && at("self-host") < at("faq"));
  assert.equal(h.match(/<section class="pf-sec" id="self-host"/g), null);
  const pricing = h.slice(at("pricing"), at("faq"));
  assert.ok(pricing.includes(copy.home.pricing.youRunIt));
  assert.ok(pricing.includes(copy.home.pricing.weRunIt));
  assert.ok(pricing.indexOf("git clone") > pricing.indexOf(copy.home.pricing.youRunIt) && pricing.indexOf("git clone") < pricing.indexOf(copy.home.pricing.weRunIt), "the install commands are in the self-hosting door");
  assert.equal(pricing.match(/class="pk-row"/g)?.length, 4, "your own server and the three hosted plans");
  assert.ok(h.indexOf(`<a href="#pricing">${copy.words.pricing}</a>`) < h.indexOf(`<a href="#self-host">${copy.words.hostItYourself}</a>`), "the menu follows the page");
});

test("the app cards describe the apps as they are, the desktop app has one download and one link to the other systems, and building is for developers", () => {
  const h = html("index");
  const t = text(h);
  assert.doesNotMatch(t, /Coming to the (app|browser) stores|Until then|Not in the stores yet|Not signed by/);
  const desktop = h.slice(h.indexOf('class="a-desktop"'), h.indexOf("</div>", h.indexOf('class="a-desktop"')));
  assert.equal(desktop.match(/<a /g)?.length, 2, "one button and one link");
  assert.match(desktop, new RegExp(`data-desktop-other hidden href="[^"]+/releases/latest">${literally(copy.kit.apps.desktop.otherSystems)}<`));
});

test("the mock screens use everyday examples next to the research one", () => {
  const t = text(html("index"));
  for (const word of [copy.home.picture.posts.cyclePath.source, copy.words.recipes, copy.kit.sidebar.baskets.thesisSources, copy.home.picture.posts.tomatoSauce.source]) assert.ok(t.includes(word), word);
  assert.doesNotMatch(t, /\d+ new since yesterday/);
});

test("every question in the catalogue is answered on the home page", () => {
  const h = html("index");
  const questions = [...h.matchAll(/<summary>(.*?)<svg/g)].map((m) => m[1] ?? "");
  assert.deepEqual(questions, copy.kit.faq.map((f) => f.question));
  // The service keeps no episode files and the site shows no storage amounts.
  assert.doesNotMatch(text(h), /saved on the server|save [^.]{0,30} on the server|\d+ MB (of|for)\b|\d+ GB of storage|counted in your storage/);
  assert.match(h, /href="https:\/\/github\.com\/program-sam\/purss\/issues"/);
});

test("every page still has its heading, main region and sitemap entry", () => {
  for (const key of keys) {
    const h = html(key);
    assert.equal((h.match(/<main\b/g) ?? []).length, 1, key);
    assert.match(h, /<h1\b/, key);
  }
  const map = sitemap(site);
  for (const p of Object.values(PAGES) as { path: string; index?: false }[]) assert.equal(map.includes(`${site.origin}${p.path}<`), p.index !== false, p.path);
});

test("the home page is rendered finished, with the switch on and every chosen post in its box, so it reads the same without scripts", () => {
  const h = html("index");
  assert.match(h, /<main class="pf" id="main" tabindex="-1" data-on="1">/);
  assert.match(h, /role="switch" aria-checked="true"/);
  assert.equal((h.match(/class="pf-m"/g) ?? []).length, 5, "five posts you chose");
  assert.equal((h.match(/class="pf-c junk"/g) ?? []).length, 0, "no ads or suggestions in the finished state");
  assert.equal((h.match(/class="fd"/g) ?? []).length, 2, "two of the five carry the new mark");
  assert.ok(text(h).includes(copy.words.createAFreeAccount));
});
