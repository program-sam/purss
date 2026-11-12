import { z } from "zod";
import type { WorkflowState } from "./workflow.ts";
import type { ItemKind, QueryNode, Sort } from "./query.ts";
import { WORKFLOW_STATES } from "./workflow.ts";
import { SORTS, queryNodeSchema } from "./query.ts";
import type { StorageSummary } from "./storage.ts";
import type { Capacity } from "./plans.ts";
import type { TextRef } from "./annotations.ts";

/*
 * Public product API contract (browser and connected apps <-> api). All routes are under /api,
 * JSON. The browser uses the session cookie, and its mutations require the same origin and the
 * `x-purss-csrf` header from GET /api/session. Connected apps send `Authorization: Bearer purss_dev_…`
 * instead (plan/24).
 * Errors: { error: { code, message } } with a plain-language message.
 */

/** `dueAt` accompanies `deletion_pending`: the account is waiting out its deletion grace period. */
export type ApiError = { error: { code: string; message: string; dueAt?: string } };

// ---------- account deletion ----------
/** The account asked to be deleted; it is removed for good at `dueAt` unless the owner signs in before then and keeps it. */
export type DeletionRequested = { dueAt: string };

// ---------- session ----------
export type SessionInfo = {
  state: "unclaimed" | "signed_out" | "signed_in";
  csrf: string | null;
  account: {
    id: string;
    displayName: string | null;
    /** The address the account signs in with; null only for an account whose operator hasn't given it one (cli.ts set-email). */
    email: string | null;
    isAdmin: boolean;
    hasPasskey: boolean;
    hasPassword: boolean;
    /**
     * The external sign-ins (providers set up here) this account has linked. `canConfirm`: it may also confirm it's you now (a provider
     * that can only show its account chooser confirms only an account with no password and no passkey).
     */
    linkedProviders: { id: string; label: string; canConfirm: boolean }[];
    /** This browser signed in as a shared computer: it signs out when it closes and after 8 hours. */
    sharedComputer: boolean;
  } | null;
  installation: {
    mode: "self" | "hosted";
    oidcProviders: { id: string; label: string }[];
    /** "open" only on a hosted installation configured for it whose outgoing email works. */
    signup: "invite" | "open";
    /** Outgoing email is set up: invitations can be emailed. */
    mail: boolean;
    /** This server's version (plan/40), e.g. "2631214"; null when it was built without one. */
    version: string | null;
    /** Addresses are confirmed by a link and can receive a password-reset link (wherever outgoing email is set up). */
    accountEmail: boolean;
    /** Plans are paid for through the hosted service's billing (Settings → Plan); otherwise administrators set them. */
    billing: boolean;
  };
};
/** The signed-in account's email address (plan/27). */
/**
 * The account's sign-in address. `available`: the server sends email (confirmation and reset links). `pending`: a new
 * address waiting for its confirmation link; until then `address` stays the account's.
 */
export type AccountEmail = { available: boolean; address: string | null; confirmed: boolean; pending: string | null };

// ---------- sidebar/bootstrap ----------
export type SourceHealth = "ok" | "pending" | "error" | "login" | "quiet" | "paused" | "reconnect";
export type SourceDTO = {
  id: string;
  title: string;
  kind: "feed" | "youtube" | "podcast" | "publication" | "private";
  origin: string; // "RSS feed", "YouTube channel feed", ...
  siteUrl: string | null;
  feedUrl: string | null; // null when private/redacted
  collectionIds: string[];
  health: SourceHealth;
  healthText: string | null; // plain words when not ok
  lastItemAt: string | null;
  lastSuccessAt: string | null;
  freshCount: number;
  itemCount: number;
  paused: boolean;
  /** When a pause for a week or a month ends by itself; null for a pause until resumed, and when not paused. */
  pausedUntil: string | null;
  hue: number;
  initials: string;
  /** Same-origin address of the source's own icon; null shows the initials tile. */
  iconUrl: string | null;
  curator: string | null; // someone's shared page
  notify: "default" | "on" | "muted";
  /** Each new item's page is fetched and a readable copy saved (plan/07 capture). */
  fullText: boolean;
  /** Whether full articles can be turned on: ordinary feeds, never private ones. */
  fullTextAvailable: boolean;
  /** The source's own Smart filter is on; a collection's filter is marked on the collection (plan/36). */
  aiFiltered: boolean;
};
export type CollectionDTO = {
  id: string;
  name: string;
  emoji: string | null;
  mode: "sources" | "query";
  view: ViewMode;
  position: number;
  showOnHome: boolean;
  sourceIds: string[];
  query: QueryNode | null;
  freshCount: number;
  itemCount: number;
  /** The collection's Smart filter is on, judging the posts of all its sources (plan/36). */
  aiFiltered: boolean;
};
export type BasketDTO = {
  id: string;
  name: string;
  captureMode: "metadata" | "text";
  position: number;
  itemCount: number;
};
export type ViewMode = "list" | "cards" | "board" | "table" | "timeline";
export const VIEW_MODES: readonly ViewMode[] = ["list", "cards", "board", "table", "timeline"];

