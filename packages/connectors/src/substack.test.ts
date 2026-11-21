import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "@purss/copy/server";
import type { DraftCandidate } from "./discover.ts";
import type { ParsedFeed } from "./feed.ts";
import { planKnownFeeds, resolveKnown, SUBSTACK_NO_PROFILE, SUBSTACK_NO_PUBLICATION } from "./known-feeds.ts";
import type { KnownDeps, KnownProbe } from "./known-feeds.ts";
import { readSubstackProfile, SUBSTACK_PROFILE_BYTES } from "./substack.ts";

const copy = server.sources.connectors;
const plan = (u: string) => planKnownFeeds(new URL(u));
const feedUrls = (u: string): string[] | null => {
  const p = plan(u);
  return p && "feeds" in p ? p.feeds.map((f) => f.feedUrl) : null;
};

test("a publication's address, a post or a share link is the publication's feed; a section page offers its own feed first", () => {
  assert.deepEqual(feedUrls("https://astralcodexten.substack.com/"), ["https://astralcodexten.substack.com/feed"]);
  assert.deepEqual(feedUrls("https://astralcodexten.substack.com/p/some-post?r=abc&utm_medium=web"), ["https://astralcodexten.substack.com/feed"]);
  assert.deepEqual(feedUrls("https://open.substack.com/pub/ellesshelflife/p/librarymaxxing?r=x"), ["https://ellesshelflife.substack.com/feed"]);
  assert.deepEqual(feedUrls("https://open.substack.com/pub/ellesshelflife"), ["https://ellesshelflife.substack.com/feed"]);
  assert.deepEqual(feedUrls("https://lenny.substack.com/s/community-wisdom"), ["https://lenny.substack.com/feed?section=community-wisdom", "https://lenny.substack.com/feed"]);
  assert.deepEqual(feedUrls("https://open.substack.com/pub/lenny/s/community-wisdom"), ["https://lenny.substack.com/feed?section=community-wisdom", "https://lenny.substack.com/feed"]);
  const section = plan("https://lenny.substack.com/s/community-wisdom");
  assert.ok(section && "feeds" in section && section.feeds[0]!.section && section.feeds[0]!.via === copy.labels.sectionFeed);
});

test("a profile is looked up; a post under a profile, a podcast page and Substack's own pages are read as pages", () => {
  assert.deepEqual(plan("https://substack.com/@ellereadslibrarybooks"), { service: "Substack", profile: "ellereadslibrarybooks" });
  assert.deepEqual(plan("https://substack.com/@someone/note/c-123456"), { service: "Substack", profile: "someone" });
  assert.deepEqual(plan("https://www.substack.com/@some_one/posts"), { service: "Substack", profile: "some_one" });
  assert.deepEqual(plan("https://substack.com/profile/494484809-elle-reads-library-books"), { service: "Substack", profile: "494484809-elle-reads-library-books" });
  for (const u of [
    // Redirects to the post on its own publication, which names its feed.
    "https://substack.com/@ellereadslibrarybooks/p-212421030", "https://substack.com/home/post/p-212421030", "https://substack.com/inbox/post/212421030",
    // Only the page names the podcast feed's number.
    "https://lenny.substack.com/podcast", "https://lenny.substack.com/s/how-i-ai/podcast", "https://open.substack.com/pub/lenny/podcast",
    "https://substack.com/", "https://substack.com/profile/494484809", "https://substack.com/@", "https://substack.com/discover", "https://open.substack.com/", "https://open.substack.com/pub/api",
    "https://support.substack.com/hc/en-us", "https://on.substack.com/p/x",
  ]) assert.equal(plan(u), null, u);
});

const profile = (over: Record<string, unknown> = {}) => ({
  id: 1, handle: "writer", name: "W",
  primaryPublication: { id: 10, subdomain: "lenny", custom_domain: "www.lennysnewsletter.com", name: "Lenny's Newsletter" },
  publicationUsers: [
    { role: "contributor", is_primary: false, public: true, publication: { subdomain: "bigoutlet", custom_domain: null } },
    { role: "admin", is_primary: true, public: true, publication: { subdomain: "lenny", custom_domain: "www.lennysnewsletter.com" } },
    { role: "admin", is_primary: false, public: false, publication: { subdomain: "hidden", custom_domain: null } },
    { role: "admin", is_primary: false, public: true, publication: { subdomain: "second", custom_domain: null } },
  ],
  subscriptions: [{ publication: { subdomain: "someoneelse" } }],
  ...over,
});

