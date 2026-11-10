/**
 * Feed links the desktop app is the handler for (plan/42): `feed:` (as in `feed:https://…` and the
 * shorthand `feed://host/…`), `podcast:` and `pcast:`. They open Add source with the address filled in;
 * nothing is looked up until the person presses Find, and Add source checks the address as if it had been
 * pasted. An address that is already http(s) inside the link keeps its scheme; the shorthand becomes https.
 * Anything else is not a feed link (null).
 */
export function feedAddress(link: string): string | null {
  const m = /^(feed|podcast|pcast):(.*)$/is.exec(link.trim());
  if (!m) return null;
  let rest = m[2]!;
  if (/^https?:\/\//i.test(rest)) { /* feed:https://… */ } else if (/^\/\/[^/]/.test(rest)) rest = `https:${rest}`;
  else return null;
  try {
    const u = new URL(rest);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}