export type Preferences = {
  theme: "system" | "light" | "dark";
  skin: "sky" | "lilac" | "meadow";
  density: "comfortable" | "compact";
  homeLayout: "collections" | "feed" | "new" | "front";
  homeCollectionIds: string[]; // order; empty = all in sidebar order
  freshMarkers: boolean;
  showCounts: boolean;
  reminders: boolean; // anniversary reminders, on by default
  /** Days an item stays marked New; 0 keeps the marker until it is cleared. */
  freshDays: number;
  /** Home shows an "Other sources" box for sources that are in no collection. */
  homeOther: boolean;
  /** The one-time question about notifications and New markers has been answered (or skipped). */
  welcomeAsked: boolean;
  notifications: NotificationPrefs;
  timezone: string | null; // null until a signed-in browser reports its own zone
  /** Words and phrases whose items are left out of Home and lists. */
  mutedWords: MutedWord[];
  /** Hosted only: this account's followed public sources count towards Discover suggestions for everyone here. */
  discoveryShare: boolean;
};
/** A muted word or phrase; `until` is when it stops (an ISO time), or null for until it is removed. */
export type MutedWord = { text: string; until: string | null };
/** *daily* / *weekly*: one digest at `digestTime` (on `digestDay` for weekly); *off*: nothing about new items. */
export type NotificationFrequency = "off" | "daily" | "weekly";
export type NotificationInclude = {
  /** New items from every source on Home, or only from these collections. */
  newItems: "all" | string[];
  /** Sources that stop working. */
  problems: boolean;
  /** "On this day" reminders. */
  reminders: boolean;
  /** Readable-text copies that could not be saved. */
  captures: boolean;
};
export type NotificationPrefs = {
  /** Where they show: the bell only, or also as browser alerts while the page is open. */
  mode: "inapp" | "browser";
  frequency: NotificationFrequency;
  /** Local time of a digest, "HH:MM". */
  digestTime: string;
  /** Day of a weekly digest, 0 (Sunday) to 6 (Saturday). */
  digestDay: number;
  include: NotificationInclude;
  quietStart: string | null;
  quietEnd: string | null;
  previews: boolean;
  /** Also email the dates set with "Remind me" on the day (needs outgoing email and a confirmed address). */
  emailReminders: boolean;
  /** Also email the daily or weekly digest (needs outgoing email and a confirmed address). */
  emailDigest: boolean;
};
export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  skin: "sky",
  density: "comfortable",
  homeLayout: "collections",
  homeCollectionIds: [],
  freshMarkers: true,
  showCounts: true,
  reminders: true,
  freshDays: 30,
  homeOther: true,
  welcomeAsked: false,
  notifications: {
    mode: "inapp", frequency: "weekly", digestTime: "08:00", digestDay: 1,
    include: { newItems: "all", problems: true, reminders: true, captures: true },
    quietStart: null, quietEnd: null, previews: false, emailReminders: false, emailDigest: true,
  },
  timezone: null,
  mutedWords: [],
  discoveryShare: true,
};

export type Bootstrap = {
  collections: CollectionDTO[];
  sources: SourceDTO[];
  baskets: BasketDTO[];
  preferences: Preferences;
  /** Sources and collections used of the account's plan. */
  capacity: Capacity;
  /** Why new items and copies are paused (PURSS is out of space), or null. */
  paused: string | null;
  unreadNotifications: number;
  engine: { status: "ok" | "starting" | "unavailable"; lastSyncAt: string | null; message: string | null };
};

// ---------- items ----------
/**
 * "fulltext": readable text the server fetched that passed the checks; "partial": a server capture that is only part of the page
 * (see PartialCopy); "browser": readable text the person's browser sent (plan/32).
 */
export type CaptureLevel = "metadata" | "feed" | "fulltext" | "partial" | "browser" | "pending" | "failed";
export type ItemDTO = {
  id: string;
  sourceId: string | null; // null for manual keeps
  sourceTitle: string;
  kind: ItemKind;
  title: string;
  url: string | null;
  author: string | null;
  excerpt: string | null; // plain text, ≤ 300 chars
  imageUrl: string | null;
  durationSeconds: number | null;
  readMinutes: number | null;
  doi: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  workflow: WorkflowState;
  revision: number;
  /** Moves by one on every change to the item's state, the New marker, opening and keeping it in a basket included. The revision guards workflow and progress against stale writers; this tells which of two copies of the item is newer. */
  stateVersion: number;
  fresh: boolean;
  progress: number; // 0..1 reading progress, separate from workflow
  opened: boolean;
  basketIds: string[];
  curatorNote: string | null;
  /** The publisher's audio or video file for this item, if its feed offers one (never for private sources). */
  media: ItemMedia | null;
  /** When the server last accepted a change to the person's annotations on this item (removals included), in server time; null if never annotated. */
  annotatedAt: string | null;
  /** for items kept in a basket, in the lists that return them: the state of the kept copy and the first line of the person's note. */
  kept?: KeptDisplay;
};

/**
 * A media file the publisher offers with an item (an RSS enclosure). The server never stores it: the
 * player and the apps' downloads fetch it from the publisher (plan/25).
 */
