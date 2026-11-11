import type { Message } from "./mailer.ts";

/*
 * The messages, in the product's plain language: plain text plus a simple HTML version with the
 * same words. Nothing a person typed goes into a message except the recipient's own username,
 * for a reminder the person asked for, what they wrote on it, and in a digest, their collections' names. Every link stands alone on
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
<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${MUTED};font-family:${FONT}">${NAME}: follow your sources, keep what matters.</p>
</td></tr></table>
</body></html>
`;
  return { to, subject, text, html };
}

function host(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

export function invitationMail(to: string, opts: { link: string; days: number; origin: string }): Message {
  return compose(to, `You're invited to ${NAME}`, [
    `You've been invited to create an account on ${NAME} at ${host(opts.origin)}: a private place to follow websites, feeds and channels and keep what matters to you.`,
    "To accept, open this link and choose how you'll sign in:",
    { href: opts.link, label: "Accept your invitation" },
    `The invitation works once and ends in ${opts.days} ${opts.days === 1 ? "day" : "days"}. If you weren't expecting it, you can ignore this email.`,
  ]);
}

export function verifyMail(to: string, opts: { link: string; hours: number }): Message {
  return compose(to, "Confirm your email address", [
    `Please confirm that this is the email address for your ${NAME} account. Open this link:`,
    { href: opts.link, label: "Confirm this address" },
    `The link works for ${opts.hours} hours. We email this address only about your account, such as resetting your password, and with your digest of what's new, which you can turn off in Settings. No newsletters or marketing.`,
    "If you didn't make an account, you can ignore this email.",
  ]);
}

export function resetMail(to: string, opts: { link: string; username: string; minutes: number }): Message {
  return compose(to, "Reset your password", [
    `Someone asked to reset the password for the username ${opts.username}. To choose a new password, open this link:`,
    { href: opts.link, label: "Choose a new password" },
    `The link works once, for ${opts.minutes} minutes. Choosing a new password signs the account out everywhere.`,
    "If it wasn't you, ignore this email: your password stays as it is.",
  ]);
}

export function passwordChangedMail(to: string): Message {
  return compose(to, "Your password was changed", [
    `The password for your ${NAME} account was just changed with a reset link. The account was signed out everywhere and its assistant tokens were revoked.`,
    "If you didn't do this, reset your password again from the sign-in page, or contact the administrator.",
  ]);
}

export function emailChangedMail(to: string, opts: { masked: string }): Message {
  return compose(to, "Your email address was changed", [
    `The email address for your ${NAME} account was changed to ${opts.masked}. Messages about your account now go there.`,
    "If you didn't do this, sign in and check your account's security settings, or contact the administrator.",
  ]);
}

/**
 * The reminders whose day has come. `title` and `note` are null unless the person turned on titles in notifications
 * (the same rule as every notification); the link opens the item in PURSS.
 */
export function reminderMail(to: string, opts: { items: { title: string | null; note: string | null; link: string }[] }): Message {
  const one = opts.items.length === 1;
  const parts: Part[] = [one ? "A reminder you set on something you kept is due today." : `${opts.items.length} reminders you set on things you kept are due today.`];
  for (const item of opts.items) {
    parts.push(item.title ? `${item.title}${item.note ? `: ${item.note}` : ""}` : "An item you kept:");
    parts.push({ href: item.link, label: item.title ? "Open it in your PURSS" : "Open the item" });
  }
  parts.push("You asked for reminders by email in Settings, under Notifications. You can turn them off there.");
  return compose(to, one ? "A reminder you set is due" : `${opts.items.length} reminders you set are due`, parts);
}

/**
 * A daily or weekly digest: its title, one line per collection (counts, and titles only under the notification rules applied by
 * `digestFor`), a link to Home, and a link straight to the setting that stops these emails.
 */
export function digestMail(to: string, opts: { title: string; lines: string[]; link: string; settings: string }): Message {
  return compose(to, opts.title, [
    ...opts.lines,
    { href: opts.link, label: `Open your ${NAME}` },
    `You get this email because digest emails are on for your ${NAME} account. To stop them, or to change how often they come, untick "Email me the digest" here:`,
    { href: opts.settings, label: "Change digest emails" },
  ]);
}

export function testMail(to: string, opts: { origin: string }): Message {
  return compose(to, `Test message from your ${NAME}`, [
    `This is a test from the ${NAME} at ${host(opts.origin)}. Outgoing email works.`,
  ]);
}
