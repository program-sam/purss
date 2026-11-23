import { server } from "@purss/translations/server";
import type { KnownFeed, KnownPlan } from "./known-feeds.ts";
import { hostOf, segmentsOf } from "./services.ts";

const feedLabels = server.sources.connectors.labels;
const substackCopy = server.sources.connectors.substack;

/*
 * Substack. A publication's feed is `/feed` on its own address (`name.substack.com`, or its custom domain), and a section's is
 * the same feed with `?section=<slug>` (Substack answers 404 for a section it doesn't have). A podcast's feed lives on
 * api.substack.com under the publication's number, which only its `/podcast` page names, so that page is read like any other.
 * Share links (`open.substack.com/pub/name/…`) name the publication in the path. A person's profile (`substack.com/@handle`,
 * `substack.com/profile/<id>-<name>`, a note under it) has no feed: the publications that person runs are looked up in
 * Substack's public profile record and their feeds offered, their primary one first. A post link under a profile
 * (`/@handle/p-123`) redirects to the post on its own publication, which then names its feed, so it is left to ordinary discovery.
 */

const RESERVED = new Set(["www", "open", "support", "on", "api", "substack", "go", "email", "help", "cdn", "media", "reader"]);
const SUBDOMAIN = /^[a-z0-9-]{1,63}$/;
const HANDLE = /^[A-Za-z0-9_.-]{1,64}$/;
const PROFILE_SLUG = /^\d{1,15}-[A-Za-z0-9-]{1,120}$/;
const SECTION = /^[a-z0-9-]{1,100}$/;
/** A profile record lists the publications the person reads too, and runs to a megabyte or more. */
export const SUBSTACK_PROFILE_BYTES = 4 * 1024 * 1024;
/** Feeds offered from one profile: its own publications, not every one it has written for. */
const MAX_PUBLICATIONS = 4;

function publication(base: string, rest: string[]): KnownPlan {
  const whole: KnownFeed = { feedUrl: `${base}/feed`, via: feedLabels.postsFeed };
  if (rest[0] === "s" && SECTION.test(rest[1] ?? "")) {
    return { service: "Substack", route: "known:substack", feeds: [{ feedUrl: `${base}/feed?section=${rest[1]}`, via: feedLabels.sectionFeed, section: true }, whole] };
  }
  return { service: "Substack", route: "known:substack", feeds: [whole] };
}

/** The feed plan for a Substack address, or null when ordinary discovery should read the page. */
export function planSubstack(url: URL): KnownPlan | null {
  const h = hostOf(url);
  const s = segmentsOf(url);
  if (h === "open.substack.com") {
    const name = (s[1] ?? "").toLowerCase();
    if (s[0] !== "pub" || !SUBDOMAIN.test(name) || RESERVED.has(name)) return null;
    return podcastPage(s.slice(2)) ? null : publication(`https://${name}.substack.com`, s.slice(2));
  }
  if (h === "substack.com" || h === "www.substack.com") {
    const first = s[0] ?? "";
    if (first.startsWith("@") && HANDLE.test(first.slice(1))) return /^p-\d+$/.test(s[1] ?? "") ? null : { service: "Substack", route: "known:substack", profile: first.slice(1) };
    if (first === "profile" && PROFILE_SLUG.test(s[1] ?? "")) return { service: "Substack", route: "known:substack", profile: s[1]! };
    return null;
  }
  const label = h.slice(0, -".substack.com".length);
  if (!SUBDOMAIN.test(label) || RESERVED.has(label)) return null;
  return podcastPage(s) ? null : publication(`https://${label}.substack.com`, s);
}

/** A publication's or a section's podcast page: it links the podcast feed, whose address can't be made from the page's. */
function podcastPage(rest: string[]): boolean {
  return rest[0] === "podcast" || (rest[0] === "s" && rest[2] === "podcast");
}

export function substackProfileUrl(profile: string): string {
  return `https://substack.com/api/v1/user/${encodeURIComponent(profile)}/public_profile`;
}

type Publication = { base: string; primary: boolean; admin: boolean };

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function baseOf(pub: unknown): string | null {
  const p = pub as { subdomain?: unknown; custom_domain?: unknown } | null;
  const custom = typeof p?.custom_domain === "string" ? p.custom_domain.toLowerCase() : "";
  if (custom && HOSTNAME.test(custom)) return `https://${custom}`;
  const sub = typeof p?.subdomain === "string" ? p.subdomain.toLowerCase() : "";
  return SUBDOMAIN.test(sub) && !RESERVED.has(sub) ? `https://${sub}.substack.com` : null;
}

/**
 * The publications a profile record says the person runs or writes for, primary first, then the ones they run, then the rest;
 * publications the profile hides are left out. Null when the record isn't a profile.
 */
export function readSubstackProfile(data: unknown): Publication[] | null {
  const d = data as { handle?: unknown; publicationUsers?: unknown; primaryPublication?: unknown } | null;
  if (!d || typeof d !== "object" || typeof d.handle !== "string") return null;
  const primaryBase = baseOf(d.primaryPublication);
  const found = new Map<string, Publication>();
  for (const entry of Array.isArray(d.publicationUsers) ? d.publicationUsers : []) {
    const e = entry as { role?: unknown; is_primary?: unknown; public?: unknown; publication?: unknown } | null;
    if (!e || e.public === false) continue;
    const base = baseOf(e.publication);
    if (!base || found.has(base)) continue;
    found.set(base, { base, primary: e.is_primary === true || base === primaryBase, admin: e.role === "admin" });
  }
  if (primaryBase && !found.has(primaryBase)) found.set(primaryBase, { base: primaryBase, primary: true, admin: true });
  const rank = (p: Publication) => (p.primary ? 0 : p.admin ? 1 : 2);
  return [...found.values()].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_PUBLICATIONS);
}

/** The feeds of a profile's publications: the primary one is what the profile is about; the others say how the person is linked to them. */
export function profileFeeds(publications: Publication[]): KnownFeed[] {
  return publications.map((p, i) => ({
    feedUrl: `${p.base}/feed`,
    via: feedLabels.postsFeed,
    ...(i === 0 ? { lead: true } : { alsoNote: p.admin ? substackCopy.alsoRuns : substackCopy.alsoWrites }),
  }));
}