export type ItemMedia = {
  /** The publisher's address for the file; playing it streams from the publisher. */
  url: string;
  kind: "audio" | "video";
  /** Type and size as the feed declares them; either may be missing or wrong. */
  type: string | null;
  length: number | null;
};
/**
 * Where an item's playback stopped, kept per account and separate from reading progress and workflow.
 * `updatedAt`: when that position was recorded (on the device that played it, never later than the server's clock).
 */
export type PlaybackPosition = { positionSeconds: number; durationSeconds: number | null; updatedAt: string };
export const playbackSchema = z.object({
  positionSeconds: z.number().min(0).max(1_000_000),
  durationSeconds: z.number().min(0).max(1_000_000).nullable().default(null),
  /** When the device recorded this position, for one sent late (after playing offline). Absent: now. A position recorded before the stored one doesn't replace it. */
  recordedAt: z.string().datetime({ offset: true }).optional(),
});
export type ItemPage = {
  items: ItemDTO[]; nextCursor: string | null; total: number | null;
  /** First page only, when words are muted: how many more items the list would hold without them, counted among its first thousand candidates. */
  mutedHidden?: number;
  /** `mutedHidden` was counted in part of a long list: there may be more. */
  mutedHiddenAtLeast?: boolean;
};

export type CaptureDTO = {
  id: string;
  level: CaptureLevel;
  label: string; // "Saved details", "Feed content saved", "Full text captured", ...
  createdAt: string;
  note: string | null;
};
export type ItemDetail = ItemDTO & {
  contentHtml: string | null; // sanitized server-side; for kept items, the kept copy
  /** The feed's full text was too large to store: the item has its details and summary only, so say so and offer the original. */
  contentOmitted: boolean;
  /** The feed gave only a summary and no readable copy has been made: the full article stays on the original site. */
  summaryOnly: boolean;
  /** The original changed after it was kept: contentHtml shows the kept copy, latestHtml the current one. */
  changedSinceKept: boolean;
  latestHtml: string | null;
  /** Which stored text contentHtml is, so a highlight records the text it was made on (plan/26). */
  contentRef: TextRef | null;
  /** Which stored text latestHtml is. */
  latestRef: TextRef | null;
  captures: CaptureDTO[];
  keptVersionAt: string | null;
  enclosures: { url: string; type: string | null }[];
  collections: { id: string; name: string }[];
  playback: PlaybackPosition | null;
  /** A link kept by hand: its title is the person's own and can be changed. */
  renamable: boolean;
  /** a readable copy that failed the checks, behind a toggle; `contentHtml` is then the feed's own text. */
  partialCopy: PartialCopy | null;
  /** the item's own picture (`imageUrl`) as stored with a kept copy: a same-origin address that needs the session; null when not stored. */
  keptPicture: string | null;
};

export const itemScopeSchema = z.string().regex(/^(home|all|fresh|toread|loose|collection:[a-z0-9_]+|source:[a-z0-9_]+|basket:[a-z0-9_]+)$/);
/** Comma-separated source ids, as the source chips pick them. */
const sourceIdList = z.string().max(4000).regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/);
export const itemListQuerySchema = z.object({
  scope: itemScopeSchema.default("all"),
  filter: z.enum(["all", "fresh", ...WORKFLOW_STATES, "active", "open"]).default("active"), // active = everything but ignored; open = New and To read (Home)
  sort: z.enum(SORTS).default("newest"),
  q: z.string().max(200).optional(),
  /** Only items from these sources (comma separated). */
  source: sourceIdList.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** "1": leave out items of private sources, for what may show where others see it (a phone's home-screen and lock-screen widget). */
  exceptPrivate: z.literal("1").optional(),
  /** "home": a list as Home shows it: only sources with a box on Home, New items first, newest first within each state. */
  mix: z.literal("home").optional(),
  /** Item types to list, comma separated: articles, videos, podcasts. */
  type: z.string().regex(/^(articles|videos|podcasts)(,(articles|videos|podcasts))*$/).optional(),
  /** Only items of up to five minutes (reading or playing), or only longer ones. */
  length: z.enum(["short", "long"]).optional(),
  /** Leave these sources out of the list (comma separated). */
  without: sourceIdList.optional(),
  /** Items that match muted words are left out of lists (not of search) unless "show". */
  muted: z.enum(["hide", "show"]).optional(),
  /** Only items whose readable copy couldn't be saved. */
  capture: z.literal("failed").optional(),
});
export type ItemListQuery = z.input<typeof itemListQuerySchema>;
/** The most items one bulk action, delete or "Select all" takes. */
export const MAX_BULK_ITEMS = 5000;
/** GET /api/items/ids: every item a list shows (the list's own query without paging), for "Select all". */
export const itemIdsQuerySchema = itemListQuerySchema.omit({ cursor: true, limit: true });
export type ItemIdsQuery = z.input<typeof itemIdsQuerySchema>;
/** The items' ids in the list's order, at most MAX_BULK_ITEMS, and how many the list holds. */
export type ItemIds = { ids: string[]; total: number };
export type { Sort };

export const stateChangeSchema = z.object({
  workflow: z.enum(WORKFLOW_STATES).optional(),
  progress: z.number().min(0).max(1).optional(),
  opened: z.boolean().optional(),
  fresh: z.literal(false).optional(), // clearing a freshness marker; never sets read/workflow
  expectedRevision: z.number().int().min(0),
});
export type StateChange = z.infer<typeof stateChangeSchema>;

export const bulkActionSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(MAX_BULK_ITEMS),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("workflow"), workflow: z.enum(WORKFLOW_STATES) }),
    z.object({ type: z.literal("clearFresh") }),
    z.object({ type: z.literal("keep"), basketId: z.string() }),
    z.object({ type: z.literal("unkeep"), basketId: z.string() }),
  ]),
});
export type BulkResult = { changed: number; undoToken: string };

