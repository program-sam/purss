import { cleanPasted } from "./input.ts";

/*
 * Social accounts pasted into Add source: fediverse handles (@name@server), Mastodon-style profile
 * pages, Bluesky handles and bsky.app profile links. Each is turned into the account's own public
 * feed, which the feed engine then collects like any other; nothing here reads the social APIs.
 *
 * Checked against the platforms' code and live answers on 2026-11-05:
 * - Mastodon answers WebFinger (`/.well-known/webfinger?resource=acct:name@server`) with a
 *   `http://webfinger.net/rel/profile-page` link; the profile page advertises
 *   `<link rel="alternate" type="application/rss+xml" href="…/@name.rss">`. The feed holds the
 *   latest 20 public and unlisted posts, without boosts or replies, and items have no titles
 *   (mastodon/mastodon app/controllers/accounts_controller.rb, app/views/accounts/show.rss.ruby).
 * - Bluesky serves `https://bsky.app/profile/<handle or DID>/rss`. A handle redirects to the DID
 *   form, which survives handle changes; an account that asks not to be shown to signed-out
 *   people answers 403; an unknown one 404. Items are the account's own top-level posts from its
 *   latest 30 (no reposts, no replies), with no titles
 *   (bluesky-social/social-app bskyweb/cmd/bskyweb/rss.go).
 */

export type SocialTarget =
  /** A fediverse account to look up with WebFinger. */
  /** `emailLike`: typed as name@server, without the leading @ or acct:, so it may as well be an email address. */
  | { kind: "fediverse"; user: string; domain: string; emailLike: boolean }
  /** A Bluesky account by handle or DID; `related` when a post was pasted rather than the profile. */
  | { kind: "bluesky"; actor: string; related: boolean }
  /** A Bluesky link that has no feed (custom feeds, lists). */
  | { kind: "unsupported"; message: string };

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A domain name with at least two labels and a letter-led top-level label (AT Protocol handle syntax). */
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`);
const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;
const FEDI_USER = /^[a-z0-9_][a-z0-9_.-]{0,63}$/i;
const BSKY_HOSTS = new Set(["bsky.app", "www.bsky.app"]);

export function isDomainName(value: string): boolean {
  return value.length <= 253 && DOMAIN.test(value);
}

function bskyActor(raw: string): string | null {
  let value: string;
  try { value = decodeURIComponent(raw).toLowerCase(); } catch { return null; }
  value = value.replace(/^@/, "");
  return DID.test(value) || isDomainName(value) ? value : null;
}

export const BLUESKY_NO_FEED = "Bluesky custom feeds and lists don't have a feed to follow. Paste the profile of an account instead.";

/** Recognise a social account in what was pasted, or return null for everything else. */
export function classifySocialInput(raw: string): SocialTarget | null {
  const s = cleanPasted(raw).replace(/^acct:/i, "");
  if (!s || s.length > 300 || /\s/.test(s)) return null;

  // @name@server or name@server (a fediverse handle). The server is lower-cased; the name is not.
  const handle = /^@?([^@/:?#]+)@([^@/:?#]+)$/.exec(s);
  if (handle) {
    const [, user, host] = handle;
    const domain = host!.toLowerCase();
    const emailLike = !s.startsWith("@") && !/^\s*acct:/i.test(raw);
    return FEDI_USER.test(user!) && isDomainName(domain) ? { kind: "fediverse", user: user!, domain, emailLike } : null;
  }
  // @name.bsky.social or @custom.domain (a Bluesky handle is a domain name).
  if (s.startsWith("@")) {
    const actor = bskyActor(s.slice(1));
    return actor && !actor.startsWith("did:") ? { kind: "bluesky", actor, related: false } : null;
  }

  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");

  if (BSKY_HOSTS.has(host)) {
    const m = /^\/profile\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return null;
    const actor = bskyActor(m[1]!);
    if (!actor) return null;
    const rest = m[2] ?? "";
    if (rest === "" || rest === "/rss") return { kind: "bluesky", actor, related: false };
    if (/^\/post\/[a-z0-9]+$/i.test(rest)) return { kind: "bluesky", actor, related: true };
    if (/^\/(?:feed|lists)\//.test(rest)) return { kind: "unsupported", message: BLUESKY_NO_FEED };
    return { kind: "bluesky", actor, related: false };
  }
  // name.bsky.social, typed as a host: Bluesky's own handles, never a website of their own.
  if (host.endsWith(".bsky.social") && path === "" && !url.search && isDomainName(host)) return { kind: "bluesky", actor: host, related: false };
  // https://server/@name@other: one server's view of an account that lives on another.
  const remote = /^\/@([^/@]+)@([^/@]+)$/.exec(path);
  if (remote) {
    const user = decodeURIComponent(remote[1]!);
    const domain = decodeURIComponent(remote[2]!).toLowerCase();
    return FEDI_USER.test(user) && isDomainName(domain) ? { kind: "fediverse", user, domain, emailLike: false } : null;
  }
  return null;
}

/** A profile page address such as https://server/@name: worth checking for a fediverse account. */
export function looksLikeProfilePath(pathname: string): boolean {
  return /^\/@[^/@]+\/?$/.test(pathname);
}

/** A post's path on a fediverse server: Mastodon's /@name/<id> and /users/name/statuses/<id>, Pleroma's /notice/<id>. */
export function looksLikeSocialPostPath(pathname: string): boolean {
  return /^\/@[^/@]+\/[^/]+\/?$/.test(pathname) || /^\/users\/[^/]+\/statuses\/[^/]+\/?$/.test(pathname) || /^\/notice\/[^/]+\/?$/.test(pathname);
}

export type SocialPlatform = "mastodon" | "fediverse" | "bluesky";

export const SOCIAL_ORIGIN: Record<SocialPlatform, string> = {
  mastodon: "Mastodon account",
  fediverse: "Fediverse account",
  bluesky: "Bluesky account",
};

/** Honest limits, shown with the preview before following. */
export const SOCIAL_NOTE: Record<SocialPlatform, string> = {
  mastodon: "Public posts only, the latest 20 at each check. Boosts and replies aren't included. A post its author deletes stays in your PURSS.",
  fediverse: "Public posts only, as this server publishes them. A post its author deletes stays in your PURSS.",
  bluesky: "Public posts only, the most recent ones at each check. Reposts and replies aren't included. A post its author deletes stays in your PURSS.",
};

export function platformForFeed(generator: string | null): SocialPlatform {
  return generator && /^mastodon\b/i.test(generator) ? "mastodon" : "fediverse";
}

/** Bluesky titles its feed "@handle - Display name"; the source is called by the display name, or the handle. */
export function blueskyTitle(feedTitle: string | null, actor: string): string {
  const m = feedTitle ? /^(@\S+)(?:\s+-\s+(.+))?$/.exec(feedTitle.trim()) : null;
  if (m) return m[2]?.trim() || m[1]!;
  return feedTitle?.trim() || (actor.startsWith("did:") ? "Bluesky account" : `@${actor}`);
}
