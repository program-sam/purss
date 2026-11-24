import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseBridgeDescriptor } from "@purss/connectors";
import type { SourceDTO, SourceHealth } from "@purss/domain";
import type { App } from "../app.ts";
import { nowIso } from "../http.ts";
import { ensureDir, readSecret } from "../secrets.ts";
import { isNewsFeed } from "./news-address.ts";
import type { StartFrom } from "./sync.ts";
import { urlKey } from "./url-key.ts";

/*
 * Which source an address is. Following, following again, the OPML preview, an OPML import and an archive import all ask
 * the same question (does this account already have this feed?) and make or take up a source the same way, so the answer and
 * the rows live here.
 *
 * - A public feed is the same feed when its address is the same up to what never changes which feed a server sends: http or
 *   https, a trailing slash, the host's case, tracking parameters (urlKey). A bridged source (`bridge:telegram/durov`) is its
 *   descriptor, and a list also names it by the page the descriptor stands for. Any other spelling is another feed.
 * - A private source has no address in the database. A link is the same link by a keyed hash of the account and the address
 *   (the scheme and the query count, so a link is looked up under both schemes), and only while the source is followed: following
 *   it ends the link's file. An archive carries no private link at all (it would not be private), so it can only say a private
 *   source by its title: see portability.ts.
 * - An unfollowed source keeps its items. Following the same feed again takes that source up again; a second one would hold a
 *   second copy of everything, and the first copy could no longer be reached or cleaned up.
 * - This installation's own news is a built-in source that the engine never subscribes to.
 */