export const clearFreshSchema = z.object({ scope: itemScopeSchema });
export const undoSchema = z.object({ undoToken: z.string() });

// ---------- sources / discovery ----------
export type DiscoveryCandidate = {
  token: string; // opaque, server-held discovery result id
  title: string;
  kind: SourceDTO["kind"];
  origin: string;
  via: string; // "Posts feed", "Comments feed", "Channel feed"
  feedUrl: string;
  siteUrl: string | null;
  cadence: string | null; // "about 2 posts a week"
  samples: { title: string; publishedAt: string | null }[];
  summariesOnly: boolean;
  alreadyFollowingSourceId: string | null;
  privateWarning: string | null;
  /** A plain note about this candidate, e.g. that the feed didn't answer just now. */
  note?: string | null;
  /** found from a page: true when this feed is the page's own (it advertises it, or the feed is named like the page), false when it was only listed there. Absent for addresses that are feeds themselves. */
  matchesPage?: boolean;
  /** a source already followed under the same name (another address), so following this one makes a second. */
  sameNameSource?: { id: string; title: string } | null;
};
/** A page worth keeping as it is rather than following (a single video), with what could be learned about it. */
export type KeepOffer = { url: string; kind: "video" | "link"; title: string; siteName: string | null; author: string | null; imageUrl: string | null };
export type DiscoveryResult =
  | { ok: true; url: string; candidates: DiscoveryCandidate[]; keep?: KeepOffer }
  | { ok: false; url: string; reason: "invalid" | "blocked" | "unreachable" | "nofeed" | "unsupported" | "toolarge" | "timeout"; message: string };

export const discoverSchema = z.object({ url: z.string().trim().min(1).max(2000) });

// ---------- sources and discovery ----------
/** POST /api/discover/podcasts: shows whose name matches, from Apple's podcast directory. */
export const podcastSearchSchema = z.object({ query: z.string().trim().min(2).max(100) });
export type PodcastSearchHit = { name: string; author: string | null; artworkUrl: string | null; feedUrl: string; genre: string | null };
export type PodcastSearchResponse =
  | { ok: true; query: string; hits: PodcastSearchHit[] }
  | { ok: false; reason: "unreachable" | "timeout"; message: string };
export const followSchema = z.object({
  token: z.string(),
  collectionId: z.string().nullable(),
  newCollectionName: z.string().trim().min(1).max(80).nullable(),
  showOnHome: z.boolean().default(true),
  title: z.string().trim().min(1).max(200).optional(),
  markPrivate: z.boolean().default(false),
  fullText: z.boolean().default(false),
});
/** Items already in a source when full articles are turned on that also get a copy (newest unfinished first). */
export const FULL_TEXT_BACKFILL = 20;
export const sourcePatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  collectionIds: z.array(z.string()).max(20).optional(),
  paused: z.boolean().optional(),
  /** Pause for a week or a month (it resumes by itself) or until resumed. Takes the place of `paused: true`. */
  pauseFor: z.enum(["week", "month", "until-resumed"]).optional(),
  notify: z.enum(["default", "on", "muted"]).optional(),
  fullText: z.boolean().optional(),
});

// ---------- collections / baskets / queries ----------
export const collectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  emoji: z.string().max(8).nullable().default(null),
  mode: z.enum(["sources", "query"]).default("sources"),
  sourceIds: z.array(z.string()).max(500).default([]),
  query: queryNodeSchema.nullable().default(null),
  view: z.enum(["list", "cards", "board", "table", "timeline"]).default("list"),
});
export const collectionPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  emoji: z.string().max(8).nullable().optional(),
  view: z.enum(["list", "cards", "board", "table", "timeline"]).optional(),
  sourceIds: z.array(z.string()).max(500).optional(),
  query: queryNodeSchema.nullable().optional(),
  showOnHome: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});
export const basketCreateSchema = z.object({ name: z.string().trim().min(1).max(80), captureMode: z.enum(["metadata", "text"]).default("metadata") });
export const basketPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  captureMode: z.enum(["metadata", "text"]).optional(),
  position: z.number().int().min(0).optional(),
});
export const manualKeepSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  basketId: z.string(),
  title: z.string().trim().max(300).optional(),
  /** also save the page's readable text, whatever the basket does by itself. */
  readableText: z.boolean().optional(),
});
/** POST /api/items/manual. `existing`: PURSS already had this page, so that item was kept instead of a new one. */
export type ManualKeepResult = { itemId: string; existing: boolean; alreadyInBasket: boolean; captureQueued: boolean; captureNote: string | null };

