/**
 * Links PURSS sends by email (password reset, address confirmation, invitations) carry their secret
 * in the query. In the apps the person pastes the link instead of opening it in a browser; these read it.
 */

/** The token in …/reset-password?token=… or …/verify-email?token=…, or a token pasted on its own. */
export function tokenFromLink(raw: string): string | null {
  const text = raw.trim();
  try {
    const t = new URL(text).searchParams.get("token");
    if (t && /^[A-Za-z0-9_-]{20,200}$/.test(t)) return t;
  } catch { /* not a link */ }
  return /^[A-Za-z0-9_-]{20,200}$/.test(text) ? text : null;
}

/** The code in an invitation link (…/invite?code=…), or what was typed when it isn't a link. */
export function inviteFromLink(raw: string): string {
  const text = raw.trim();
  try {
    const code = new URL(text).searchParams.get("code");
    if (code) return code.trim();
  } catch { /* typed, not a link */ }
  return text;
}
