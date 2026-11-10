import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLinks } from "./links.ts";

test("bare web addresses in plain text become links and the rest stays text", () => {
  assert.deepEqual(splitLinks("Slides at https://example.org/talk.pdf for everyone"), [
    { text: "Slides at " }, { text: "https://example.org/talk.pdf", href: "https://example.org/talk.pdf" }, { text: " for everyone" },
  ]);
  assert.deepEqual(splitLinks("no links here"), [{ text: "no links here" }]);
  assert.deepEqual(splitLinks(""), [{ text: "" }]);
});

test("a sentence's punctuation is not part of the address", () => {
  assert.deepEqual(splitLinks("See https://example.org/a, then https://example.org/b."), [
    { text: "See " }, { text: "https://example.org/a", href: "https://example.org/a" }, { text: ", then " },
    { text: "https://example.org/b", href: "https://example.org/b" }, { text: "." },
  ]);
  assert.deepEqual(splitLinks("(see https://example.org/x)"), [{ text: "(see " }, { text: "https://example.org/x", href: "https://example.org/x" }, { text: ")" }]);
  assert.deepEqual(splitLinks("https://en.wikipedia.org/wiki/Foo_(bar)."), [{ text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" }, { text: "." }]);
});

test("only http and https become links", () => {
  assert.deepEqual(splitLinks("javascript:alert(1) and data:text/html,x and ftp://example.org/f"), [{ text: "javascript:alert(1) and data:text/html,x and ftp://example.org/f" }]);
  assert.deepEqual(splitLinks("HTTPS://EXAMPLE.ORG/Path"), [{ text: "HTTPS://EXAMPLE.ORG/Path", href: "https://example.org/Path" }]);
});

test("addresses next to right-to-left text stay whole", () => {
  assert.deepEqual(splitLinks("المزيد: https://example.org/ar/خبر؟"), [
    { text: "المزيد: " }, { text: "https://example.org/ar/خبر", href: "https://example.org/ar/%D8%AE%D8%A8%D8%B1" }, { text: "؟" },
  ]);
});