/** Readable HTML of a page as the person's browser showed it, at most this many characters (plan/32). */
export const BROWSER_CAPTURE_MAX_CHARS = 2_000_000;
/**
 * POST /api/items/browser-capture: keep a page (like /api/items/manual) together with the readable
 * text the person's browser extracted from it. The server sanitizes the HTML and fetches nothing.
 */
export const browserCaptureSchema = manualKeepSchema.extend({ html: z.string().min(1).max(BROWSER_CAPTURE_MAX_CHARS) });
/** `textSaved`: the text was stored (replacing an earlier browser capture of the page when `textReplaced`). */
export type BrowserCaptureResult = ManualKeepResult & { textSaved: boolean; textReplaced: boolean; textNote: string | null };

/** GET /api/items/lookup?url= : what PURSS has for a page (plan/24). */
export type UrlLookup = {
  /**
   * The best match by the comparison key (a kept copy first), or null. `browserCapturedAt`: when its
   * text was last captured in the person's browser (plan/32), or null.
   */
  item: { id: string; title: string; url: string | null; workflow: WorkflowState; baskets: { id: string; name: string }[]; browserCapturedAt: string | null } | null;
  /** Followed sources whose site address contains this page. Following a site never means every page of it was collected. */
  followedSources: { id: string; title: string }[];
};

export type DeletePreview = {
  itemIds: string[];
  keptItems: { id: string; title: string; baskets: string[] }[];
  /** Items that carry the person's own highlights or notes, which are deleted with them. */
  annotatedItems: { id: string; title: string; annotations: number }[];
  releasesBytes: number;
  confirmToken: string;
};

// ---------- notifications / reminders ----------
export type NotificationDTO = { id: string; kind: "arrivals" | "source" | "reminder" | "system"; title: string; body: string | null; itemId: string | null; sourceId: string | null; createdAt: string; read: boolean;
  /** open the list with `capture: "failed"` (the items whose text couldn't be saved): the source's, or the basket's when `basketId` is set (kept links have no source of their own). */
  listFilter?: "capture-failed";
  basketId?: string };
export type ReminderDTO = { id: string; itemId: string; title: string; sourceTitle: string; basketName: string; keptAt: string; captureLabel: string };
export const reminderActionSchema = z.object({ action: z.enum(["hide", "snooze"]) });
export const discoverDismissSchema = z.object({ key: z.string().min(1).max(2048) });

// ---------- sharing a basket or collection ----------
export type ShareTarget = "basket" | "collection";
export type ShareDTO = {
  id: string;
  slug: string;
  targetKind: ShareTarget;
  targetId: string;
  /** The basket's or collection's name, which is the page's title. */
  title: string;
  description: string | null;
  curatorName: string;
  status: "draft" | "published" | "paused";
  publicUrl: string;
  feedUrl: string;
  /** This installation's page for following the feed (`/follow?url=…`), to share or put behind a button. */
  followUrl: string;
  publishedAt: string | null;
  /** Search engines may index the page. */
  listed: boolean;
  /** An administrator took the page down after a report; it can't be shared again until restored. */
  takenDown: { at: string; reason: string } | null;
  noteCount: number;
  /** Why visitors can't see it even if published: the basket or collection is gone, its filter rules now use reading state, or the plan no longer includes sharing. */
  problem: "gone" | "rules" | "plan" | null;
};
export const shareSettingsSchema = z.object({
  curatorName: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).nullable().default(null),
  listed: z.boolean().default(false),
  /** Confirms letting search engines list a page that is already public. */
  confirmListed: z.boolean().optional(),
});
/** The person's public note on one item of a shared page; null or empty removes it. */
export const shareNoteSchema = z.object({ note: z.string().trim().max(500).nullable() });
/** An item a shared page shows now, with the public note on it. `ownLink`: saved by the person, not from a feed. */
export type ShareItemDTO = { itemId: string; title: string; sourceTitle: string | null; publishedAt: string | null; note: string | null; ownLink: boolean };

// ---------- export / import ----------
/** `overPlan` explains why the account's plan has no room for the sources or collections it would add; null when it has. */
export type ImportPreview = { token: string; counts: Record<string, number>; conflicts: string[]; omitted: string[]; requiredBytes: number; fits: boolean; overPlan: string | null };

// ---------- admin ----------
/** One bridged service over the last `days` days: backend attempts by outcome, and answers the router gave from its cache without asking. */
export type BridgeServiceHealth = {
  id: string;
  /** What people call it ("Telegram"). */
  name: string;
  attempts: number;
  ok: number;
  /** A real feed with no posts in it: counted as a success. */
  empty: number;
  failed: number;
  cachedAnswers: number;
  /** Whole percent of attempts that were ok or empty; 100 only when none failed; null with no attempts. */
  successPercent: number | null;
};
/** A bridged source whose latest attempt failed. */
export type BridgeFailingSource = {
  service: string;
  serviceName: string;
  /** The service's handle for it ("durov"). */
  key: string;
  /** Its public page on the service; null when the service or key isn't one this server knows. */
  pageUrl: string | null;
  /** The router's word for what failed: "timeout", "unreachable", "too_large", "parse_error", "no_ids" or "http_<status>" ("unknown" for any other). */
  outcome: string;
  failingSince: string;
  lastOkAt: string | null;
  /** Attempts since it last worked. */
  attempts: number;
};
export type AdminBridgeHealth = {
  /** "unavailable": the egress service didn't give its bridge log, so the lists are empty. */
  status: "ok" | "unavailable";
  days: number;
  /** Every service this server bridges, in catalogue order, with zeros for one nobody has followed. */
  services: BridgeServiceHealth[];
  failing: BridgeFailingSource[];
};
/** A site people tried to follow without success, and how often over the last 30 days. */
export type DiscoveryMissDTO = { site: string; reason: "nofeed" | "unsupported" | "unreachable" | "timeout"; count: number };

