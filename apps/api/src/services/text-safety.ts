import { isPlainWord } from "@purss/connectors";

/*
 * Small helpers shared by the export, sharing, OPML and admin features:
 * output escaping, web-address checks and error redaction.
 */

// Characters that are not allowed in XML 1.0 documents (and make strict parsers reject a feed).
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Drop characters XML cannot carry and collapse lone surrogates. */
export function xmlSafe(text: string): string {
  return text.replace(XML_INVALID, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Escape text for use in XML/HTML element content and double-quoted attributes. */
export function escapeXml(text: string): string {
  return xmlSafe(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export const escapeHtml = escapeXml;

/** Single-line plain text of bounded length (control characters removed, whitespace collapsed). */
export function plainText(text: string | null | undefined, max: number): string {
  if (!text) return "";
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

/** The href of a plain http(s) address without embedded credentials, or null. */
export function httpUrlOrNull(raw: string | null | undefined, max = 2000): string | null {
  if (!raw || raw.length > max) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** Names whose value only counts as a secret when it looks like one (`key=tech-news` is a topic); a word under `pass` or `auth` is a password. */
const AMBIGUOUS_PARAM = /^key$/i;
const SECRET_PARAM = /^(?:token|access_token|auth_token|auth|authkey|api[-_]?key|apikey|key|secret|sig|signature|sign|password|passwd|pwd|pass|session|sessionid|sid|bearer|jwt|private|passkey|pk|uid_token|feed_token|rsstoken|x-amz-signature|x-amz-credential|x-goog-signature)$/i;

/**
 * True when an address carries an obvious credential: embedded user/password, or a query
 * value under a secret-looking name. This is a warning signal, not proof of safety: the
 * per-source private flag (set when the source was followed) is the primary guard, and
 * an address that matches nothing here is not thereby "known public" (plan/20).
 */
export function hasCredentialShape(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return true; }
  if (url.username || url.password) return true;
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAM.test(name) && value.length >= 6 && !(AMBIGUOUS_PARAM.test(name) && isPlainWord(value))) return true;
  }
  return false;
}

/** Remove anything from an error text that could leak an address, token or person. */
export function redactError(text: string | null | undefined, max = 300): string | null {
  if (!text) return null;
  const out = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (m) => {
      try { return `${new URL(m).protocol}//${new URL(m).host}/…`; } catch { return "[address]"; }
    })
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, "[token]");
  return plainText(out, max);
}

/** Deterministic RFC 4122 style UUID (version 5 bits) from a string, for stable feed identifiers. */
export function uuidFrom(seed: string, hash: (s: string) => string): string {
  const h = hash(seed);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
