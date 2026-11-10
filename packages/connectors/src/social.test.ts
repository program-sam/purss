import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectorById } from "./catalog.ts";
import { discover } from "./discover.ts";
import type { DiscoveryDraft, FetchFn } from "./discover.ts";
import { normalizeInput } from "./input.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts";
import { blueskyTitle, classifySocialInput } from "./social.ts";
import { allowLoopback, fakeFailure, fakeResponse, send, startServer } from "./testing.ts";

/*
 * Fixtures recorded on 2026-11-05 from mastodon.social (@Mastodon: WebFinger, the profile page's
 * head, the first three feed items) and bsky.app (@bsky.app, first three items), trimmed. No test
 * here reaches the network.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/social/${name}`, import.meta.url), "utf8");
const WEBFINGER = fixture("mastodon-webfinger.json");
const PROFILE = fixture("mastodon-profile.html");
const MASTODON_RSS = fixture("mastodon.rss");
const BLUESKY_RSS = fixture("bluesky.rss");

const NOW = () => new Date("2026-11-05T12:00:00Z");
const WF_URL = "https://mastodon.social/.well-known/webfinger?resource=acct%3AMastodon%40mastodon.social";
const BSKY_DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const BSKY_FEED = `https://bsky.app/profile/${BSKY_DID}/rss`;

type Routes = Record<string, SafeFetchResult | ((url: string) => SafeFetchResult)>;
function stub(routes: Routes): { fetch: FetchFn; calls: { url: string; opts?: SafeFetchOptions }[] } {
  const calls: { url: string; opts?: SafeFetchOptions }[] = [];
  const fetch: FetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const route = routes[url];
    if (!route) return fakeResponse(url, "<html><body>Not found</body></html>", "text/html", 404);
    return typeof route === "function" ? route(url) : route;
  };
  return { fetch, calls };
}
const mastodonRoutes = (): Routes => ({
  [WF_URL]: fakeResponse(WF_URL, WEBFINGER, "application/jrd+json; charset=utf-8"),
  "https://mastodon.social/@Mastodon": fakeResponse("https://mastodon.social/@Mastodon", PROFILE, "text/html; charset=utf-8"),
  "https://mastodon.social/@Mastodon.rss": fakeResponse("https://mastodon.social/@Mastodon.rss", MASTODON_RSS, "application/rss+xml; charset=utf-8"),
});
/** bsky.app answers a handle with a redirect to the DID form; a stub reports where the fetch ended. */
const bskyRedirect = (requested: string): SafeFetchResult => {
  const r = fakeResponse(BSKY_FEED, BLUESKY_RSS, "application/xml; charset=UTF-8", 200, { redirects: [BSKY_FEED] });
  if (r.ok) r.response.requestedUrl = requested;
  return r;
};
function ok(d: DiscoveryDraft) {
  assert.ok(d.ok, JSON.stringify(d));
  return d;
}
function failed(d: DiscoveryDraft) {
  assert.ok(!d.ok, JSON.stringify(d));
  return d;
}