/** The same address in a form that doesn't depend on the host's case, a fragment or a trailing slash; the scheme and the query count. */
function canonicalFeedKey(href: string): string {
  const u = new URL(href);
  const path = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** Whether two addresses are one address written alike (the host's case, a fragment and a trailing slash aside): how a looked-up feed is the address that was asked for. */
export function sameFeedAddress(a: string, b: string): boolean {
  try { return canonicalFeedKey(a) === canonicalFeedKey(b); } catch { return false; }
}

/** The address with the other scheme (http and https), or null. */
function otherScheme(feedUrl: string): string | null {
  if (feedUrl.startsWith("https://")) return `http://${feedUrl.slice(8)}`;
  if (feedUrl.startsWith("http://")) return `https://${feedUrl.slice(7)}`;
  return null;
}

/** A bridged source's descriptor (`bridge:telegram/durov`) when it names a listed service and key, else null. */
export function bridgeAddress(value: string | null | undefined): string | null {
  return value && parseBridgeDescriptor(value) ? value.trim() : null;
}

/** What says two public feed addresses are one feed: a bridged source's descriptor, else the address without what never changes the feed. Null for text that is neither. */
export const feedKey = (feedUrl: string): string | null => bridgeAddress(feedUrl) ?? urlKey(feedUrl);

const KEY_FILE = "feed-key";
/** What is hashed, so that a change to it is noticed and every key is made again. */
const SCHEME = "purss feed key: account and canonical address";
/** The database remembers which key made its keys, as a fingerprint that says nothing about the key. */
const FINGERPRINT_ROW = "feed_key_check";
/** A whole key is 32 random bytes in base64url. */
const MIN_KEY_CHARS = 40;

const keys = new WeakMap<App, string>();

/** Write a file whole or not at all: a crash leaves the old file or the new one, never half of one. */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${text}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * The key, made once and kept in the secrets folder. A missing or damaged file is made again (with a new key); what that does to the
 * keys already in the database is dealt with by `keyFor`, which compares the key with the fingerprint the database remembers.
 */
function readOrMakeKey(app: App): string {
  const existing = readSecret(app.config.secretsDir, KEY_FILE);
  if (existing && existing.length >= MIN_KEY_CHARS) return existing;
  ensureDir(app.config.secretsDir);
  const fresh = randomBytes(32).toString("base64url");
  writeAtomically(path.join(app.config.secretsDir, KEY_FILE), fresh);
  return fresh;
}

const fingerprintOf = (key: string): string => createHmac("sha256", key).update("fingerprint of the key that makes private feed keys").digest("hex");

const hash = (key: string, accountId: string, canonical: string): string => createHmac("sha256", key).update(`${SCHEME}\n${accountId}\n${canonical}`).digest("hex");

/**
 * The key for this process. The first time it is asked for, it is checked against the fingerprint stored in the database. When
 * they differ the key file was lost, damaged or replaced (or the keys were made by an older scheme): every private source's key is
 * made again from its link file, and a source with no link file keeps none. That is said in the log, unless the database
 * had no fingerprint yet, which is the first run.
 */
function keyFor(app: App): string {
  const cached = keys.get(app);
  if (cached) return cached;
  const key = readOrMakeKey(app);
  const fingerprint = fingerprintOf(key);
  const stored = app.db.get<{ value: string }>("SELECT value FROM installation WHERE key = ?", FINGERPRINT_ROW)?.value ?? null;
  if (stored !== fingerprint) {
    if (stored !== null) {
      console.warn("[api] secrets/feed-key is not the key the private feed keys were made with (it was lost, damaged or replaced); making every private source's key again from its link file");
    }
    app.db.tx(() => {
      for (const s of app.db.all<{ id: string; account_id: string }>("SELECT id, account_id FROM sources WHERE is_private = 1")) {
        const link = readSecret(app.config.secretsDir, `source-urls/${s.id}`);
        let made: string | null = null;
        if (link) { try { made = hash(key, s.account_id, canonicalFeedKey(link)); } catch { made = null; } }
        app.db.run("UPDATE sources SET feed_key = ? WHERE id = ?", made, s.id);
      }
      app.db.run("INSERT INTO installation (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", FINGERPRINT_ROW, fingerprint);
    });
  }
  keys.set(app, key);
  return key;
}

/**
 * A keyed hash (HMAC-SHA-256, key from the secrets folder) of a feed address and the account that follows it: how a private
 * source, which has no address in the database, is found again when the same link is looked up or listed a second time. The
 * account is part of it, so two accounts following the same link have unrelated keys. Nobody holding only the database can use
 * it to test a guessed link. Null for text that is no address.
 */
export function privateFeedKey(app: App, accountId: string, feedUrl: string): string | null {
  let canonical: string;
  try { canonical = canonicalFeedKey(feedUrl); } catch { return null; }
  return hash(keyFor(app), accountId, canonical);
}


/** A source an address is, and what it was when it was found. */
export type SourceMatch = { id: string; title: string; followed: boolean };

/** One account's sources by what they answer to, so many addresses can be asked of one pass over the rows (a list of thousands of feeds). */
export type SourceIndex = {
  /**
   * The source of this address: the followed one (the oldest, if several), else the unfollowed one that was followed last. The
   * address is a feed address, a bridged source's descriptor or the page a bridged source stands for; for a private link the
   * keyed hash is looked up under both schemes. This installation's own news address is only ever the built-in news source.
   */
  find(address: string): SourceMatch | undefined;
};

type IndexedSource = SourceMatch & { builtin: string | null; order: number };

/** What a stored source answers to. */
function storedKeys(s: { feed_url: string | null; feed_key: string | null; followed: number }): string[] {
  const found: string[] = [];
  if (s.feed_url) {
    found.push(`exact:${s.feed_url}`);
    // A list names a bridged source by its page, as the OPML export writes it.
    const bridged = parseBridgeDescriptor(s.feed_url);
    const key = bridged ? urlKey(bridged.service.pageUrl(bridged.key)) : urlKey(s.feed_url);
    if (key) found.push(`address:${key}`);
  }
  // An unfollowed private source has lost its link file, so nothing asked later is that link.
  if (s.feed_key && s.followed) found.push(`private:${s.feed_key}`);
  return found;
}

export function sourceIndex(app: App, accountId: string): SourceIndex {
  // Keys the sources were made without (before keys existed, or with a key that was lost) are made first, so they are in the rows read next.
  keyFor(app);
  const byKey = new Map<string, IndexedSource[]>();
  app.db.all<{ id: string; title: string; followed: number; builtin: string | null; feed_url: string | null; feed_key: string | null }>(
    "SELECT id, title, followed, builtin, feed_url, feed_key FROM sources WHERE account_id = ? AND (feed_url IS NOT NULL OR feed_key IS NOT NULL) ORDER BY created_at, id", accountId,
  ).forEach((s, order) => {
    const source: IndexedSource = { id: s.id, title: s.title, followed: s.followed === 1, builtin: s.builtin, order };
    for (const key of storedKeys(s)) {
      const same = byKey.get(key);
      if (same) same.push(source); else byKey.set(key, [source]);
    }
  });
  return {
    find(address) {
      const asked = [`exact:${address}`];
      const key = urlKey(address);
      if (key) asked.push(`address:${key}`);
      if (!parseBridgeDescriptor(address)) {
        for (const form of [address, otherScheme(address)]) {
          const hashed = form ? privateFeedKey(app, accountId, form) : null;
          if (hashed) asked.push(`private:${hashed}`);
        }
      }
      const found = new Set(asked.flatMap((k) => byKey.get(k) ?? []));
      const followed = [...found].filter((s) => s.followed).sort((a, b) => a.order - b.order)[0];
      if (followed) return followed;
      const news = isNewsFeed(app, address);
      return [...found].filter((s) => news ? s.builtin === "news" : true).sort((a, b) => b.order - a.order)[0];
    },
  };
}

/** The source of one address; to ask about many, `sourceIndex` reads the rows once. */
export function findSource(app: App, accountId: string, address: string): SourceMatch | undefined {
  return sourceIndex(app, accountId).find(address);
}

export type NewSource = {
  id: string;
  accountId: string;
  kind: SourceDTO["kind"] | "manual";
  title: string;
  origin: string;
  hue: number;
  health: SourceHealth;
  createdAt: string;
  healthText?: string | null;
  siteUrl?: string | null;
  /** A public feed's address, or a bridged source's descriptor. */
  feedUrl?: string | null;
  /**
   * Makes the source a private one: no address is stored, only the keyed hash of this link, which is not stored either (the
   * caller keeps it in the secrets folder). Null for a private source whose link has yet to be given again.
   */
  privateLink?: string | null;
  fullText?: boolean;
  /** What it does with its backlog; a source that does not say follows the way sources did before the choice existed (`all`). */
  startFrom?: StartFrom;
  viaGateway?: boolean;
  /** How the person found it, when they did (the discovery route and entry the administrator's record counts). */
  discovery?: { route: string; entry: string };
  curator?: string | null;
  followed?: boolean;
  paused?: boolean;
  notify?: SourceDTO["notify"];
  lastItemAt?: string | null;
};

/**
 * The one source row. A private source keeps no address in the database. This installation's own news is made built in and
 * healthy: the engine never subscribes to it, so `news` says there is nothing for the caller to queue.
 */
export function insertSource(app: App, s: NewSource): { news: boolean } {
  const isPrivate = s.privateLink !== undefined;
  const news = !isPrivate && !!s.feedUrl && isNewsFeed(app, s.feedUrl);
  app.db.run(
    `INSERT INTO sources (id, account_id, kind, title, origin, site_url, feed_url, feed_key, is_private, curator, hue, followed, paused, notify, full_text, start_from,
       health, health_text, builtin, last_item_at, created_at, via_gateway, discovery_route, discovery_entry)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id, s.accountId, isPrivate ? "private" : s.kind, s.title, s.origin, s.siteUrl ?? null, isPrivate ? null : s.feedUrl ?? null,
    s.privateLink ? privateFeedKey(app, s.accountId, s.privateLink) : null, isPrivate ? 1 : 0, s.curator ?? null, s.hue, s.followed === false ? 0 : 1, s.paused ? 1 : 0, s.notify ?? "default",
    s.fullText ? 1 : 0, s.startFrom ?? "all", news ? "ok" : s.health, s.healthText ?? null, news ? "news" : null, s.lastItemAt ?? null, s.createdAt, s.viaGateway ? 1 : 0,
    s.discovery?.route ?? null, s.discovery?.entry ?? null,
  );
  return { news };
}

/** What following a source again makes of what the feed says it is now; a source taken up from an archive keeps what it was. */
export type Revival = {
  kind: SourceDTO["kind"];
  title: string;
  origin: string;
  siteUrl: string | null;
  hue: number;
  fullText: boolean;
  startFrom: StartFrom;
  viaGateway: boolean;
  discovery: { route: string; entry: string };
};

/**
 * Take an unfollowed source up again. What the feed already has is backlog again, not New: the posts stored the first time keep what
 * they were, and only what arrives now is the backlog of this follow. The engine has yet to confirm the new subscription (`news`:
 * there is none, as this installation's own news never has one, so the source is healthy at once).
 */
export function reviveSource(app: App, id: string, profile?: Revival): { news: boolean } {
  const news = app.db.get<{ builtin: string | null }>("SELECT builtin FROM sources WHERE id = ?", id)?.builtin === "news";
  const set: Record<string, string | number | null> = {
    followed: 1, paused: 0, engine_stream_id: null, health: news ? "ok" : "pending", health_text: null, created_at: nowIso(),
    backlog_settled_at: null, subscribed_at: null, unfollowed_at: null,
  };
  if (profile) {
    Object.assign(set, {
      kind: profile.kind, title: profile.title, origin: profile.origin, site_url: profile.siteUrl, hue: profile.hue, full_text: profile.fullText ? 1 : 0, start_from: profile.startFrom,
      via_gateway: profile.viaGateway ? 1 : 0, discovery_route: profile.discovery.route, discovery_entry: profile.discovery.entry,
    });
  }
  app.db.run(`UPDATE sources SET ${Object.keys(set).map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, ...Object.values(set), id);
  return { news };
}
