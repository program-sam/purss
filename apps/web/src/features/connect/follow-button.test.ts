import test from "node:test";
import assert from "node:assert/strict";
import { followButtonHtml } from "./follow-button.ts";

test("the button is one plain link with no script, and its address can't break out of the attribute", () => {
  const html = followButtonHtml(`https://ws.example/follow?url=x"><script>alert(1)</script>&y`);
  assert.ok(html.startsWith('<a href="https://ws.example/follow?url=x&quot;>&lt;script>alert(1)&lt;/script>&amp;y" style="'));
  assert.equal((html.match(/</g) ?? []).length, 2, "only the opening and closing tags");
  assert.ok(html.endsWith(">Follow in PURSS</a>"));
});
