import { MAX_URL_LENGTH, safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";

/*
 * The pictures of Bluesky posts. Bluesky's own feed of an account (what FreshRSS collects) carries each post's text and nothing of what
 * is attached to it, so a post of a cartoon arrives as a caption. The public API says what a post carries; it is asked about the posts
 * the feed already brought, a batch at a time, through safeFetch like every other lookup, and only for the pictures: a failure,
 * a deleted post or a slow answer changes nothing. This is no second collector: no post is found here, and none is added.
 */

const API = "https://public.api.bsky.app/xrpc";
/** Most posts one `getPosts` answers. */
export const POSTS_PER_LOOKUP = 25;
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_PICTURE_ADDRESS = 2048;
const HANDLE_TTL_MS = 60 * 60 * 1000;
const MAX_HANDLES = 500;

export type PostRef = { actor: string; rkey: string };
export type PostPicture = { url: string; alt: string | null };
/** What the lookup knows of one post: its pictures (none for a post that has none), that it is gone, or that nothing could be learned now. */
export type PostAnswer = { status: "found"; pictures: PostPicture[] } | { status: "gone" } | { status: "unknown" };

const BSKY_POST = /^https:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]{1,253})\/post\/([A-Za-z0-9]{6,30})\/?(?:[?#].*)?$/;

/** `https://bsky.app/profile/<handle or DID>/post/<id>`, as Bluesky's feed links a post; null for any other address. */
export function parseBlueskyPostUrl(url: string | null | undefined): PostRef | null {
  const m = url ? BSKY_POST.exec(url) : null;
  if (!m) return null;
  let actor = m[1]!;
  try { actor = decodeURIComponent(actor); } catch { return null; }
  return /^(?:did:(?:plc|web):[A-Za-z0-9._:%-]{1,200}|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})$/.test(actor) ? { actor: actor.toLowerCase(), rkey: m[2]! } : null;
}

export const postKey = (ref: PostRef): string => `${ref.actor}/${ref.rkey}`;

/** An address Bluesky's own image hosts serve: https, on bsky.app or bsky.network, of reasonable length. */
function pictureAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PICTURE_ADDRESS) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && /(?:^|\.)bsky\.(?:app|network)$/i.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The pictures of a post's embed, in the order the author attached them: its images, a video's still, a link card's picture; a post
 * that quotes another with pictures of its own (`recordWithMedia`) gives those. A quoted post's own pictures are the quoted post's.
 */
export function readPostPictures(post: unknown): PostPicture[] {
  const out: PostPicture[] = [];
  const embed = record(record(post)?.embed);
  const media = record(embed?.media) ?? embed;
  if (!media) return out;
  if (Array.isArray(media.images)) {
    for (const raw of media.images.slice(0, 4)) {
      const image = record(raw);
      const url = pictureAddress(image?.thumb) ?? pictureAddress(image?.fullsize);
      if (url) out.push({ url, alt: typeof image?.alt === "string" && image.alt.trim() ? image.alt.trim().slice(0, 1000) : null });
    }
  }
  const video = pictureAddress(media.thumbnail);
  if (video) out.push({ url: video, alt: typeof media.alt === "string" && media.alt.trim() ? media.alt.trim().slice(0, 1000) : null });
  const card = pictureAddress(record(media.external)?.thumb);
  if (card) out.push({ url: card, alt: null });
  return out;
}

export type LookupOptions = {
  signal?: AbortSignal;
  /** Replacement fetcher (tests); defaults to safeFetch. */
  fetch?: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  /** Handles already resolved, kept by the caller between lookups; one is kept inside this module otherwise. */
  handles?: Map<string, { did: string; at: number }>;
  now?: () => number;
  /** TEST ONLY, forwarded to safeFetch. */
  testAllowAddress?: (ip: string) => boolean;
  /** TEST ONLY, forwarded to safeFetch. */
  resolver?: SafeFetchOptions["resolver"];
  testTlsCa?: SafeFetchOptions["testTlsCa"];
};

const sharedHandles = new Map<string, { did: string; at: number }>();

type Json = { ok: true; status: number; data: unknown } | { ok: false };

