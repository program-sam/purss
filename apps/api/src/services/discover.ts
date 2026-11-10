import { createHash } from "node:crypto";
import { DISCOVER_MIN_READERS } from "@purss/domain";
import type { DiscoverResponse, DiscoverSuggestion } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { notFound, nowIso } from "../http.ts";
import { usableAccountSql } from "./deletion.ts";
import { privateFeedKey } from "./feed-keys.ts";
import { getPreferences } from "./preferences.ts";
import { bridgeAddress } from "./feed-keys.ts";
import { urlKey } from "./url-key.ts";

/** The co-follow key of a feed address: a web address without its noise, or a bridged source's descriptor (plan/41). */
const feedKey = (feedUrl: string): string | null => bridgeAddress(feedUrl) ?? urlKey(feedUrl);

/*
 * Discover (hosted installations only; a self-hosted installation never builds, keeps or serves any
 * of it). Readers who follow the same sources tend to like each other's other sources, so the
 * installation keeps a co-follow graph: for every two public sources, how many accounts follow both.
 *
 * Privacy:
 * - Only accounts that share (preference `discoveryShare`, on unless switched off) and are usable
 *   count, and only they get suggestions, and only their followed public feed, YouTube and podcast sources. Private sources (their
 *   address is a secret), manual sources and followed shared collections never count.
 * - A source enters the graph only when at least MIN_READERS different accounts follow it, and a
 *   pair only when MIN_READERS accounts follow both, so a suggestion never points at one person.
 * - The aggregate tables hold counts only, no account or PURSS. Counts never leave the server:
 *   a suggestion says which of the reader's own sources led to it, never how many people.
 * - A title or site shown for a suggestion is used by at least MIN_READERS of its followers, so a
 *   name someone gave their own copy of a source never shows to anyone else.
 *
 * Suggestions score each candidate by cosine similarity summed over the reader's sources
 * (together / sqrt(followers(a) * followers(b))), so a huge source isn't suggested to everyone.
 * Chance: each score gets Gumbel noise drawn from a seed of the reader and the day, so the order
 * varies from day to day but holds within a day, and every fourth place is a wildcard drawn from the
 * popular sources. Someone whose sources match nothing (a new account) gets popular sources with noise.
 */

export const MIN_READERS = DISCOVER_MIN_READERS;
/** Suggestions shown at once. */
export const SUGGESTIONS = 20;
const REBUILD_MS = 6 * 60 * 60 * 1000;
/** A change in who shares rebuilds within a minute, but never more often than that. */
const DIRTY_REBUILD_MS = 60 * 1000;
/** How much chance reorders matched suggestions (on log-scores) and popular ones (on log-followers). */
const MATCH_NOISE = 0.35;
const POPULAR_NOISE = 1;
/** Every WILDCARD_EVERY-th place goes to a popular source, for variety. */
const WILDCARD_EVERY = 4;
const KINDS = ["feed", "youtube", "podcast"] as const;
type Kind = (typeof KINDS)[number];

export type FollowRow = { account_id: string; feed_url: string; title: string; site_url: string | null; kind: Kind };
export type AggregateSource = { key: string; feedUrl: string; title: string; host: string | null; kind: Kind; followers: number };
export type Aggregates = { sources: AggregateSource[]; pairs: { a: string; b: string; together: number }[] };

function top<T>(counts: Map<T, number>): [T, number] | null {
  let best: [T, number] | null = null;
  for (const [v, n] of counts) if (!best || n > best[1] || (n === best[1] && String(v) < String(best[0]))) best = [v, n];
  return best;
}
const bump = <T>(m: Map<T, number>, v: T) => m.set(v, (m.get(v) ?? 0) + 1);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") || null : null; } catch { return null; }
}

