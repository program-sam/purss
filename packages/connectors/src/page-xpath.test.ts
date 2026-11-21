import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPageDom } from "./page-dom.ts";
import { classPreds, evaluateField, parseExpr, selectItems, toXPath, tokenKind, validateRecipe } from "./page-xpath.ts";
import type { RecipeCheck, RecipeField } from "./page-xpath.ts";

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>
<div class="list">
  <div class="post featured" id="p1"><h2 class="title"><a href="/a">A <b>bold</b>
    move</a></h2><time datetime="2026-11-09">Nov 9</time><span class="tag">one</span><span class="tag">two</span></div>
  <div class="post" id="p2"><h2 class="title"><a href="/b">B</a></h2><time datetime="2026-11-08">Nov 8</time></div>
  <div class="postscript" id="q">not a post</div>
  <div class="Post_card__x7Yq2" id="p3"><h2>C</h2></div>
</div></body></html>`;

const dom = buildPageDom(PAGE);
const ids = (expr: string) => selectItems(dom, parseExpr(expr, "item")!).map((n) => n.attrs.id ?? n.tag);
const item = (id: string) => dom.all.find((n) => n.attrs.id === id)!;
const field = (expr: string, name: Exclude<RecipeField, "item">, id: string) => evaluateField(dom, parseExpr(expr, name)!, item(id));

test("a class test matches whole class names, a stem test matches inside them", () => {
  assert.deepEqual(ids("//div[contains(concat(' ', normalize-space(@class), ' '), ' post ')]"), ["p1", "p2"]);
  assert.deepEqual(ids("//div[contains(@class, 'post')]"), ["p1", "p2", "q"]);
  assert.deepEqual(ids("//div[contains(@class, 'Post_card')]"), ["p3"]);
  assert.deepEqual(ids("//div[contains(concat(' ', normalize-space(@class), ' '), ' featured ')]"), ["p1"]);
});

test("attribute tests, link tests and positions", () => {
  assert.deepEqual(ids("//div[@id='p2']"), ["p2"]);
  assert.deepEqual(ids("//div[@id][starts-with(@id, 'p')]"), ["p1", "p2", "p3"]);
  assert.deepEqual(ids("//div[.//a[@href]]"), ["div", "p1", "p2"]);
  assert.deepEqual(ids("//a[contains(@href, '/a')]"), ["a"]);
  assert.deepEqual(ids("/html/body/div/div[2]"), ["p2"]);
  assert.deepEqual(ids("/html/body/div/div[2] | /html/body/div/div[4]"), ["p2", "p3"]);
  assert.deepEqual(ids("//h2 | //time"), ["h2", "time", "h2", "time", "h2"]);
  assert.deepEqual(ids("//div[contains(@class, 'nothing')]"), []);
});

test("a relative expression reads the first match under the item", () => {
  assert.equal(field(".//a/@href", "link", "p1"), "/a");
  assert.equal(field("(.//span)[2]", "title", "p1"), "two");
  assert.equal(field(".//span[contains(concat(' ', normalize-space(@class), ' '), ' tag ')]", "title", "p1"), "one");
  assert.equal(field(".//h2", "title", "p3"), "C");
  assert.equal(field(".//time/@datetime", "date", "p2"), "2026-11-08");
  assert.equal(field(".//time/@datetime", "date", "p3"), null);
  assert.equal(field("./@id", "link", "p3"), "p3");
  assert.equal(field(".", "title", "q"), "not a post");
});

test("an element's text is what the bridge reads: not collapsed, only trimmed", () => {
  assert.equal(field(".//a", "title", "p1"), "A bold\n    move");
});

test("siblings and the preceding axis", () => {
  assert.equal(field("preceding-sibling::*[1]//time/@datetime", "date", "p2"), "2026-11-09");
  assert.equal(field("following-sibling::*[1]//time/@datetime", "date", "p1"), "2026-11-08");
  assert.equal(field("preceding-sibling::*[1]//time/@datetime", "date", "p1"), null);
  assert.equal(field("preceding::time[1]/@datetime", "date", "p3"), "2026-11-08");
  assert.equal(field("preceding::time[contains(concat(' ', normalize-space(@class), ' '), ' x ')][1]/@datetime", "date", "p3"), null);
  assert.equal(field("preceding::span[2]", "date", "p3"), "one");
});

test("a link built from the page address and an id", () => {
  assert.equal(field("concat('https://example.com/changelog#', ./@id)", "link", "p1"), "https://example.com/changelog#p1");
});

test("every form reads back as it was written", () => {
  const forms: [RecipeField, string][] = [
    ["item", "//div[contains(concat(' ', normalize-space(@class), ' '), ' post ')]"],
    ["item", "//li[contains(@class, '_row')][.//a[@href]]"],
    ["item", "//a[contains(@href, '/artikel/')]"],
    ["item", "//div[@id='heroes']/div/div"],
    ["item", "//h2[starts-with(@id, 'go1')]"],
    ["item", "//div[contains(@class, 'a')]/ul/li | //section/ol/li"],
    ["item", "/html/body/div[2]/ul/li[3]/a"],
    ["title", "."],
    ["title", ".//h2/a"],
    ["title", "(.//a)[2]"],
    ["title", ".//div[contains(@class, '_title')]/span"],
    ["link", "./@href"],
    ["link", ".//a/@href"],
    ["link", "(.//a)[2]/@href"],
    ["link", "concat('https://example.com/changelog#', ./@id)"],
    ["date", ".//time/@datetime"],
    ["date", ".//time"],
    ["date", "preceding-sibling::*[1]//time/@datetime"],
    ["date", "following-sibling::*[1]/@title"],
    ["date", "(preceding-sibling::*[1]//time)[2]"],
    ["date", "preceding::h2[contains(concat(' ', normalize-space(@class), ' '), ' day ')][1]"],
    ["date", "preceding::time[contains(@class, 'styles_date')][1]/@datetime"],
  ];
  for (const [name, text] of forms) {
    const e = parseExpr(text, name);
    assert.ok(e, `${name}: ${text}`);
    assert.equal(toXPath(e), text);
    const check = validateRecipe({ item: "//li", title: ".", link: "./@href", [name]: text });
    assert.equal(check.ok, true, `${name}: ${text} ${JSON.stringify(check)}`);
  }
});

function refused(recipe: unknown): RecipeCheck {
  const r = validateRecipe(recipe);
  assert.equal(r.ok, false, JSON.stringify(recipe));
  return r;
}
const base = { item: "//li", title: ".", link: "./@href" };

test("a recipe is accepted only as the three fields and an optional date", () => {
  assert.deepEqual(validateRecipe(base), { ok: true });
  assert.deepEqual(validateRecipe({ ...base, date: ".//time/@datetime" }), { ok: true });
  for (const bad of [null, "//li", 7, [], { ...base, content: ".//p" }, { title: ".", link: "./@href" }, { ...base, title: "" }, { ...base, link: 3 }, { ...base, date: 5 }]) {
    const r = refused(bad);
    assert.equal(r.ok === false && r.reason, "shape");
  }
});

test("functions, variables and extensions that could run code or read elsewhere are refused", () => {
  const cases: [Partial<Record<RecipeField, string>>, RecipeField, string][] = [
    [{ item: "document('http://169.254.169.254/')//a" }, "item", "forbidden"],
    [{ item: "//div[@id=$x]" }, "item", "forbidden"],
    [{ title: "php:function('system', 'id')" }, "title", "forbidden"],
    [{ title: "php:functionString('phpinfo')" }, "title", "forbidden"],
    [{ link: "concat('x$y', ./@id)" }, "link", "forbidden"],
    [{ date: ".//time[@datetime=$d]/@datetime" }, "date", "forbidden"],
    [{ title: ".//a\u0000" }, "title", "forbidden"],
  ];
  for (const [patch, field, reason] of cases) assert.deepEqual(validateRecipe({ ...base, ...patch }), { ok: false, field, reason });
});

test("everything outside the grammar is refused", () => {
  const cases: [RecipeField, string, string][] = [
    ["item", "//a/@href", "syntax"],
    ["item", "//div[a[b]]", "syntax"],
    ["item", "//div/..", "syntax"],
    ["item", "//ancestor::div", "syntax"],
    ["item", "//div[position()=1]", "syntax"],
    ["item", "//div[contains(., 'x')]", "syntax"],
    ["item", "//div[text()='x']", "syntax"],
    ["item", "//div[@class='a' or @id='b']", "syntax"],
    ["item", "//*", "syntax"],
    ["item", "//div[string-length(@id) > 3]", "syntax"],
    ["item", "//div[contains(@class, 'a b')]", "badLiteral"],
    ["item", "//div[@id=\"p1\"]", "syntax"],
    ["item", "//div[1]", "wrongForm"],
    ["item", "/div/p", "wrongForm"],
    ["item", "/html/body", "wrongForm"],
    ["item", "//div[.//a[@href]][.//a[@href]]", "wrongForm"],
    ["item", ".//li", "syntax"],
    ["title", "//h2", "syntax"],
    ["title", "string(.//h2)", "syntax"],
    ["title", ".//h2/text()", "syntax"],
    ["title", "normalize-space(.//h2)", "syntax"],
    ["title", ".//h2 | .//h3", "syntax"],
    ["title", ".//a[contains(@href, 'ok')]/@href/..", "syntax"],
    ["title", "(.//a)[0]", "syntax"],
    ["link", "concat(.//a/@href, 'x')", "syntax"],
    ["link", "concat('a''b', ./@id)", "syntax"],
    ["link", "concat('a b', ./@id)", "badLiteral"],
    ["date", "preceding-sibling::div[1]", "wrongForm"],
    ["date", "preceding-sibling::*", "wrongForm"],
    ["date", "preceding-sibling::*[2]", "wrongForm"],
    ["date", "preceding-sibling::*[1][@id]", "wrongForm"],
    ["date", "ancestor::div[1]", "syntax"],
    ["date", "following::time[1]", "syntax"],
    ["date", "preceding::time", "wrongForm"],
    ["date", ".//time/@datetime/@x", "syntax"],
  ];
  for (const [field, text, reason] of cases) assert.deepEqual(validateRecipe({ ...base, [field]: text }), { ok: false, field, reason }, `${field}: ${text}`);
});

test("length, depth and breadth are bounded", () => {
  const long = `//a[contains(@href, '${"x".repeat(180)}')]`;
  assert.deepEqual(validateRecipe({ ...base, item: long }), { ok: false, field: "item", reason: "tooLong" });
  const twoParts = (n: number) => `//a[@id='${"x".repeat(100)}'] | //b[@id='${"x".repeat(n)}']`;
  assert.equal(twoParts(75).length, 200);
  assert.equal(validateRecipe({ ...base, item: twoParts(75) }).ok, true);
  assert.deepEqual(validateRecipe({ ...base, item: twoParts(76) }), { ok: false, field: "item", reason: "tooLong" });
  assert.deepEqual(validateRecipe({ ...base, item: `//a${"/b".repeat(17)}` }), { ok: false, field: "item", reason: "tooDeep" });
  assert.equal(validateRecipe({ ...base, item: `//a${"/b".repeat(10)}` }).ok, true);
  assert.deepEqual(validateRecipe({ ...base, item: "//a[@a][@b][@c][@d][@e]" }), { ok: false, field: "item", reason: "tooDeep" });
  const seven = Array.from({ length: 7 }, (_, i) => `//p${i}`).join(" | ");
  assert.deepEqual(validateRecipe({ ...base, item: seven }), { ok: false, field: "item", reason: "tooMany" });
  assert.equal(validateRecipe({ ...base, item: Array.from({ length: 6 }, (_, i) => `//p${i}`).join(" | ") }).ok, true);
});

test("class names that name a thing, and those that only style it or carry a build hash", () => {
  assert.deepEqual(tokenKind("post-card"), { kind: "stable", v: "post-card" });
  assert.deepEqual(tokenKind("BlogIndexPost--variantNormal"), { kind: "stable", v: "BlogIndexPost--variantNormal" });
  assert.deepEqual(tokenKind("styles_event-list-day__list-item__x4Fd2"), { kind: "stem", v: "styles_event-list-day__list-item" });
  assert.deepEqual(tokenKind("Post_card__x7Yq2"), { kind: "stem", v: "Post_card" });
  assert.deepEqual(tokenKind("a1b2c3_title"), { kind: "stem", v: "_title" });
  for (const t of ["flex", "mt-4", "text-sm", "md:flex", "w-1/2", "is-active", "js-toggle", "item-3", "css-1a2b3c", "sc-bdVaJa", "col-6", "x1y2z3q4", "it's", "a b", ""]) assert.equal(tokenKind(t), null, t);
});

test("an element's class tests come from its classes in the order written, without repeats", () => {
  const n = dom.all.find((x) => x.attrs.id === "p1")!;
  assert.deepEqual(classPreds(n), [{ k: "cls", v: "post" }, { k: "cls", v: "featured" }]);
});
