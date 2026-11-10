import { cleanPasted } from "@purss/connectors";
import type { App } from "../app.ts";

/*
 * Sites people tried to follow without success (plan/41): the administrator's view of which services and sites are worth a bridge
 * or a better lookup. One counter per UTC day, site and reason. It records the registrable domain of what was pasted and nothing
 * else: no path, no subdomain (a creator's page on bandcamp.com counts as bandcamp.com), no account, no PURSS.
 */

/** The ways a lookup fails that say something about the site rather than about what was typed. */
export const MISS_REASONS = ["nofeed", "unsupported", "unreachable", "timeout"] as const;
export type MissReason = (typeof MISS_REASONS)[number];

export const KEEP_DAYS = 180;
/** A day never holds more distinct (site, reason) rows than this: pasting endless made-up sites can't grow the table without bound. */
const MAX_ROWS_PER_DAY = 1000;

/** Second-level labels registered under a country code: bbc.co.uk, example.com.au, nhk.or.jp. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const FEED_SCHEME = /^(?:feed|feeds|rss|pcast|itpc|podcast):/i;
const HOST_PORT = /^[^/\s:]+\.[^/\s:]+:\d+(?:[/?#]|$)/;

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

/** The host name of a web address, in the form a browser would use (internationalised names as punycode), or null. */
function hostOf(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * The site a pasted address belongs to: its registrable domain, lower-cased and without `www.`. For a fediverse handle
 * (`@name@mastodon.social`) it is the server, for a Bluesky handle (`@name.bsky.social`) the handle's own domain. Null for anything
 * that is not an address: a name, an email address, a private or numeric address, another kind of link.
 */
export function siteOfPasted(raw: string): string | null {
  if (raw.length > 2000) return null;
  const s = cleanPasted(raw).replace(/^acct:/i, "");
  if (!s || /\s/.test(s)) return null;

  const handle = /^@?([^@/:?#]+)@([^@/:?#]+)$/.exec(s);
  if (handle) {
    const host = hostOf(`https://${handle[2]}/`);
    return host ? registrableDomain(host) : null;
  }
  if (s.startsWith("@")) {
    const host = /^@[^@/:?#]+$/.test(s) ? hostOf(`https://${s.slice(1)}/`) : null;
    return host ? registrableDomain(host) : null;
  }

  let address: string | null = null;
  if (/^https?:\/\//i.test(s)) address = s;
  else if (FEED_SCHEME.test(s)) {
    const rest = s.replace(FEED_SCHEME, "");
    address = /^https?:\/\//i.test(rest) ? rest : `https://${rest.replace(/^\/\//, "")}`;
  } else if (s.startsWith("//")) address = `https:${s}`;
  else if (HOST_PORT.test(s) || !/^[a-z][a-z0-9+.-]*:/i.test(s)) address = `https://${s}`;
  const host = address ? hostOf(address) : null;
  return host ? registrableDomain(host) : null;
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Count one failed lookup. Never throws and never delays an answer: a record that can't be written is dropped, and what the
 * person is told does not depend on it. Rows older than KEEP_DAYS are deleted as part of the write.
 */
export function recordDiscoveryMiss(app: App, pasted: string, reason: string, now: Date = new Date()): void {
  try {
    if (!(MISS_REASONS as readonly string[]).includes(reason)) return;
    const site = siteOfPasted(pasted);
    if (!site) return;
    const day = dayOf(now);
    app.db.tx(() => {
      app.db.run("DELETE FROM discovery_misses WHERE day < ?", dayOf(new Date(now.getTime() - KEEP_DAYS * 86_400_000)));
      const known = app.db.get("SELECT 1 FROM discovery_misses WHERE day = ? AND site = ? AND reason = ?", day, site, reason);
      if (!known && app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_misses WHERE day = ?", day)!.n >= MAX_ROWS_PER_DAY) return;
      app.db.run("INSERT INTO discovery_misses (day, site, reason, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, site, reason) DO UPDATE SET count = count + 1", day, site, reason);
    });
  } catch (err) {
    console.warn("[api] a failed lookup couldn't be counted:", err instanceof Error ? err.message : "unknown error");
  }
}

export type DiscoveryMiss = { site: string; reason: MissReason; count: number };

/** The sites most often tried without success over the last `days` days, per site and reason, most first. */
export function topDiscoveryMisses(app: App, opts: { days?: number; limit?: number; now?: Date } = {}): DiscoveryMiss[] {
  const now = opts.now ?? new Date();
  const since = dayOf(new Date(now.getTime() - ((opts.days ?? 30) - 1) * 86_400_000));
  return app.db.all<DiscoveryMiss>(
    "SELECT site, reason, SUM(count) AS count FROM discovery_misses WHERE day >= ? GROUP BY site, reason ORDER BY count DESC, site, reason LIMIT ?",
    since, opts.limit ?? 20).map((m) => ({ ...m }));
}
