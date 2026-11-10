import type { Message } from "./mailer.ts";

/*
 * The messages, in the product's plain language: plain text plus a simple HTML version with the
 * same words. Nothing a person typed goes into a message except the recipient's own username,
 * and, for a reminder the person asked for, what they wrote on it. Every link stands alone on
 * its own line, so no full stop or word can end up glued to its address.
 */

const NAME = "PURSS";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A paragraph of words, or a link that stands alone (`label` is what the HTML version shows as the clickable words). */
type Part = string | { href: string; label: string };

function compose(to: string, subject: string, parts: Part[]): Message {
  const text = parts.map((p) => (typeof p === "string" ? p : p.href)).join("\n\n") + `\n\n-- \n${NAME}\n`;
  const body = parts.map((p) => typeof p === "string"
    ? `<p>${escape(p)}</p>`
    : `<p><a href="${escape(p.href)}">${escape(p.label)}</a></p>\n<p style="font-size:13px;color:#555;word-break:break-all">${escape(p.href)}</p>`).join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">\n${body}\n<p style="font-size:13px;color:#555">${NAME}</p>\n</body></html>\n`;
  return { to, subject, text, html };
}

function host(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

export function invitationMail(to: string, opts: { link: string; days: number; origin: string }): Message {
  return compose(to, `You're invited to ${NAME}`, [
    `You've been invited to create an account on ${NAME} at ${host(opts.origin)}: a private place to follow websites, feeds and channels and keep what matters to you.`,
    "To accept, open this link and choose how you'll sign in:",
    { href: opts.link, label: "your invitation" },
    `The invitation works once and ends in ${opts.days} ${opts.days === 1 ? "day" : "days"}. If you weren't expecting it, you can ignore this email.`,
  ]);
}

export function verifyMail(to: string, opts: { link: string; hours: number }): Message {
  return compose(to, "Confirm your email address", [
    `Please confirm that this is the email address for your ${NAME} account. Open this link:`,
    { href: opts.link, label: "confirm this address" },
    `The link works for ${opts.hours} hours. Your address is used only for messages about your account, such as resetting your password.`,
    "If you didn't make an account, you can ignore this email.",
  ]);
}

export function resetMail(to: string, opts: { link: string; username: string; minutes: number }): Message {
  return compose(to, "Reset your password", [
    `Someone asked to reset the password for the username ${opts.username}. To choose a new password, open this link:`,
    { href: opts.link, label: "choose a new password" },
    `The link works once, for ${opts.minutes} minutes. Choosing a new password signs the account out everywhere.`,
    "If it wasn't you, ignore this email: your password stays as it is.",
  ]);
}

export function passwordChangedMail(to: string): Message {
  return compose(to, "Your password was changed", [
    `The password for your ${NAME} account was just changed with a reset link sent to this address. The account was signed out everywhere and its assistant tokens were revoked.`,
    "If you didn't do this, sign in with a recovery code and change your password, or contact the administrator.",
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
    parts.push({ href: item.link, label: item.title ? "open it in your PURSS" : "open the item" });
  }
  parts.push("You asked for reminders by email in Settings, under Notifications. You can turn them off there.");
  return compose(to, one ? "A reminder you set is due" : `${opts.items.length} reminders you set are due`, parts);
}

export function testMail(to: string, opts: { origin: string }): Message {
  return compose(to, `Test message from your ${NAME}`, [
    `This is a test from the ${NAME} at ${host(opts.origin)}. Outgoing email works.`,
  ]);
}
