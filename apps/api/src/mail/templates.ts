import type { Message } from "./mailer.ts";
import { server } from "@purss/copy/server";

/*
 * The messages, in the product's plain language: plain text plus a simple HTML version with the
 * same words. Nothing a person typed goes into a message except the recipient's own address,
 * for a reminder the person asked for, what they wrote on it, and in a digest, their collections' names and the titles of new items. Every link stands alone on
 * its own line, so no full stop or word can end up glued to its address.
 */

const NAME = "PURSS";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A paragraph of words, or a link that stands alone (`label` is what the HTML version shows on its button). */
type Part = string | { href: string; label: string };

/*
 * The HTML version is a table layout with inline styles, the form mail programs render alike
 * (Gmail, Outlook and Apple Mail drop <style> blocks and most modern CSS). It loads no images
 * and nothing remote, so it looks the same with images blocked and tells no one it was opened.
 */
const BRAND = "#1260ba";
const INK = "#1d2733";
const MUTED = "#5b6878";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${INK}">${escape(text)}</p>`;
}

function button(href: string, label: string): string {
  const url = escape(href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px"><tr>`
    + `<td style="border-radius:8px;background:${BRAND}"><a href="${url}" style="display:inline-block;padding:12px 24px;border-radius:8px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none">${escape(label)}</a></td>`
    + `</tr></table>\n<p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:${MUTED};word-break:break-all">${url}</p>`;
}

function compose(to: string, subject: string, parts: Part[]): Message {
  const text = parts.map((p) => (typeof p === "string" ? p : p.href)).join("\n\n") + `\n\n-- \n${NAME}\n`;
  const body = parts.map((p) => (typeof p === "string" ? paragraph(p) : button(p.href, p.label))).join("\n");
  const preview = typeof parts[0] === "string" ? escape(parts[0]) : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#eaf1fa;font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eaf1fa"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #d5e1ef;font-family:${FONT}">
<tr><td style="padding:20px 32px;background:${BRAND};border-radius:13px 13px 0 0"><span style="font-size:20px;font-weight:700;letter-spacing:2px;color:#ffffff">${NAME}</span></td></tr>
<tr><td style="padding:32px 32px 16px">
<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:700;color:${INK}">${escape(subject)}</h1>
${body}
</td></tr>
</table>
<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${MUTED};font-family:${FONT}">${server.api.mailTemplates.tagline(NAME)}</p>
</td></tr></table>
</body></html>
`;
  return { to, subject, text, html };
}

function host(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

export function invitationMail(to: string, opts: { link: string; days: number; origin: string }): Message {
  return compose(to, server.api.mailTemplates.invitationSubject(NAME), [
    server.api.mailTemplates.invitationIntro(NAME, host(opts.origin)),
    server.api.mailTemplates.invitationLead,
    { href: opts.link, label: server.api.mailTemplates.invitationButton },
    server.api.mailTemplates.invitationFooter(opts.days),
  ]);
}

export function signupMail(to: string, opts: { link: string; hours: number; origin: string }): Message {
  return compose(to, server.api.mailTemplates.signupSubject(NAME), [
    server.api.mailTemplates.signupIntro(NAME, host(opts.origin)),
    { href: opts.link, label: server.api.mailTemplates.signupButton },
    server.api.mailTemplates.signupFooter(opts.hours),
  ]);
}

export function accountExistsMail(to: string, opts: { signIn: string; reset: string; origin: string }): Message {
  return compose(to, server.api.mailTemplates.existsSubject(NAME), [
    server.api.mailTemplates.existsIntro(NAME, host(opts.origin)),
    { href: opts.signIn, label: server.api.mailTemplates.existsSignIn },
    server.api.mailTemplates.existsForgot,
    { href: opts.reset, label: server.api.mailTemplates.existsReset },
    server.api.mailTemplates.existsIgnore,
  ]);
}

export function verifyMail(to: string, opts: { link: string; hours: number }): Message {
  return compose(to, server.api.mailTemplates.confirmSubject, [
    server.api.mailTemplates.confirmIntro(NAME),
    { href: opts.link, label: server.api.mailTemplates.confirmButton },
    server.api.mailTemplates.confirmFooter(opts.hours),
    server.api.mailTemplates.confirmIgnore,
  ]);
}

export function resetMail(to: string, opts: { link: string; minutes: number }): Message {
  return compose(to, server.api.mailTemplates.resetSubject, [
    server.api.mailTemplates.resetIntro(NAME),
    { href: opts.link, label: server.api.mailTemplates.resetButton },
    server.api.mailTemplates.resetFooter(opts.minutes),
    server.api.mailTemplates.resetIgnore,
  ]);
}

export function passwordChangedMail(to: string, mode: "self" | "hosted" = "self"): Message {
  return compose(to, server.api.mailTemplates.changedSubject, [
    server.api.mailTemplates.changedIntro(NAME),
    mode === "hosted"
      ? server.api.mailTemplates.changedContactOwner
      : server.api.mailTemplates.changedContactAdministrator,
  ]);
}

export function emailChangedMail(to: string, opts: { masked: string; mode?: "self" | "hosted" }): Message {
  return compose(to, server.api.mailTemplates.emailChangedSubject, [
    server.api.mailTemplates.emailChangedIntro(NAME, opts.masked),
    opts.mode === "hosted"
      ? server.api.mailTemplates.emailChangedContactOwner
      : server.api.mailTemplates.emailChangedContactAdministrator,
  ]);
}

/**
 * The reminders whose day has come. `title` and `note` are null unless the person turned on titles in notifications
 * (the same rule as every notification); the link opens the item in PURSS.
 */
export function reminderMail(to: string, opts: { items: { title: string | null; note: string | null; link: string }[] }): Message {
  const one = opts.items.length === 1;
  const parts: Part[] = [one ? server.api.mailTemplates.reminderIntroOne : server.api.mailTemplates.reminderIntroMany(opts.items.length)];
  for (const item of opts.items) {
    parts.push(item.title ? `${item.title}${item.note ? `: ${item.note}` : ""}` : server.api.mailTemplates.reminderItemFallback);
    parts.push({ href: item.link, label: item.title ? server.api.mailTemplates.reminderOpenWithTitle : server.api.mailTemplates.reminderOpenWithoutTitle });
  }
  parts.push(server.api.mailTemplates.reminderSettingsNote);
  return compose(to, one ? server.api.shared.reminderSubjectOne : server.api.shared.reminderSubjectMany(opts.items.length), parts);
}

/** A digest email: counts per collection and the newest items of each, with links into the app. */
export type DigestMail = {
  subject: string;
  intro: string;
  boxes: { name: string; count: number; link: string; teasers: { title: string; meta: string; link: string }[] }[];
  /** Collections with new items that are not listed. */
  more: number;
  home: string;
  /** Opens Settings → Notifications and New, where the email is turned off. */
  settings: string;
};

/*
 * The digest looks like Home: a sky-tinted page, and per collection a white box with Home's tinted header, its count of new
 * items, and its newest items marked with Home's blue dot. Colours are Home's sky skin in hex (mail programs don't all read
 * hsl()), the font stack is Home's without the web font (nothing remote is loaded), and every box is a table.
 */
const SKY = { top: "#a4ccf9", mid: "#d3e7fd", bg: "#fcfcfd", modTop: "#f7fbff", modBot: "#e5f0fd", modBd: "#d3dfee", line: "#dce3ea", ink: "#131e2a", ink3: "#566371", accent: "#1260ba", accentInk: "#15467f" };
const ROUNDED = "ui-rounded,'SF Pro Rounded','Nunito','Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif";

function digestBox(b: DigestMail["boxes"][number]): string {
  const rows = b.teasers.map((t, i) => `<tr><td style="padding:12px 16px;${i ? `border-top:1px solid ${SKY.line};` : ""}">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>`
    + `<td width="16" valign="top" style="padding-top:7px"><div style="width:7px;height:7px;border-radius:50%;background:${SKY.accent};font-size:0;line-height:0">&nbsp;</div></td>`
    + `<td><a href="${escape(t.link)}" style="font-size:15px;line-height:1.4;font-weight:700;color:${SKY.ink};text-decoration:none">${escape(t.title)}</a>`
    + `<div style="margin-top:3px;font-size:13px;line-height:1.4;color:${SKY.ink3}">${escape(t.meta)}</div></td>`
    + `</tr></table></td></tr>`).join("");
  const rest = b.count - b.teasers.length;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;background:#ffffff;border:1px solid ${SKY.modBd};border-radius:12px;border-collapse:separate;overflow:hidden">`
    + `<tr><td style="padding:12px 16px;background:${SKY.modBot};background-image:linear-gradient(${SKY.modTop},${SKY.modBot});border-bottom:1px solid ${SKY.modBd};border-radius:11px 11px 0 0">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td><a href="${escape(b.link)}" style="font-size:16px;font-weight:800;color:${SKY.ink};text-decoration:none">${escape(b.name)}</a></td>`
    + `<td align="right" style="font-size:13px;font-weight:800;color:${SKY.accentInk};white-space:nowrap"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${SKY.accent};margin-right:6px;vertical-align:1px"></span>${server.api.mailTemplates.digestCount(b.count)}</td>`
    + `</tr></table></td></tr>`
    + rows
    + `<tr><td style="padding:10px 16px;border-top:1px solid ${SKY.line}"><a href="${escape(b.link)}" style="font-size:13px;font-weight:700;color:${SKY.accentInk};text-decoration:none">${rest > 0 ? server.api.mailTemplates.digestMoreIn(rest, escape(b.name)) : server.api.mailTemplates.digestOpenBox(escape(b.name))} &rsaquo;</a></td></tr>`
    + `</table>`;
}

/** The daily or weekly digest, built by `digestEmail` in services/notifications.ts. */
export function digestMail(to: string, m: DigestMail): Message {
  const stop = server.api.mailTemplates.digestStop(NAME);
  const text = [
    m.intro,
    ...m.boxes.map((b) => [`${b.name}: ${b.count} new`, ...b.teasers.map((t) => `- ${t.title} (${t.meta})\n  ${t.link}`)].join("\n")),
    ...(m.more > 0 ? [server.api.mailTemplates.digestMoreCollections(m.more)] : []),
    server.api.mailTemplates.digestOpen(NAME, m.home),
    `${stop}\n${m.settings}`,
  ].join("\n\n") + `\n\n-- \n${NAME}\n`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(m.subject)}</title></head>
<body style="margin:0;padding:0;background:${SKY.bg};font-family:${ROUNDED}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escape(m.intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SKY.mid};background-image:linear-gradient(${SKY.top},${SKY.mid} 180px,${SKY.bg} 420px)"><tr><td align="center" style="padding:28px 14px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${ROUNDED}">
<tr><td style="padding:0 4px 18px"><span style="font-size:18px;font-weight:800;letter-spacing:2px;color:${SKY.accentInk}">${NAME}</span></td></tr>
<tr><td style="padding:0 4px 20px"><h1 style="margin:0 0 6px;font-size:24px;line-height:1.25;font-weight:800;color:${SKY.ink}">${escape(m.subject.replace(/:.*$/, ""))}</h1>
<p style="margin:0;font-size:15px;line-height:1.5;color:${SKY.ink3}">${escape(m.intro)}</p></td></tr>
<tr><td>${m.boxes.map(digestBox).join("\n")}</td></tr>
${m.more > 0 ? `<tr><td style="padding:0 4px 16px;font-size:14px;color:${SKY.ink3}">${server.api.mailTemplates.digestAndMoreHtml(m.more)}</td></tr>` : ""}
<tr><td align="center" style="padding:8px 0 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:8px;background:${SKY.accent}"><a href="${escape(m.home)}" style="display:inline-block;padding:12px 26px;border-radius:8px;font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none">${server.api.mailTemplates.digestOpenButton(NAME)}</a></td></tr></table></td></tr>
<tr><td style="padding:0 4px;font-size:12px;line-height:1.55;color:${SKY.ink3}">${escape(stop)} <a href="${escape(m.settings)}" style="color:${SKY.accentInk};font-weight:700">${server.api.mailTemplates.digestChange}</a></td></tr>
</table>
</td></tr></table>
</body></html>
`;
  return { to, subject: m.subject, text, html };
}

export function testMail(to: string, opts: { origin: string }): Message {
  return compose(to, server.api.mailTemplates.testSubject(NAME), [
    server.api.mailTemplates.testBody(NAME, host(opts.origin)),
  ]);
}
