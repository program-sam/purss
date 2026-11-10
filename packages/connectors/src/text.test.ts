import assert from "node:assert/strict";
import { test } from "node:test";
import { assertShallowMarkup, MAX_MARKUP_DEPTH, parseHtmlTree, TooComplexError } from "./text.ts";

const refused = (text: string, mode: "html" | "xml" = "html", limits?: { depth?: number; events?: number }) =>
  assert.throws(() => assertShallowMarkup(text, mode, limits), TooComplexError);

test("nesting is judged as the parser reads it, so closing tags it ignores don't hide depth", () => {
  const deep = MAX_MARKUP_DEPTH + 10;
  // The parser ignores a closing tag for an element that isn't open, so these still nest.
  refused("<div></x>".repeat(deep));
  refused("<div></span>".repeat(deep));
  // A closing tag inside a quoted attribute, a comment or a script is not a closing tag.
  refused("<div title='>' </div>".repeat(deep));
  refused("<div><!-- </div> -->".repeat(deep));
  refused("<div><script></div></script>".repeat(deep));
  // Elements that don't close themselves implicitly still count when nothing closes them.
  refused("<li><span>".repeat(deep));
  refused("<table><tr><td>".repeat(deep));
  refused("<svg><title>".repeat(deep));
  refused("<a>".repeat(deep), "xml");
});

test("ordinary markup within the limits passes, however long", () => {
  assertShallowMarkup(`<ul>${"<li>item".repeat(50_000)}</ul>`, "html");
  assertShallowMarkup("<p>para".repeat(50_000), "html");
  assertShallowMarkup(`${"<div>".repeat(MAX_MARKUP_DEPTH)}x${"</div>".repeat(MAX_MARKUP_DEPTH)}`, "html");
  assertShallowMarkup(`<opml>${"<outline/>".repeat(50_000)}</opml>`, "xml", { depth: 4 });
});

test("an event budget bounds the work on flat but huge markup", () => {
  assertShallowMarkup("<b>x</b>".repeat(1000), "html", { events: 3000 });
  refused("<b>x</b>".repeat(1001), "html", { events: 3000 });
  refused('<b a=1 b=2 c=3>'.repeat(1000), "html", { events: 3000 });
});

test("hostile nesting is refused before the tree parser stalls on it", () => {
  const started = Date.now();
  assert.throws(() => parseHtmlTree("<div></x>".repeat(200_000)), TooComplexError);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
