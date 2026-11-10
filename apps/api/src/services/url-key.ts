/*
 * The comparison key for an item's web address (plan/24): two addresses with the same key are
 * treated as the same page when keeping a link or looking one up. The rules undo only differences
 * that never change which page a server returns; anything that might is kept as it is.
 *
 * - Only http and https addresses have a key. The scheme is left out, so http://x/a and https://x/a
 *   match (feeds still publish plain-http links to pages people open over https).
 * - The host is lower-cased (the URL parser also converts international names to punycode) and a
 *   trailing dot is dropped. "www." is kept: it can be a different site.
 * - A port is kept unless it is the default for the address's own scheme.
 * - User name and password stay in the key (rare, and stripping them could merge different pages).
 * - The fragment is dropped, except fragments that look like app routes ("#/…" or "#!…"), which
 *   single-page sites use to tell pages apart.
 * - One trailing slash is dropped from a path other than "/".
 * - Well-known tracking parameters are removed (utm_* and the ad-click ids below); the remaining
 *   parameters keep their order and spelling, and an empty query is dropped.
 * - Path case and percent-encoding are left as the URL parser produces them.
 */

const TRACKING = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "igshid",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok",
]);

const isTracking = (name: string) => {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING.has(n);
};

/** The key for an address, or null when it isn't an http(s) address. Pure and deterministic (SQLite uses it too). */
export function urlKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/\.$/, "");
  if (!host) return null;
  const userinfo = u.username || u.password ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
  const port = u.port ? `:${u.port}` : "";
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // Rebuild the query by hand so parameters keep their original encoding.
  const params = u.search.slice(1).split("&").filter((part) => part !== "" && !isTracking(safeDecode(part.split("=")[0]!)));
  const query = params.length ? `?${params.join("&")}` : "";
  const fragment = u.hash.startsWith("#/") || u.hash.startsWith("#!") ? u.hash : "";
  return `${userinfo}${host}${port}${path}${query}${fragment}`;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}