/** The co-follow graph of the given follows, holding only sources and pairs with at least `min` accounts. Pure. */
export function buildAggregates(rows: FollowRow[], min = MIN_READERS): Aggregates {
  type Acc = { accounts: Set<string>; schemes: Map<string, number>; titles: Map<string, number>; hosts: Map<string, number>; kinds: Map<Kind, number> };
  const byKey = new Map<string, Acc>();
  const keysOf = new Map<string, Set<string>>();
  for (const r of rows) {
    let u: URL;
    try { u = new URL(r.feed_url); } catch { continue; }
    if (u.username || u.password) continue; // an address with a name or password in it is someone's own
    const key = feedKey(r.feed_url);
    if (!key) continue;
    let a = byKey.get(key);
    if (!a) { a = { accounts: new Set(), schemes: new Map(), titles: new Map(), hosts: new Map(), kinds: new Map() }; byKey.set(key, a); }
    if (a.accounts.has(r.account_id)) continue; // one vote per account, even if it follows the same feed twice
    a.accounts.add(r.account_id);
    bump(a.schemes, u.protocol.slice(0, -1));
    bump(a.titles, r.title.trim());
    const host = hostOf(r.site_url) ?? hostOf(r.feed_url);
    if (host) bump(a.hosts, host);
    bump(a.kinds, r.kind);
    let ks = keysOf.get(r.account_id);
    if (!ks) keysOf.set(r.account_id, (ks = new Set()));
    ks.add(key);
  }

  const sources: AggregateSource[] = [];
  const eligible = new Set<string>();
  for (const [key, a] of byKey) {
    if (a.accounts.size < min) continue;
    const host = top(a.hosts);
    const title = top(a.titles);
    // A shown title or site must itself be used by `min` accounts, like the source; otherwise the feed's host shows.
    const shownHost = host && host[1] >= min ? host[0] : null;
    const shownTitle = title && title[0] && title[1] >= min ? title[0] : shownHost ?? key.split("/")[0]!;
    sources.push({ key, feedUrl: key.startsWith("bridge:") ? key : `${top(a.schemes)![0]}://${key}`, title: shownTitle, host: shownHost, kind: top(a.kinds)![0], followers: a.accounts.size });
    eligible.add(key);
  }

  const together = new Map<string, number>();
  for (const ks of keysOf.values()) {
    const mine = [...ks].filter((k) => eligible.has(k)).sort();
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) bump(together, `${mine[i]}\n${mine[j]}`);
  }
  const pairs: Aggregates["pairs"] = [];
  for (const [ab, n] of together) {
    if (n < min) continue;
    const [a, b] = ab.split("\n") as [string, string];
    pairs.push({ a, b, together: n }, { a: b, b: a, together: n });
  }
  return { sources, pairs };
}

/** The follows that count: usable accounts that share, their followed public sources of the kinds above. */
function sharedFollows(app: App): FollowRow[] {
  return app.db.all<FollowRow>(
    `SELECT s.account_id, s.feed_url, s.title, s.site_url, s.kind FROM sources s
     WHERE s.followed = 1 AND s.is_private = 0 AND s.feed_url IS NOT NULL AND s.kind IN (${KINDS.map((k) => `'${k}'`).join(", ")})
       AND ${usableAccountSql("s.account_id")}
       AND COALESCE((SELECT json_extract(p.value, '$.discoveryShare') FROM preferences p WHERE p.workspace_id = s.workspace_id), 1) = 1`);
}

/** Replace the graph with one built from the follows that count now. */
export function rebuildDiscovery(app: App, min = MIN_READERS): void {
  const { sources, pairs } = buildAggregates(sharedFollows(app), min);
  app.db.tx(() => {
    app.db.run("DELETE FROM discovery_pairs");
    app.db.run("DELETE FROM discovery_sources");
    for (const s of sources) app.db.run("INSERT INTO discovery_sources (key, feed_url, title, host, kind, followers) VALUES (?, ?, ?, ?, ?, ?)", s.key, s.feedUrl, s.title, s.host, s.kind, s.followers);
    for (const p of pairs) app.db.run("INSERT INTO discovery_pairs (a, b, together) VALUES (?, ?, ?)", p.a, p.b, p.together);
    app.db.run("UPDATE discovery_state SET built_at = ?, dirty = 0", nowIso());
  });
}

