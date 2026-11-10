import test from "node:test";
import assert from "node:assert/strict";
import { invitationMail, reminderMail, resetMail, verifyMail } from "./templates.ts";

const URL_ON_ITS_OWN_LINE = /^https?:\/\/\S+$/;
/** Every address in the text is a whole line: nothing before it on the line, and no full stop or word after it. */
function linksAreAlone(text: string): string[] {
  const links: string[] = [];
  for (const line of text.split("\n")) {
    if (!/https?:\/\//.test(line)) continue;
    assert.match(line, URL_ON_ITS_OWN_LINE, `a link shares its line: ${line}`);
    links.push(line);
  }
  return links;
}

test("every link stands alone on its own line, so no full stop is glued to it", () => {
  const link = "https://ws.example.org/app/verify-email?token=abc_DEF-123";
  assert.deepEqual(linksAreAlone(verifyMail("a@example.org", { link, hours: 48 }).text), [link]);
  assert.deepEqual(linksAreAlone(resetMail("a@example.org", { link, username: "pat", minutes: 60 }).text), [link]);
  assert.deepEqual(linksAreAlone(invitationMail("a@example.org", { link, days: 7, origin: "https://ws.example.org" }).text), [link]);
  const reminder = reminderMail("a@example.org", { items: [{ title: null, note: null, link: `${link}1` }, { title: "Grant call", note: "Closes Friday", link: `${link}2` }] });
  assert.deepEqual(linksAreAlone(reminder.text), [`${link}1`, `${link}2`]);
});

test("the HTML version links the same address on a button and shows it in full below", () => {
  const link = "https://ws.example.org/app/verify-email?token=abc&x=1";
  const m = verifyMail("a@example.org", { link, hours: 48 });
  assert.match(m.html, /<a href="https:\/\/ws\.example\.org\/app\/verify-email\?token=abc&amp;x=1" style="[^"]*">Confirm this address<\/a>/);
  assert.ok(!/<img|src=|url\(/.test(m.html), "the HTML loads nothing remote");
  assert.match(m.html, /word-break:break-all">https:\/\/ws\.example\.org\/app\/verify-email\?token=abc&amp;x=1<\/p>/);
});

test("a reminder email names the item and note only when it is given them, and escapes them", () => {
  const plain = reminderMail("a@example.org", { items: [{ title: null, note: null, link: "https://x/1" }] });
  assert.equal(plain.subject, "A reminder you set is due");
  assert.match(plain.text, /An item you kept:\n\nhttps:\/\/x\/1/);
  const several = reminderMail("a@example.org", { items: [{ title: "A <b>title</b>", note: "Call & ask", link: "https://x/1" }, { title: "Two", note: null, link: "https://x/2" }] });
  assert.equal(several.subject, "2 reminders you set are due");
  assert.match(several.text, /A <b>title<\/b>: Call & ask/);
  assert.ok(!several.html.includes("<b>title</b>") && several.html.includes("A &lt;b&gt;title&lt;/b&gt;: Call &amp; ask"));
});
