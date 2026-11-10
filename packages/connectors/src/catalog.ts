/*
 * Declarative connector catalog (plan/08 contract proposal). Pure data: no code is
 * loaded from it and nothing here is user-extensible. Discovery, feed generation,
 * content extraction and media playback are declared separately on purpose. Only
 * connectors that need no authentication and no provider adapter are listed;
 * no proprietary service adapter is approved.
 */

export type ConnectorSourceType = "feed" | "podcast" | "youtube";

export type HealthCode = { code: string; meaning: string };

export type ConnectorDescriptor = {
  /** Stable identifier, never reused. */
  id: string;
  /** Contract version of this descriptor. */
  version: 1;
  name: string;
  summary: string;
  sourceTypes: readonly ConnectorSourceType[];
  capabilities: {
    /** Can turn a pasted address into followable feeds. */
    discovery: boolean;
    /** Generates a feed from a non-feed API. Needs the private feed gateway; none here does. */
    feedGeneration: boolean;
    /** Can capture a readable text copy of an item on Keep. */
    contentExtraction: boolean;
    /** Plays media inside the product. */
    mediaPlayback: boolean;
  };
  /** "public-web" means any public host; internal ranges are always refused by safeFetch. */
  permittedDomains: readonly string[] | "public-web";
  auth: { needs: "none" };
  /** Honest limits on what following this kind of source gives you. */
  coverageLimits: string;
  rateLimits: string;
  healthCodes: readonly HealthCode[];
};

const COMMON_HEALTH: readonly HealthCode[] = [
  { code: "ok", meaning: "The last check returned a readable feed." },
  { code: "unreachable", meaning: "The website could not be reached or refused the request." },
  { code: "timeout", meaning: "The website took too long to answer." },
  { code: "blocked", meaning: "The address points somewhere that is not allowed (private or internal)." },
  { code: "toolarge", meaning: "The page or feed was larger than the safety limit." },
  { code: "invalid", meaning: "The response was not valid or could not be read." },
  { code: "nofeed", meaning: "No feed could be found at that address." },
  { code: "rate_limited", meaning: "The website asked us to slow down." },
  { code: "gone", meaning: "The address no longer exists (404/410)." },
  { code: "empty", meaning: "The feed is readable but has no items right now. That does not prove nothing was published." },
];

const entries: ConnectorDescriptor[] = [
  {
    id: "native-feed",
    version: 1,
    name: "Website or feed",
    summary: "Follows RSS, Atom and JSON Feed addresses, or a website that advertises one. Collection is done by the feed engine, not by this connector.",
    sourceTypes: ["feed", "podcast"],
    capabilities: { discovery: true, feedGeneration: false, contentExtraction: true, mediaPlayback: false },
    permittedDomains: "public-web",
    auth: { needs: "none" },
    coverageLimits:
      "Shows what the publisher puts in the feed, usually only the latest items and sometimes only summaries. A feed with no items is not proof the site has published nothing, and older posts may not be reachable. Podcasts supply links to audio, not copies of it.",
    rateLimits: "Discovery makes a few requests per paste. Recurring checks are scheduled by the feed engine, which respects each site's caching headers.",
    healthCodes: COMMON_HEALTH.slice(),
  },
  {
    id: "youtube-channel",
    version: 1,
    name: "YouTube channel or playlist feed",
    summary: "Resolves a YouTube channel address, @handle or playlist to its official public feed. It is not an account importer.",
    sourceTypes: ["youtube"],
    capabilities: { discovery: true, feedGeneration: false, contentExtraction: false, mediaPlayback: false },
    permittedDomains: ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"],
    auth: { needs: "none" },
    coverageLimits:
      "YouTube's official feed lists only the most recent videos of a channel or playlist (about the latest 15). It does not include full channel history, and does not separate Shorts, live streams or community posts. Members-only, private and age-restricted videos, your subscriptions and watch history are not available. A video link resolves to its uploader as a related channel for you to confirm; playlists without an official feed (mixes, liked videos, watch later) are not supported.",
    rateLimits: "A few requests per paste. Recurring checks are scheduled by the feed engine.",
    healthCodes: [
      ...COMMON_HEALTH,
      { code: "consent_wall", meaning: "YouTube asked for cookie consent, so a handle could not be resolved. A /channel/UC… address always works." },
      { code: "channel_unknown", meaning: "The page could not be tied to exactly one channel." },
    ],
  },
  {
    id: "fediverse-account",
    version: 1,
    name: "Mastodon or other fediverse account",
    summary: "Finds an account from its @name@server handle (through WebFinger) or its profile page, and follows the public feed the profile page advertises. It is not a client: nothing is posted, liked or followed on the account's server.",
    sourceTypes: ["feed"],
    capabilities: { discovery: true, feedGeneration: false, contentExtraction: false, mediaPlayback: false },
    permittedDomains: "public-web",
    auth: { needs: "none" },
    coverageLimits:
      "Public posts only. Mastodon's feed lists the latest 20 public and unlisted posts, without boosts or replies; other servers publish what they choose, and some (such as GoToSocial) only when the account's owner turns the feed on. A post its author deletes or edits later stays in your PURSS as it was collected. Followers-only posts, direct messages, replies, likes and the account's timeline are not available.",
    rateLimits: "Discovery makes up to four requests per paste (WebFinger, the profile page and its feeds). Recurring checks are scheduled by the feed engine; Mastodon caches its feed for a minute.",
    healthCodes: COMMON_HEALTH.slice(),
  },
  {
    id: "bluesky-account",
    version: 1,
    name: "Bluesky account",
    summary: "Turns a Bluesky handle (name.bsky.social, a custom domain) or a bsky.app profile or post link into the account's public feed on bsky.app, by its permanent identifier so a handle change doesn't break it.",
    sourceTypes: ["feed"],
    capabilities: { discovery: true, feedGeneration: false, contentExtraction: false, mediaPlayback: false },
    permittedDomains: ["bsky.app"],
    auth: { needs: "none" },
    coverageLimits:
      "Public posts only: the account's own top-level posts among its most recent ones, without reposts or replies, and without titles. Accounts that ask not to be shown to signed-out people can't be followed. A post its author deletes later stays in your PURSS as it was collected. Custom feeds, lists, hashtags and likes have no feed. Bluesky doesn't document this feed, so it may change.",
    rateLimits: "One request per paste. Recurring checks are scheduled by the feed engine.",
    healthCodes: COMMON_HEALTH.slice(),
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export const connectorCatalog: readonly ConnectorDescriptor[] = deepFreeze(entries);

export function connectorById(id: string): ConnectorDescriptor | undefined {
  return connectorCatalog.find((c) => c.id === id);
}