/** From the maintenance tick: rebuild when due on a hosted installation; on a self-hosted one, keep nothing. */
export function runDiscoveryPass(app: App, now = Date.now()): void {
  const st = app.db.get<{ built_at: string | null; dirty: number }>("SELECT built_at, dirty FROM discovery_state WHERE id = 1");
  if (!st) return;
  if (app.config.mode !== "hosted") {
    if (st.built_at || app.db.get("SELECT 1 FROM discovery_sources LIMIT 1")) {
      app.db.tx(() => {
        app.db.run("DELETE FROM discovery_pairs");
        app.db.run("DELETE FROM discovery_sources");
        app.db.run("UPDATE discovery_state SET built_at = NULL, dirty = 0");
      });
    }
    return;
  }
  const age = st.built_at ? now - Date.parse(st.built_at) : Infinity;
  if (age >= REBUILD_MS || (st.dirty && age >= DIRTY_REBUILD_MS)) rebuildDiscovery(app);
}

/** A number in (0, 1) fixed by the seed. */
function unit(seed: string): number {
  const n = createHash("sha256").update(seed).digest().readUIntBE(0, 6);
  return (n + 0.5) / 2 ** 48;
}
const gumbel = (seed: string) => -Math.log(-Math.log(unit(seed)));

export type Candidate = { key: string; score: number; because: string[] };

/**
 * Order matched candidates and popular sources into at most `limit` suggestions, with chance
 * seeded by `seed`. Pure. `popular` is every source with its follower count; anything in `skip` is left out.
 */
export function arrange(matched: Candidate[], popular: { key: string; followers: number }[], skip: Set<string>, seed: string, limit = SUGGESTIONS):
  { key: string; reason: DiscoverSuggestion["reason"]["kind"]; because: string[] }[] {
  const noisy = matched.filter((c) => c.score > 0 && !skip.has(c.key))
    .map((c) => ({ c, v: Math.log(c.score) + MATCH_NOISE * gumbel(`${seed}:m:${c.key}`) }))
    .sort((x, y) => y.v - x.v).map((x) => x.c);
  const pop = popular.filter((p) => !skip.has(p.key))
    .map((p) => ({ key: p.key, v: Math.log(p.followers) + POPULAR_NOISE * gumbel(`${seed}:p:${p.key}`) }))
    .sort((x, y) => y.v - x.v).map((x) => x.key);
  const out: ReturnType<typeof arrange> = [];
  const used = new Set<string>();
  let mi = 0, pi = 0;
  const nextPopular = () => { while (pi < pop.length && used.has(pop[pi]!)) pi++; return pi < pop.length ? pop[pi++]! : null; };
  const nextMatched = () => { while (mi < noisy.length && used.has(noisy[mi]!.key)) mi++; return mi < noisy.length ? noisy[mi++]! : null; };
  while (out.length < limit) {
    const wildcardSlot = noisy.length > 0 && (out.length + 1) % WILDCARD_EVERY === 0;
    const m = wildcardSlot ? null : nextMatched();
    if (m) { used.add(m.key); out.push({ key: m.key, reason: "because", because: m.because }); continue; }
    const p = nextPopular();
    if (p) { used.add(p); out.push({ key: p, reason: noisy.length > 0 ? "wildcard" : "popular", because: [] }); continue; }
    if (wildcardSlot) { const again = nextMatched(); if (again) { used.add(again.key); out.push({ key: again.key, reason: "because", because: again.because }); continue; } }
    break;
  }
  return out;
}

const CHUNK = 400;

