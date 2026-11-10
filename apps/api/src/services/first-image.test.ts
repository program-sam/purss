import test from "node:test";
import assert from "node:assert/strict";
import { firstImage } from "./first-image.ts";
import { sanitize } from "./content.ts";

test("the first real picture of the content is the card's picture", () => {
  assert.equal(firstImage('<p>Intro</p><img src="https://cdn.example.org/a/hero.jpg" alt=""><img src="https://cdn.example.org/b.jpg">'), "https://cdn.example.org/a/hero.jpg");
  assert.equal(firstImage('<figure><img src="https://cdn.example.org/p.png?w=1200&amp;q=80" width="1200" height="800"></figure>'), "https://cdn.example.org/p.png?w=1200&q=80");
  assert.equal(firstImage(null), null);
  assert.equal(firstImage("<p>No pictures here.</p>"), null);
});

test("pixels, icons, emoji, avatars and pictures the page would not show are skipped", () => {
  const html = [
    '<img src="https://stats.example.org/pixel.gif" width="1" height="1">',
    '<img src="https://s.w.org/images/core/emoji/15/72x72/1f600.png">',
    '<img src="https://secure.gravatar.com/avatar/abc">',
    '<img src="https://cdn.example.org/icon.png" width="32" height="32">',
    '<img src="http://cdn.example.org/plain-http.jpg">',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="https://cdn.example.org/the-picture.jpg" width="640">',
  ].join("");
  assert.equal(firstImage(html), "https://cdn.example.org/the-picture.jpg");
  assert.equal(firstImage('<img src="https://stats.example.org/pixel.gif" width="1" height="1">'), null);
});

test("it reads what the sanitiser leaves behind", () => {
  const clean = sanitize('<p>Hi</p><img src="https://cdn.example.org/x.jpg?a=1&b=2" onerror="x()" alt="A boat">');
  assert.equal(firstImage(clean), "https://cdn.example.org/x.jpg?a=1&b=2");
});
