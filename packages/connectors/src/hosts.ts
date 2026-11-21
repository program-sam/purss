/*
 * Which site a host belongs to. A site is its registrable domain: `www.bbc.co.uk` and `static.files.bbc.co.uk` are `bbc.co.uk`. Used to tell
 * a page's own scripts (and the addresses they name) from other people's, and to count failed lookups per site.
 */

/** Second-level labels registered under a country code: bbc.co.uk, example.com.au, nhk.or.jp. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);
/**
 * Hosts where everyone gets their own subdomain (a.github.io and b.github.io are different people's sites): for sameSite the subdomain is the
 * site. Not the whole Public Suffix List, only the hosting services pages are commonly published on.
 */
const SHARED_HOSTS = new Set([
  "github.io", "gitlab.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com", "herokuapp.com",
  "onrender.com", "fly.dev", "azurewebsites.net", "cloudfront.net", "blogspot.com", "wordpress.com", "substack.com",
  "tumblr.com", "wixsite.com", "webflow.io", "squarespace.com", "neocities.org", "codeberg.page", "readthedocs.io", "glitch.me", "framer.website",
]);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The registrable domain of a host name (`www.example.co.uk` → `example.co.uk`), or null for an address, a single label or anything else that isn't a public name. */
export function registrableDomain(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.join(".").length > 253 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels.at(-1)!;
  if (!TLD.test(tld)) return null; // all-numeric last label: an IP address
  const rest = labels[0] === "www" && labels.length > 2 ? labels.slice(1) : labels;
  const takeThree = rest.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(rest.at(-2)!);
  return rest.slice(takeThree ? -3 : -2).join(".");
}

/** The site a host is for telling one site's pages and scripts from another's: its registrable domain, or on a shared host its own subdomain. */
function siteOf(host: string): string | null {
  const domain = registrableDomain(host);
  if (!domain || !SHARED_HOSTS.has(domain)) return domain;
  const labels = host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "").split(".");
  return labels.length > domain.split(".").length ? labels.slice(-(domain.split(".").length + 1)).join(".") : domain;
}

/**
 * Whether two hosts are of one site. Two addresses by number, or names that are not public, are never. On a host where everyone gets a
 * subdomain (alice.github.io, bob.github.io) each subdomain is a site of its own. The failed-lookup log keeps the registrable domain alone.
 */
export function sameSite(a: string, b: string): boolean {
  const left = siteOf(a);
  return left !== null && left === siteOf(b);
}
