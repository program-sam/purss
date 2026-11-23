import test from "node:test";
import assert from "node:assert/strict";
import { server } from "@purss/translations/server";
import { escapeRegExp, inHtml } from "../translations-testing.ts";
import { accountExistsMail, emailChangedMail, invitationMail, passwordChangedMail, reminderMail, resetMail, signupMail, verifyMail } from "./templates.ts";

const { mailTemplates, shared } = server.api;
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
  assert.deepEqual(linksAreAlone(resetMail("a@example.org", { link, minutes: 60 }).text), [link]);
  assert.deepEqual(linksAreAlone(signupMail("a@example.org", { link, hours: 48, origin: "https://ws.example.org" }).text), [link]);
  assert.deepEqual(linksAreAlone(accountExistsMail("a@example.org", { signIn: `${link}1`, reset: `${link}2`, origin: "https://ws.example.org" }).text), [`${link}1`, `${link}2`]);
  assert.deepEqual(linksAreAlone(invitationMail("a@example.org", { link, days: 7, origin: "https://ws.example.org" }).text), [link]);
  const reminder = reminderMail("a@example.org", { items: [{ title: null, note: null, link: `${link}1` }, { title: "Grant call", note: "Closes Friday", link: `${link}2` }] });
  assert.deepEqual(linksAreAlone(reminder.text), [`${link}1`, `${link}2`]);
});

test("the HTML version links the same address on a button and shows it in full below", () => {
  const link = "https://ws.example.org/app/verify-email?token=abc&x=1";
  const m = verifyMail("a@example.org", { link, hours: 48 });
  assert.match(m.html, new RegExp(String.raw`<a href="https://ws\.example\.org/app/verify-email\?token=abc&amp;x=1" style="[^"]*">${escapeRegExp(inHtml(mailTemplates.confirmButton))}</a>`));
  assert.ok(!/<img|src=|url\(/.test(m.html), "the HTML loads nothing remote");
  assert.match(m.html, /word-break:break-all">https:\/\/ws\.example\.org\/app\/verify-email\?token=abc&amp;x=1<\/p>/);
});

test("a reminder email names the item and note only when it is given them, and escapes them", () => {
  const plain = reminderMail("a@example.org", { items: [{ title: null, note: null, link: "https://x/1" }] });
  assert.equal(plain.subject, shared.reminderSubjectOne);
  assert.ok(plain.text.includes(`${mailTemplates.reminderItemFallback}\n\nhttps://x/1`));
  const several = reminderMail("a@example.org", { items: [{ title: "A <b>title</b>", note: "Call & ask", link: "https://x/1" }, { title: "Two", note: null, link: "https://x/2" }] });
  assert.equal(several.subject, shared.reminderSubjectMany(2));
  assert.match(several.text, /A <b>title<\/b>: Call & ask/);
  assert.ok(!several.html.includes("<b>title</b>") && several.html.includes("A &lt;b&gt;title&lt;/b&gt;: Call &amp; ask"));
});

test("account security emails use hosted service wording and self-hosted administrator wording", () => {
  const hosted = [
    { message: passwordChangedMail("a@example.org", "hosted"), owner: mailTemplates.changedContactOwner, administrator: mailTemplates.changedContactAdministrator },
    { message: emailChangedMail("a@example.org", { masked: "a…@example.org", mode: "hosted" }), owner: mailTemplates.emailChangedContactOwner, administrator: mailTemplates.emailChangedContactAdministrator },
  ];
  for (const { message, owner, administrator } of hosted) {
    assert.ok(message.text.includes(owner));
    assert.ok(!message.text.includes(administrator));
  }
  const self = [
    { message: passwordChangedMail("a@example.org", "self"), administrator: mailTemplates.changedContactAdministrator },
    { message: emailChangedMail("a@example.org", { masked: "a…@example.org", mode: "self" }), administrator: mailTemplates.emailChangedContactAdministrator },
  ];
  for (const { message, administrator } of self) {
    assert.ok(message.text.includes(administrator));
  }
});
