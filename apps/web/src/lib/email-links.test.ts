import test from "node:test";
import assert from "node:assert/strict";
import { inviteFromLink, tokenFromLink } from "./email-links.ts";

test("a pasted email link gives its token or invitation code; anything else gives none", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
  assert.equal(tokenFromLink(` https://ws.example/app/reset-password?token=${token} `), token);
  assert.equal(tokenFromLink(`https://ws.example/app/verify-email?token=${token}&x=1`), token);
  assert.equal(tokenFromLink(token), token, "the token alone");
  assert.equal(tokenFromLink("https://ws.example/app/reset-password"), null);
  assert.equal(tokenFromLink("not a link at all"), null);
  assert.equal(tokenFromLink("https://ws.example/?token=short"), null);
  assert.equal(inviteFromLink("https://ws.example/app/invite?code=7fzb-45xm-a5ru-4eem-h5fw"), "7fzb-45xm-a5ru-4eem-h5fw");
  assert.equal(inviteFromLink(" 7FZB-45XM "), "7FZB-45XM");
});