async function getJson(url: string, o: LookupOptions): Promise<Json> {
  const fetcher = o.fetch ?? safeFetch;
  const res = await fetcher(url, {
    signal: o.signal, maxBytes: MAX_ANSWER_BYTES, timeoutMs: 12_000, accept: "application/json",
    phaseTimeoutsMs: { firstByteMs: 8000, idleMs: 5000 },
    testAllowAddress: o.testAllowAddress, resolver: o.resolver, testTlsCa: o.testTlsCa,
  }).catch(() => null);
  if (!res?.ok) return { ok: false };
  try {
    return { ok: true, status: res.response.status, data: res.response.status === 200 ? JSON.parse(res.response.body.toString("utf8")) : null };
  } catch {
    return { ok: false };
  }
}

/** The DID of a handle: from what was resolved before, or the public API. "gone" for a handle that names nobody, null when it could not be asked. */
async function resolveActor(actor: string, o: LookupOptions): Promise<string | "gone" | null> {
  if (actor.startsWith("did:")) return actor;
  const cache = o.handles ?? sharedHandles;
  const now = (o.now ?? Date.now)();
  const known = cache.get(actor);
  if (known && now - known.at < HANDLE_TTL_MS) return known.did;
  const r = await getJson(`${API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`, o);
  if (!r.ok) return null;
  if (r.status === 400) return "gone"; // "Unable to resolve handle"
  const did = record(r.data)?.did;
  if (r.status !== 200 || typeof did !== "string" || !/^did:(?:plc|web):[A-Za-z0-9._:%-]{1,200}$/.test(did)) return null;
  if (cache.size >= MAX_HANDLES) cache.delete(cache.keys().next().value!);
  cache.set(actor, { did, at: now });
  return did;
}

/**
 * Asks Bluesky's public API what each of these posts carries. Never throws and never asks for more than `POSTS_PER_LOOKUP` posts at a time;
 * a post it could not learn anything about is `unknown`, so it can be asked again later. Handles are looked up one by one (once an hour each).
 */
export async function lookUpPostPictures(refs: PostRef[], o: LookupOptions = {}): Promise<Map<string, PostAnswer>> {
  const answers = new Map<string, PostAnswer>();
  const unique = [...new Map(refs.map((r) => [postKey(r), r])).values()];
  const resolved = new Map<string, string | "gone" | null>();
  const wanted: { ref: PostRef; uri: string }[] = [];
  for (const ref of unique) {
    if (o.signal?.aborted) break;
    if (!resolved.has(ref.actor)) resolved.set(ref.actor, await resolveActor(ref.actor, o));
    const did = resolved.get(ref.actor);
    if (did === "gone") answers.set(postKey(ref), { status: "gone" });
    else if (did) wanted.push({ ref, uri: `at://${did}/app.bsky.feed.post/${ref.rkey}` });
  }
  // Batches of up to POSTS_PER_LOOKUP posts whose address still fits what safeFetch accepts (25 post addresses don't).
  const getPosts = (batch: typeof wanted) => `${API}/app.bsky.feed.getPosts?${batch.map((c) => `uris=${encodeURIComponent(c.uri)}`).join("&")}`;
  const batches: (typeof wanted)[] = [];
  for (const w of wanted) {
    const last = batches.at(-1);
    if (last && last.length < POSTS_PER_LOOKUP && getPosts([...last, w]).length <= MAX_URL_LENGTH) last.push(w);
    else batches.push([w]);
  }
  for (const chunk of batches) {
    if (o.signal?.aborted) break;
    const r = await getJson(getPosts(chunk), o);
    const posts = r.ok && r.status === 200 ? record(r.data)?.posts : null;
    if (!Array.isArray(posts)) continue;
    const byUri = new Map<string, unknown>();
    for (const post of posts) {
      const uri = record(post)?.uri;
      if (typeof uri === "string") byUri.set(uri, post);
    }
    for (const { ref, uri } of chunk) {
      const post = byUri.get(uri);
      answers.set(postKey(ref), post ? { status: "found", pictures: readPostPictures(post) } : { status: "gone" });
    }
  }
  for (const ref of unique) if (!answers.has(postKey(ref))) answers.set(postKey(ref), { status: "unknown" });
  return answers;
}