/** Suggestions for the signed-in account. Not found on a self-hosted installation. */
export function suggestionsFor(app: App, p: Principal, now = new Date()): DiscoverResponse {
  if (app.config.mode !== "hosted") throw notFound("Discover");
  // Suggestions are for readers who share their own sources: that is the exchange. Until the graph holds
  // a source, there is nothing to suggest to anyone and the page says it is coming.
  const sharing = getPreferences(app, p.workspaceId).discoveryShare;
  const ready = !!app.db.get("SELECT 1 FROM discovery_sources LIMIT 1");
  if (!sharing || !ready) return { sharing, ready, suggestions: [] };
  // What the reader follows, followed once, or said no to never comes back as a suggestion.
  const own = app.db.all<{ id: string; feed_url: string; followed: number }>(
    "SELECT id, feed_url, followed FROM sources WHERE workspace_id = ? AND feed_url IS NOT NULL ORDER BY created_at, id", p.workspaceId);
  const skip = new Set<string>();
  const mine = new Map<string, string>(); // key -> the reader's source id
  for (const s of own) {
    const k = feedKey(s.feed_url);
    if (!k) continue;
    skip.add(k);
    if (s.followed && !mine.has(k)) mine.set(k, s.id);
  }
  for (const d of app.db.all<{ key: string }>("SELECT key FROM discovery_dismissed WHERE workspace_id = ?", p.workspaceId)) skip.add(d.key);

  const all = app.db.all<{ key: string; feed_url: string; followers: number }>("SELECT key, feed_url, followers FROM discovery_sources");
  const followers = new Map(all.map((r) => [r.key, r.followers]));
  // A private source keeps only a keyed hash of its address: a suggestion with the same hash is already followed.
  const privateKeys = new Set(app.db.all<{ feed_key: string }>("SELECT feed_key FROM sources WHERE workspace_id = ? AND feed_key IS NOT NULL", p.workspaceId).map((r) => r.feed_key));
  if (privateKeys.size) for (const r of all) { const k = privateFeedKey(app, p.workspaceId, r.feed_url); if (k && privateKeys.has(k)) skip.add(r.key); }
  const scores = new Map<string, { score: number; parts: { id: string; w: number }[] }>();
  const keys = [...mine.keys()].filter((k) => followers.has(k));
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    for (const r of app.db.all<{ a: string; b: string; together: number }>(`SELECT a, b, together FROM discovery_pairs WHERE a IN (${part.map(() => "?").join(", ")})`, ...part)) {
      if (skip.has(r.b)) continue;
      const w = r.together / Math.sqrt(followers.get(r.a)! * (followers.get(r.b) ?? Infinity));
      if (!(w > 0)) continue;
      let s = scores.get(r.b);
      if (!s) scores.set(r.b, (s = { score: 0, parts: [] }));
      s.score += w;
      s.parts.push({ id: mine.get(r.a)!, w });
    }
  }
  const matched: Candidate[] = [...scores].map(([key, s]) => ({
    key, score: s.score, because: s.parts.sort((x, y) => y.w - x.w).slice(0, 2).map((x) => x.id),
  }));
  const popular = [...followers].map(([key, n]) => ({ key, followers: n }));
  const picked = arrange(matched, popular, skip, `${p.workspaceId}:${now.toISOString().slice(0, 10)}`);

  const info = new Map<string, { feed_url: string; title: string; host: string | null; kind: Kind }>();
  const pickedKeys = picked.map((x) => x.key);
  for (let i = 0; i < pickedKeys.length; i += CHUNK) {
    const part = pickedKeys.slice(i, i + CHUNK);
    for (const r of app.db.all<{ key: string; feed_url: string; title: string; host: string | null; kind: Kind }>(
      `SELECT key, feed_url, title, host, kind FROM discovery_sources WHERE key IN (${part.map(() => "?").join(", ")})`, ...part)) info.set(r.key, r);
  }
  const suggestions: DiscoverSuggestion[] = picked.flatMap((x) => {
    const s = info.get(x.key);
    if (!s) return [];
    const reason: DiscoverSuggestion["reason"] = x.reason === "because" ? { kind: "because", sourceIds: x.because } : { kind: x.reason };
    return [{ key: x.key, title: s.title, host: s.host, feedUrl: s.feed_url, kind: s.kind, reason }];
  });
  return { sharing, ready, suggestions };
}

/** "Not interested": the suggestion stops coming back for this account. */
export function dismissSuggestion(app: App, p: Principal, key: string): { ok: true } {
  if (app.config.mode !== "hosted") throw notFound("Discover");
  // Only a source that can be suggested is remembered, so the list can't grow with made-up keys.
  app.db.run("INSERT INTO discovery_dismissed (workspace_id, key, created_at) SELECT ?, key, ? FROM discovery_sources WHERE key = ? ON CONFLICT DO NOTHING", p.workspaceId, nowIso(), key);
  return { ok: true };
}