test("social inputs are recognised; websites, e-mail-like junk and bare names are not", () => {
  const cases: [string, ReturnType<typeof classifySocialInput>][] = [
    ["@Mastodon@mastodon.social", { kind: "fediverse", user: "Mastodon", domain: "mastodon.social", emailLike: false }],
    ["  Mastodon@Mastodon.Social. ", { kind: "fediverse", user: "Mastodon", domain: "mastodon.social", emailLike: true }],
    ["acct:alice@example.org", { kind: "fediverse", user: "alice", domain: "example.org", emailLike: false }],
    ["https://mastodon.social/@alice@fosstodon.org", { kind: "fediverse", user: "alice", domain: "fosstodon.org", emailLike: false }],
    ["@bsky.app", { kind: "bluesky", actor: "bsky.app", related: false }],
    ["@Name.bsky.social", { kind: "bluesky", actor: "name.bsky.social", related: false }],
    ["name.bsky.social", { kind: "bluesky", actor: "name.bsky.social", related: false }],
    ["https://name.bsky.social/", { kind: "bluesky", actor: "name.bsky.social", related: false }],
    ["https://bsky.app/profile/bsky.app", { kind: "bluesky", actor: "bsky.app", related: false }],
    ["bsky.app/profile/jay.bsky.team/", { kind: "bluesky", actor: "jay.bsky.team", related: false }],
    [`https://bsky.app/profile/${BSKY_DID}/rss`, { kind: "bluesky", actor: BSKY_DID, related: false }],
    ["https://bsky.app/profile/bsky.app/post/3mzhhvhjfwk22", { kind: "bluesky", actor: "bsky.app", related: true }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(classifySocialInput(input), expected, input);
  for (const input of ["https://bsky.app/profile/bsky.app/feed/whats-hot", "https://bsky.app/profile/bsky.app/lists/3k"]) {
    assert.equal(classifySocialInput(input)?.kind, "unsupported", input);
  }
  for (const input of [
    "@somebody", "example.com", "https://example.com/blog", "https://mastodon.social/@Mastodon", "https://www.youtube.com/@name",
    "bsky.social", "https://bsky.app/", "https://bsky.app/search?q=x", "@a@b", "@x@192.168.0.1", "user:pw@example.com",
    "https://bsky.app/profile/not a handle", "two words@example.com", "@name@example.com:8080", "https://name.bsky.social:444/",
  ]) {
    assert.equal(classifySocialInput(input), null, input);
  }
});

test("a bare @name still explains what to paste, now naming social handles too", () => {
  const n = normalizeInput("@somebody");
  assert.ok(!n.ok);
  assert.match(n.message, /@name@mastodon\.social/);
});

test("a Mastodon handle: WebFinger, then the profile page, then the feed it advertises, labelled with honest limits", async () => {
  const { fetch, calls } = stub(mastodonRoutes());
  const d = ok(await discover("@Mastodon@mastodon.social", { fetch, now: NOW }));
  assert.deepEqual(calls.map((c) => c.url), [WF_URL, "https://mastodon.social/@Mastodon", "https://mastodon.social/@Mastodon.rss"]);
  assert.match(String(calls[0]!.opts?.accept), /^application\/jrd\+json/);
  assert.ok((calls[0]!.opts?.maxBytes ?? Infinity) <= 64 * 1024, "WebFinger answers are small");
  assert.equal(d.candidates.length, 1);
  const c = d.candidates[0]!;
  assert.equal(c.title, "Mastodon");
  assert.equal(c.kind, "feed");
  assert.equal(c.origin, "Mastodon account");
  assert.equal(c.via, "Posts feed");
  assert.equal(c.feedUrl, "https://mastodon.social/@Mastodon.rss");
  assert.equal(c.siteUrl, "https://mastodon.social/@Mastodon");
  assert.equal(c.samples.length, 3);
  assert.match(c.samples[0]!.title, /^We didn’t want to require you/, "untitled posts preview their text");
  assert.equal(c.samples[0]!.publishedAt, "2026-10-19T09:59:05.000Z");
  assert.match(c.note ?? "", /Public posts only/);
  assert.match(c.note ?? "", /Boosts and replies aren't included/);
  assert.match(c.note ?? "", /deletes stays in your PURSS/);
  assert.equal(c.privateWarning, null);
});

test("a Mastodon profile address pasted directly is recognised from the page, without probing the server's paths", async () => {
  const { fetch, calls } = stub(mastodonRoutes());
  const d = ok(await discover("https://mastodon.social/@Mastodon", { fetch, now: NOW }));
  assert.deepEqual(calls.map((c) => c.url), ["https://mastodon.social/@Mastodon", "https://mastodon.social/@Mastodon.rss"]);
  assert.equal(d.candidates[0]!.origin, "Mastodon account");
  assert.match(d.candidates[0]!.note ?? "", /Boosts/);
});

test("another fediverse server is labelled generically, with only the limits every such feed shares", async () => {
  const rss = MASTODON_RSS.replace(/<generator>[^<]*<\/generator>/, "<generator>GoToSocial</generator>");
  const routes = mastodonRoutes();
  routes["https://mastodon.social/@Mastodon.rss"] = fakeResponse("https://mastodon.social/@Mastodon.rss", rss, "application/rss+xml");
  const { fetch } = stub(routes);
  const c = ok(await discover("@Mastodon@mastodon.social", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.origin, "Fediverse account");
  assert.doesNotMatch(c.note ?? "", /Boosts/);
  assert.match(c.note ?? "", /Public posts only/);
});

test("fediverse failures say what happened, and never fall back to scraping", async () => {
  // Unknown account.
  let s = stub({});
  let f = failed(await discover("@nobody@mastodon.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.match(f.message, /couldn't find @nobody@mastodon\.social/);
  assert.equal(s.calls.length, 1);

  // A server that isn't one: WebFinger answers with a web page.
  s = stub({ [WF_URL]: fakeResponse(WF_URL, "<html>hello</html>", "text/html") });
  f = failed(await discover("@Mastodon@mastodon.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "invalid");

  // An account without a public profile link.
  s = stub({ [WF_URL]: fakeResponse(WF_URL, JSON.stringify({ subject: "acct:Mastodon@mastodon.social", links: [{ rel: "self", type: "application/activity+json", href: "https://mastodon.social/users/Mastodon" }] }), "application/jrd+json") });
  f = failed(await discover("@Mastodon@mastodon.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.equal(s.calls.length, 1);

  // A profile that advertises no feed (GoToSocial leaves it off unless the owner opts in).
  const routes = mastodonRoutes();
  routes["https://mastodon.social/@Mastodon"] = fakeResponse("https://mastodon.social/@Mastodon", PROFILE.replace(/<link[^>]*rss\+xml[^>]*>/, ""), "text/html");
  s = stub(routes);
  f = failed(await discover("@Mastodon@mastodon.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.match(f.message, /doesn't offer a public feed/);
  assert.deepEqual(s.calls.map((c) => c.url), [WF_URL, "https://mastodon.social/@Mastodon"], "no guessing at other addresses");

  // A profile link that isn't a web address is ignored.
  s = stub({ [WF_URL]: fakeResponse(WF_URL, JSON.stringify({ links: [{ rel: "http://webfinger.net/rel/profile-page", href: "javascript:alert(1)" }] }), "application/jrd+json") });
  f = failed(await discover("@Mastodon@mastodon.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.equal(s.calls.length, 1);

  // The server can't be reached.
  s = stub({ [WF_URL]: fakeFailure("unreachable", "connection refused") });
  f = failed(await discover("@Mastodon@mastodon.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "unreachable");
});

test("a post on a fediverse server explains to paste the profile instead", async () => {
  const post = "https://mastodon.social/@Mastodon/117466985005297414";
  const html = `<html><head><link href="https://mastodon.social/users/Mastodon/statuses/117466985005297414" rel="alternate" type="application/activity+json"></head><body></body></html>`;
  const { fetch, calls } = stub({ [post]: fakeResponse(post, html, "text/html") });
  const f = failed(await discover(post, { fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.match(f.message, /paste the account's profile address/);
  assert.equal(calls.length, 1, "no probing of the server's paths");
});

test("an ordinary site that also speaks ActivityPub is still searched for its feed like any other site", async () => {
  // e.g. WordPress with the ActivityPub plugin: its pages advertise an activity+json alternate, often without a feed link.
  const rss = fixture("mastodon.rss").replace(/<title>[^<]*<\/title>/, "<title>Tidepool Notes</title>");
  for (const page of ["https://tidepool.example/2026/11/estuaries/", "https://tidepool.example/", "https://tidepool.example/author/alice/"]) {
    const html = `<html><head><title>Estuaries</title><link rel="alternate" type="application/activity+json" href="${page}?activitypub"></head><body><p>Post</p></body></html>`;
    const { fetch } = stub({
      [page]: fakeResponse(page, html, "text/html"),
      "https://tidepool.example/feed": fakeResponse("https://tidepool.example/feed", rss, "application/rss+xml"),
    });
    const d = ok(await discover(page, { fetch, now: NOW }));
    assert.equal(d.candidates[0]!.feedUrl, "https://tidepool.example/feed", page);
  }
});

test("a handle on an internal name is refused before anything is fetched", async () => {
  const { fetch, calls } = stub({});
  const f = failed(await discover("@admin@intranet.local", { fetch, now: NOW }));
  assert.equal(f.reason, "blocked");
  assert.equal(calls.length, 0);
});

test("the fediverse path runs through safeFetch: a handle's domain redirecting to its server, and an internal redirect refused", async () => {
  // social.example is the handle's domain; its WebFinger redirects to the server at server.example.
  const server = await startServer((req, res, srv) => {
    const host = req.headers.host ?? "";
    if (req.url?.startsWith("/.well-known/webfinger") && host.startsWith("social.example")) {
      return send(res, 301, "text/plain", "", { location: `http://server.example:${srv.port}${req.url}` });
    }
    if (req.url?.startsWith("/.well-known/webfinger")) {
      return send(res, 200, "application/jrd+json", JSON.stringify({ links: [{ rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `http://server.example:${srv.port}/@ann` }] }));
    }
    if (req.url === "/@ann") return send(res, 200, "text/html", `<html><head><link rel="alternate" type="application/rss+xml" href="/@ann.rss"><link rel="alternate" type="application/activity+json" href="/users/ann"></head></html>`);
    if (req.url === "/@ann.rss") return send(res, 200, "application/rss+xml", MASTODON_RSS.replace("<title>Mastodon</title>", "<title>Ann</title>"));
    if (req.url === "/@evil") return send(res, 200, "text/html", `<html><head><link rel="alternate" type="application/rss+xml" href="http://127.0.0.2:9/x.rss"><link rel="alternate" type="application/activity+json" href="/users/evil"></head></html>`);
    send(res, 404, "text/plain", "no");
  });
  // The handle names port 443 over https; send it to the local server's plain-http port instead.
  const local: FetchFn = (url, opts) => safeFetch(url.replace(/^https:\/\/(social|server)\.example\//, `http://$1.example:${server.port}/`), {
    ...opts, testAllowAddress: allowLoopback, resolver: async (host) => (host.endsWith(".example") ? ["127.0.0.1"] : []),
  });
  try {
    const d = ok(await discover("@ann@social.example", { fetch: local, now: NOW }));
    assert.equal(d.candidates[0]!.title, "Ann");
    assert.equal(d.candidates[0]!.feedUrl, `http://server.example:${server.port}/@ann.rss`);
    assert.equal(d.candidates[0]!.origin, "Mastodon account");
    const evil = failed(await discover(`http://server.example:${server.port}/@evil`, { fetch: local, now: NOW }));
    assert.equal(evil.reason, "blocked", "an advertised feed on an internal address is refused");
  } finally {
    await server.close();
  }
});

test("a Bluesky handle resolves through bsky.app to the DID feed, which outlives handle changes", async () => {
  for (const input of ["@bsky.app", "https://bsky.app/profile/bsky.app", "bsky.app/profile/bsky.app/rss"]) {
    const { fetch, calls } = stub({ "https://bsky.app/profile/bsky.app/rss": bskyRedirect });
    const d = ok(await discover(input, { fetch, now: NOW }));
    assert.deepEqual(calls.map((c) => c.url), ["https://bsky.app/profile/bsky.app/rss"], input);
    const c = d.candidates[0]!;
    assert.equal(c.feedUrl, BSKY_FEED, input);
    assert.equal(c.title, "Bluesky");
    assert.equal(c.origin, "Bluesky account");
    assert.equal(c.kind, "feed");
    assert.equal(c.via, "Posts feed");
    assert.equal(c.siteUrl, "https://bsky.app/profile/bsky.app");
    assert.equal(c.samples.length, 3);
    assert.match(c.samples[0]!.title, /^We're seeing 200%/);
    assert.equal(c.samples[0]!.publishedAt, "2026-11-04T04:03:00.000Z", "Bluesky's date format without a weekday is read");
    assert.match(c.note ?? "", /Reposts and replies aren't included/);
    assert.match(c.note ?? "", /deletes stays in your PURSS/);
  }
  // A DID needs no redirect; a *.bsky.social host is a handle, not a website.
  let s = stub({ [BSKY_FEED]: fakeResponse(BSKY_FEED, BLUESKY_RSS, "application/xml") });
  assert.equal(ok(await discover(`https://bsky.app/profile/${BSKY_DID}`, { fetch: s.fetch, now: NOW })).candidates[0]!.feedUrl, BSKY_FEED);
  s = stub({ "https://bsky.app/profile/name.bsky.social/rss": bskyRedirect });
  ok(await discover("name.bsky.social", { fetch: s.fetch, now: NOW }));
  assert.deepEqual(s.calls.map((c) => c.url), ["https://bsky.app/profile/name.bsky.social/rss"]);
});

test("a Bluesky post offers its author to confirm; custom feeds and lists say why they can't be followed", async () => {
  const { fetch } = stub({ "https://bsky.app/profile/bsky.app/rss": bskyRedirect });
  const c = ok(await discover("https://bsky.app/profile/bsky.app/post/3mzhhvhjfwk22", { fetch, now: NOW })).candidates[0]!;
  assert.equal(c.via, "Related account — confirm");
  const none = stub({});
  const f = failed(await discover("https://bsky.app/profile/bsky.app/feed/whats-hot", { fetch: none.fetch, now: NOW }));
  assert.equal(f.reason, "unsupported");
  assert.match(f.message, /custom feeds and lists/);
  assert.equal(none.calls.length, 0);
});

test("Bluesky refusals: an account hidden from signed-out people, an unknown handle, a bad one", async () => {
  const url = "https://bsky.app/profile/hidden.bsky.social/rss";
  let s = stub({ [url]: fakeResponse(url, "account does not allow public views", "text/plain", 403) });
  let f = failed(await discover("@hidden.bsky.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.match(f.message, /asks apps not to show its posts/);
  s = stub({});
  f = failed(await discover("@missing.bsky.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "nofeed");
  assert.match(f.message, /couldn't find @missing\.bsky\.social on Bluesky/);
  const bad = "https://bsky.app/profile/bad.bsky.social/rss";
  s = stub({ [bad]: fakeResponse(bad, "not a valid handle", "text/plain", 400) });
  f = failed(await discover("@bad.bsky.social", { fetch: s.fetch, now: NOW }));
  assert.equal(f.reason, "invalid");
});

test("Bluesky feed titles become the account's display name", () => {
  assert.equal(blueskyTitle("@bsky.app - Bluesky", "bsky.app"), "Bluesky");
  assert.equal(blueskyTitle("@ann.example.org", "ann.example.org"), "@ann.example.org");
  assert.equal(blueskyTitle(null, "ann.example.org"), "@ann.example.org");
  assert.equal(blueskyTitle(null, BSKY_DID), "Bluesky account");
});

test("the catalog lists both social connectors with their limits and no credentials", () => {
  for (const id of ["fediverse-account", "bluesky-account"]) {
    const c = connectorById(id);
    assert.ok(c, id);
    assert.equal(c.auth.needs, "none");
    assert.equal(c.capabilities.feedGeneration, false);
    assert.match(c.coverageLimits, /Public posts only/);
    assert.match(c.coverageLimits, /stays in your PURSS/);
  }
  assert.deepEqual(connectorById("bluesky-account")!.permittedDomains, ["bsky.app"]);
});