export type AdminHealth = {
  engine: { status: string; version: string | null; lastSyncAt: string | null; lagSeconds: number | null; message: string | null };
  jobs: { queued: number; leased: number; failed: number; oldestQueuedSeconds: number | null };
  disk: { freeBytes: number | null; totalBytes: number | null; reserveBytes: number; growthPaused: boolean };
  database: { bytes: number | null; walBytes: number | null };
  sources: { total: number; failing: number; paused: number };
  accounts: { total: number };
  egress: { status: "ok" | "unavailable"; blockedLastHour: number | null };
  /** Null when this server runs no bridge for services that publish no feed (plan/41). */
  bridge: AdminBridgeHealth | null;
  /** The sites most often tried without success over the last 30 days, per reason, at most 20, most first. */
  discoveryMisses: DiscoveryMissDTO[];
  /** The installation is configured for open sign-up, but it is closed because outgoing email isn't set up or isn't working. */
  signupWaitingForMail: boolean;
  /** Null when outgoing email isn't set up. */
  mail: { status: "unchecked" | "ok" | "failing"; checkedAt: string | null; lastError: string | null; server: string; from: string; sentLastDay: number; failedLastDay: number } | null;
};
export type AdminJob = { id: string; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string; updatedAt: string; account: string | null };
export type AuditEventDTO = { id: string; at: string; actor: string | null; action: string; target: string | null; outcome: "success" | "failure"; detail: string | null };

export type SearchResult = {
  items: ItemDTO[];
  /** Per item id: a few words around the match, with each match wrapped in U+0001 … U+0002. */
  snippets: Record<string, string>;
  /** for items found only through a note: a few words of the note around the match, marked the same way. */
  noteSnippets?: Record<string, string>;
  sources: { id: string; title: string }[];
  collections: { id: string; name: string }[];
  baskets: { id: string; name: string }[];
};

// ---------- Home and background activity ----------
/** What Home shows above its boxes to someone coming back. Every part is empty when there is nothing to say. */
export type HomeOverview = {
  /** Start of the visit before this one; null on the first visit. */
  lastVisitAt: string | null;
  /** New items (still marked New) that arrived since then, by Home box; null on the first visit or when none. */
  since: { total: number; boxes: { id: string; name: string; count: number }[] } | null;
  /**
   * To read items that are not podcasts, oldest first. `total` leaves out the ones the muted words match among the first thousand;
   * with more than that, `totalAtMost` says the rest were not looked at, so the total may be too high.
   */
  toRead: { items: ItemDTO[]; total: number; totalAtMost: boolean };
  /** To read podcast episodes ("To listen"), counted the same way. */
  toListen: { items: ItemDTO[]; total: number; totalAtMost: boolean };
  recentlyKept: ItemDTO[];
  /** Every New marker in PURSS, for "Start fresh". */
  fresh: number;
  /** Items on Home that are Undecided and no longer New: the older pile that "up to date" must not hide. */
  unread: number;
  /** How many items on Home the muted words leave out, counted among the newest thousand. */
  mutedHidden: number;
  /** `mutedHidden` was counted in part of what Home holds: there may be more. */
  mutedHiddenAtLeast: boolean;
};
/** Home's "Other sources" box uses this id in the order list and the layout. */
export const OTHER_BOX_ID = "other";

export type ActivitySource = {
  id: string;
  title: string;
  health: SourceHealth;
  /** Plain words when the source has a problem or is waiting for its first items. */
  note: string | null;
  lastCheckedAt: string | null;
  lastItemAt: string | null;
  /** Items that arrived in the last 24 hours. */
  arrived: number;
};
export type ActivityEvent = {
  at: string;
  kind: "arrived" | "subscribed" | "problem" | "saved" | "save_failed";
  sourceId: string | null;
  text: string;
};
export type ActivityDTO = {
  /** A check of the sources is queued or running. */
  checking: boolean;
  /** How many sources that check covers. */
  sourceCount: number;
  /** Sources being set up with the engine. */
  subscribing: number;
  /** Readable-text copies being fetched. */
  savingText: number;
  lastCheckedAt: string | null;
  /** When the next check is expected; an estimate. */
  nextCheckAt: string | null;
  /** The last check failed, in words a person understands. */
  problem: string | null;
  sources: ActivitySource[];
  events: ActivityEvent[];
};

