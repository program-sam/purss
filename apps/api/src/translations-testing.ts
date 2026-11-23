/*
 * TEST ONLY: helpers for tests that compare what the server says with the catalog text it reads from `@purss/translations`,
 * so rewording a catalog entry never breaks a test.
 */

/** `text` as a regular expression that matches exactly itself. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What an HTML page or email shows of `text`: the five characters it escapes, as the server escapes them. */
export function inHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