test("a profile record gives the publications the person runs, primary first, at their own address; what they read is not theirs", () => {
  assert.deepEqual(readSubstackProfile(profile())!.map((p) => p.base), ["https://www.lennysnewsletter.com", "https://second.substack.com", "https://bigoutlet.substack.com"]);
  assert.deepEqual(readSubstackProfile(profile({ publicationUsers: [] }))!.map((p) => p.base), ["https://www.lennysnewsletter.com"], "the primary publication alone");
  assert.deepEqual(readSubstackProfile(profile({ publicationUsers: [], primaryPublication: null })), []);
  // Nothing a record says becomes anything but an https address on a host name.
  const odd = readSubstackProfile(profile({ primaryPublication: null, publicationUsers: [{ role: "admin", publication: { subdomain: "../x", custom_domain: "evil.example/feed?" } }, { role: "admin", publication: { subdomain: "api", custom_domain: "127.0.0.1" } }] }));
  assert.deepEqual(odd, []);
  assert.equal(readSubstackProfile({ error: "profile not found" }), null);
  assert.equal(readSubstackProfile(null), null);
});

const feed = { title: "T", items: [] } as unknown as ParsedFeed;
const draft = (feedUrl: string, extra: { title?: string; via?: string; note?: string }): DraftCandidate => ({
  title: extra.title ?? "T", kind: "feed", origin: server.words.rssFeed, via: extra.via ?? copy.labels.postsFeed, feedUrl, siteUrl: null, cadence: null, samples: [], summariesOnly: false, alreadyFollowingSourceId: null, privateWarning: null,
  ...(extra.note ? { note: extra.note } : {}),
});
const deps = (probes: Record<string, KnownProbe>, json: KnownDeps["json"]): KnownDeps => ({
  probe: async (u) => probes[u] ?? { failed: null, inconclusive: false },
  json,
  candidate: (u, _p, extra) => draft(u, extra),
});
const answers = (...urls: string[]) => Object.fromEntries(urls.map((u) => [u, { feedUrl: u, parsed: feed }]));

test("a profile's publications are offered, its own first and the others saying how the person is linked to them", async () => {
  const asked: { url: string; maxBytes?: number }[] = [];
  const json: KnownDeps["json"] = async (url, o) => {
    asked.push({ url, maxBytes: o?.maxBytes });
    return { ok: true, data: profile() };
  };
  const p = plan("https://substack.com/@writer")!;
  const got = await resolveKnown(p, deps(answers("https://www.lennysnewsletter.com/feed", "https://second.substack.com/feed", "https://bigoutlet.substack.com/feed"), json), "https://substack.com/@writer");
  assert.deepEqual(asked, [{ url: "https://substack.com/api/v1/user/writer/public_profile", maxBytes: SUBSTACK_PROFILE_BYTES }]);
  assert.ok(got && "candidates" in got);
  assert.deepEqual(got.candidates.map((c) => [c.feedUrl, c.via, c.note ?? null, c.matchesPage]), [
    ["https://www.lennysnewsletter.com/feed", copy.labels.postsFeed, null, true],
    ["https://second.substack.com/feed", copy.labels.postsFeed, copy.substack.alsoRuns, false],
    ["https://bigoutlet.substack.com/feed", copy.labels.postsFeed, copy.substack.alsoWrites, false],
  ]);
});

test("an unknown profile, one without a publication, and a busy Substack each say so", async () => {
  const p = plan("https://substack.com/@writer")!;
  const page = "https://substack.com/@writer";
  assert.deepEqual(await resolveKnown(p, deps({}, async () => ({ ok: false, reason: "unreachable", message: "404", status: 404 })), page), { failure: { reason: "nofeed", message: SUBSTACK_NO_PROFILE } });
  assert.deepEqual(await resolveKnown(p, deps({}, async () => ({ ok: true, data: profile({ publicationUsers: [], primaryPublication: null }) })), page), { failure: { reason: "nofeed", message: SUBSTACK_NO_PUBLICATION } });
  assert.deepEqual(await resolveKnown(p, deps({}, async () => ({ ok: false, reason: "unreachable", message: "slow down", status: 429 })), page), { failure: { reason: "unreachable", message: "slow down" } });
  assert.deepEqual(await resolveKnown(p, deps({}, async () => ({ ok: true, data: { error: "x" } })), page), { failure: { reason: "unsupported", message: copy.discover.serviceUnreadable } });
});