export type EventMessage =
  | { type: "items"; sourceIds: string[]; count: number }
  | { type: "source"; sourceId: string }
  | { type: "storage" }
  | { type: "notification" }
  | { type: "jobs" }
  | { type: "annotations"; itemId: string };

// ---------- assistant access (MCP) ----------
export type AssistantAccessLevel = "read" | "write";
export type AssistantTokenDTO = {
  id: string;
  name: string;
  access: AssistantAccessLevel;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};
/** An assistant connected with OAuth (plan/33): what the person approved on the consent page. */
export type AssistantGrantDTO = {
  id: string;
  /** As the assistant names itself; `clientHost` is who vouches for that name. */
  clientName: string;
  clientHost: string;
  redirectHost: string;
  access: AssistantAccessLevel;
  createdAt: string;
  lastUsedAt: string;
};
/** The account's view: whether the installation allows it, the account's own switch, its tokens and connected assistants. */
export type AssistantAccess = {
  /** The administrator turned assistant access on for this installation. */
  available: boolean;
  /** This account turned it on. Tokens and connected assistants only work while both are on. */
  enabled: boolean;
  /** The address assistants connect to. */
  endpoint: string;
  /** This installation lets assistants connect with OAuth (a sign-in page) as well as with tokens. */
  oauth: boolean;
  tokens: AssistantTokenDTO[];
  grants: AssistantGrantDTO[];
};
export type AssistantTokenCreated = { token: AssistantTokenDTO; secret: string };
export type AdminAssistantAccess = { enabled: boolean; oauth: boolean; accountsEnabled: number; tokens: number; grants: number };

/**
 * The consent page's view of an OAuth authorization request, from GET /api/assistant/oauth/request
 * (the request's query passed on as it came). "error" with a `redirectTo` sends the error back to
 * the assistant; without one the request can't be answered safely and the page only explains.
 */
export type OAuthRequestSummary =
  | {
    kind: "ask";
    /** The request's parameters as the server read them; approving sends exactly these back. */
    request: Record<string, string>;
    clientId: string;
    clientName: string;
    clientHost: string;
    redirectHost: string;
    /** The code goes to a program on this computer (http://localhost…). */
    loopbackRedirect: boolean;
    /** What the assistant asked for; the person may allow less. */
    access: AssistantAccessLevel;
    /** Sends the assistant "access_denied". */
    declineUrl: string;
    /** The plan/23 switches: approving needs both on. */
    available: boolean;
    enabled: boolean;
  }
  | { kind: "error"; message: string; redirectTo: string | null };
export type OAuthApproveResult = { redirectTo: string };
export const oauthApproveSchema = z.object({
  request: z.record(z.string().max(40), z.string().max(4000)),
  access: z.enum(["read", "write"]),
});

export const assistantSwitchSchema = z.object({ enabled: z.boolean() });
export const assistantTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  access: z.enum(["read", "write"]).default("read"),
  /** Days until the token stops working; null for no expiry. */
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(90),
});

// ---------- connected apps (plan/24) ----------
export const CONNECT_CLIENT_KINDS = ["mobile", "extension"] as const;
export type ConnectClientKind = (typeof CONNECT_CLIENT_KINDS)[number];

/** GET /api/connect/info: unauthenticated, lets an app check that an address is a PURSS. */
export type ConnectInfo = {
  service: "purss";
  name: string;
  origin: string;
  hosted: boolean;
  /** This server's version (plan/40); null when it was built without one. */
  version: string | null;
  connect: {
    /** Open in the system browser with client, redirect_uri, state, code_challenge, code_challenge_method=S256, device_name. */
    page: string;
    /** POST { client, code, codeVerifier, redirectUri? } -> ConnectTokenResult. */
    token: string;
    codeChallengeMethods: ["S256"];
    clients: Record<ConnectClientKind, { redirectUris: string[]; typedCode: true }>;
  };
  /**
   * The mobile app can accept an invitation itself: POST `endpoint` (ConnectSignupInput) answers with a device token.
   * `start`, where sign-up is open, takes `{ email }` and emails a link whose page finishes the account in the browser.
   */
  signup: { endpoint: string; start: string | null; passwordMin: number };
  /**
   * The mobile app signs in itself: POST `endpoint` (ConnectSigninInput) answers with a device token.
   * `passkey` is offered where PURSS vouches for the app (its passkeys work there); its challenge
   * comes from `passkeyOptions`. Linked accounts sign in through `connect.page` in a browser tab over the app.
   * `passwordReset` (POST { identifier }) emails a reset link and `passwordResetConfirm` (POST { token,
   * password }) sets the new password from it; both null where this PURSS doesn't use email for accounts.
   */
  signin: {
    endpoint: string; methods: ("password" | "passkey")[]; passkeyOptions: string | null; passwordReset: string | null; passwordResetConfirm: string | null;
    /** External sign-ins set up here; each `start` opens in the system browser (`?next=` an in-app path to return to) and, once signed in, leads to `connect.page`. */
    providers?: { id: string; label: string; start: string }[];
  };
  features: { urlLookup: true; browserCapture: true };
};

/** What the approval page shows, from GET /api/connect/request. */
export type ConnectRequestSummary = {
  client: ConnectClientKind;
  deviceName: string;
  /** Where the code goes; null when the person types it into the app. */
  redirect: { uri: string; label: string } | null;
  /** Sends the app "access_denied"; null for typed codes. */
  declineUrl: string | null;
};
export type ConnectApproveResult = { redirectTo: string; code?: undefined } | { code: string; expiresInMinutes: number; redirectTo?: undefined };

export type DeviceDTO = { id: string; kind: ConnectClientKind; name: string; createdAt: string; lastUsedAt: string; current: boolean };
export type ConnectTokenResult = { token: string; tokenType: "Bearer"; device: DeviceDTO };

export const connectRequestSchema = z.object({
  client: z.enum(CONNECT_CLIENT_KINDS),
  redirect_uri: z.string().max(300).optional(),
  state: z.string().min(8).max(500).regex(/^[\x21-\x7e]+$/).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  device_name: z.string().max(200).optional(),
});
export const connectApproveSchema = connectRequestSchema.extend({ device_name: z.string().trim().min(1).max(80) });
/** Signing in from the mobile app: an email address and password, or a passkey. */
export const connectSigninSchema = z.discriminatedUnion("method", [
  z.object({ client: z.literal("mobile"), method: z.literal("password"), email: z.string().max(300), password: z.string().min(1).max(1024), deviceName: z.string().max(200).optional() }),
  // A passkey answer to the challenge from POST /api/connect/passkey/options.
  z.object({ client: z.literal("mobile"), method: z.literal("passkey"), challengeId: z.string().max(100), response: z.record(z.string(), z.unknown()), deviceName: z.string().max(200).optional() }),
]);
export type ConnectSigninInput = z.input<typeof connectSigninSchema>;

/** Accepting an invitation from the mobile app: the code and the address it is for. */
export const connectSignupSchema = z.object({
  client: z.literal("mobile"),
  invitation: z.string().trim().min(4).max(60),
  email: z.string().trim().max(254),
  displayName: z.string().trim().max(60).nullable().default(null),
  password: z.string().min(1).max(1024),
  deviceName: z.string().max(200).optional(),
});
export type ConnectSignupInput = z.input<typeof connectSignupSchema>;

export const connectTokenSchema = z.object({
  client: z.enum(CONNECT_CLIENT_KINDS),
  code: z.string().min(1).max(200),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.string().max(300).optional(),
});

// ---------- phone notifications (plan/37) ----------
/** A handle from the push relay (apps/push-relay): all a PURSS knows of a phone's push address. */
export const PUSH_HANDLE_PATTERN = /^rh_[A-Za-z0-9_-]{43}$/;
/** GET /api/push, for the phone app: the relay this PURSS sends through (null: phone notifications are off here) and whether this app is registered. */
export type PushInfo = { relay: string | null; registered: boolean };
/** POST /api/push/device: the app's relay handle, and the relay it came from (must be PURSS's). */
export const pushRegisterSchema = z.object({ relay: z.string().min(1).max(300), handle: z.string().regex(PUSH_HANDLE_PATTERN) }).strict();
/** The credential the phone's notification code fetches texts with (POST /api/push/pending), shown once. */
export type PushRegisterResult = { fetchToken: string };
/** A notification as the phone shows it. `body` is filled only when the person shows titles in notifications. */
export type PushNotice = { id: string; title: string; body: string | null; itemId: string | null; sourceId: string | null };
export type PushPending = { notifications: PushNotice[] };
// ---------- "Remind me" on kept items ----------
/** A date set on a kept item with "Remind me": the person's own calendar day, and an optional note. */
export type ItemReminderDTO = {
  id: string;
  itemId: string;
  /** The day, "YYYY-MM-DD", in the person's time zone. */
  remindOn: string;
  note: string | null;
  title: string;
  sourceTitle: string;
  kind: ItemKind;
};
/** What Home's "Coming up" shows: today's date in the person's zone and the reminders from today through the next days, soonest first. */
export type ComingUp = { today: string; days: number; reminders: ItemReminderDTO[] };
export const itemReminderSchema = z.object({
  remindOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(300).nullable().default(null),
});
/** Longest note on a reminder. */
export const REMINDER_NOTE_MAX = 300;
/** Days Home's "Coming up" looks ahead, today included. */
export const COMING_UP_DAYS = 7;

// ---------- captured text honesty ----------
/** Why a readable copy is only part of the page: a sign-in, subscription or consent page; mostly a list of references; shorter than the feed's own text. */
export type PartialReason = "gated" | "references" | "short";
/**
 * A readable copy that failed the checks. It is kept, but it is not "the full text": the reader shows the feed's own text
 * (`contentHtml`) first and this behind a toggle, saying `note`. `ref` is the stored text a highlight made on it records.
 */
export type PartialCopy = { html: string; reason: PartialReason; note: string; ref: TextRef };

// ---------- kept copies and notes in lists ----------
/**
 * What a basket's lists say about a kept item's copy: "text" the readable text was saved; "partial" only part of the page was;
 * "summary" the link, title and summary only; "pending" the text is being saved; "failed" it couldn't be saved.
 */
export type KeptCopy = "text" | "partial" | "summary" | "pending" | "failed";
export type KeptDisplay = { copy: KeptCopy; noteLine: string | null };
