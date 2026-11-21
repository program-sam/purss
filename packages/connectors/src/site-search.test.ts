import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "@purss/copy/server";
import { SITE_DIRECTORY, searchSites } from "./site-search.ts";
import { allowLoopback, fakeFailure, fakeResponse, send, startServer } from "./testing.ts";
import type { FetchFn } from "./discover.ts";

const copy = server.sources.connectors.siteSearch;
const site = (value: string, rank = "normal") => ({ rank, mainsnak: { datavalue: { value } } });
/** Wikidata answering a name search with these matches, and their claims. */
const wikidata = (matches: Record<string, unknown>[], claims: Record<string, Record<string, unknown>>): FetchFn => async (url) => {
  const u = new URL(url);
  if (u.searchParams.get("action") === "wbsearchentities") return fakeResponse(url, JSON.stringify({ search: matches }), "application/json; charset=utf-8");
  return fakeResponse(url, JSON.stringify({ entities: Object.fromEntries(Object.entries(claims).map(([id, c]) => [id, { claims: c }])) }), "application/json; charset=utf-8");
};

test("hits are the matches' official websites, in Wikidata's order, with its description; things without a website are left out", async () => {
  const out = await searchSites("the verge", { fetch: wikidata(
    [{ id: "Q2155442", label: "The Verge", description: "American technology news website" }, { id: "Q9", label: "Verge (band)" }, { id: "Q95626082", label: "The Vergecast", description: "podcast" }, { id: "nope", label: "Bad id" }],
    { Q2155442: { P856: [site("https://old.example/", "deprecated"), site("https://www.theverge.com")] }, Q9: {}, Q95626082: { P856: [site("https://www.theverge.com/the-vergecast")] } },
  ) });
  assert.ok(out.ok);
  assert.deepEqual(out.hits, [
    { name: "The Verge", description: "American technology news website", siteUrl: "https://www.theverge.com/" },
    { name: "The Vergecast", description: "podcast", siteUrl: "https://www.theverge.com/the-vergecast" },
  ]);
});

test("a preferred website comes before others; the same site spelled another way, and non-web or credentialed addresses, are left out", async () => {
  const out = await searchSites("nos", { fetch: wikidata(
    [{ id: "Q1", label: "NOS" }, { id: "Q2", label: "NOS again" }, { id: "Q3", label: "Odd" }, { id: "Q4", label: "Secret" }],
    { Q1: { P856: [site("https://nos.nl/old"), site("https://nos.nl/", "preferred")] }, Q2: { P856: [site("http://www.nos.nl")] }, Q3: { P856: [site("ftp://x.example/")] }, Q4: { P856: [site("https://u:p@x.example/")] } },
  ) });
  assert.ok(out.ok);
  assert.deepEqual(out.hits.map((h) => h.siteUrl), ["https://nos.nl/"]);
});

test("only the typed words are sent, to Wikidata's API; an empty query and no matches ask nothing more", async () => {
  const seen: string[] = [];
  await searchSites("  Hacker   News  ", { fetch: async (url, o) => { seen.push(url); assert.equal(o?.accept, "application/json"); return fakeResponse(url, JSON.stringify({ search: [] }), "application/json"); } });
  assert.equal(seen.length, 1, "no matches: no second request");
  const u = new URL(seen[0]!);
  assert.equal(u.origin + u.pathname, "https://www.wikidata.org/w/api.php");
  assert.equal(u.searchParams.get("search"), "Hacker News");
  assert.equal(u.searchParams.get("action"), "wbsearchentities");
  assert.deepEqual(await searchSites("   ", { fetch: async () => { throw new Error("no request expected"); } }), { ok: true, hits: [] });
});

test("a slow, unreachable, busy or odd answer is a failure that says so, never an empty result", async () => {
  assert.deepEqual(await searchSites("x site", { fetch: async () => fakeFailure("timeout") }), { ok: false, reason: "timeout", message: copy.slow(SITE_DIRECTORY) });
  assert.deepEqual(await searchSites("x site", { fetch: async () => fakeFailure("unreachable") }), { ok: false, reason: "unreachable", message: copy.unreachable(SITE_DIRECTORY) });
  assert.deepEqual(await searchSites("x site", { fetch: async (url) => fakeResponse(url, "busy", "text/html", 503) }), { ok: false, reason: "unreachable", message: copy.busy(SITE_DIRECTORY) });
  // Limiting requests: how long it asked us to wait, at least a minute and at most an hour.
  const limited = (retryAfter?: string): FetchFn => async (url) => fakeResponse(url, "too many", "text/plain", 429, retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } });
  assert.deepEqual(await searchSites("x site", { fetch: limited("24") }), { ok: false, reason: "unreachable", message: copy.busy(SITE_DIRECTORY), retryAfterMs: 60_000 });
  assert.equal(((await searchSites("x site", { fetch: limited("300") })) as { retryAfterMs?: number }).retryAfterMs, 300_000);
  assert.equal(((await searchSites("x site", { fetch: limited("999999") })) as { retryAfterMs?: number }).retryAfterMs, 3_600_000);
  assert.equal(((await searchSites("x site", { fetch: limited() })) as { retryAfterMs?: number }).retryAfterMs, 60_000);
  assert.deepEqual(await searchSites("x site", { fetch: async (url) => fakeResponse(url, "nope", "text/html", 403) }), { ok: false, reason: "unreachable", message: copy.unexpected(SITE_DIRECTORY, 403) });
  assert.deepEqual(await searchSites("x site", { fetch: async (url) => fakeResponse(url, "<html>", "text/html") }), { ok: false, reason: "unreachable", message: copy.unreadable(SITE_DIRECTORY) });
  // The second request failing is a failure too.
  const half: FetchFn = async (url) => new URL(url).searchParams.get("action") === "wbsearchentities" ? fakeResponse(url, JSON.stringify({ search: [{ id: "Q1", label: "X" }] }), "application/json") : fakeFailure("timeout");
  assert.equal((await searchSites("x site", { fetch: half })).ok, false);
});

test("the search goes through safeFetch's address rules", async () => {
  const server = await startServer((_req, res) => send(res, 200, "application/json", JSON.stringify({ search: [] })));
  try {
    const ok = await searchSites("site", { endpoint: `${server.origin}/w/api.php`, testAllowAddress: allowLoopback });
    assert.deepEqual(ok, { ok: true, hits: [] });
    const refused = await searchSites("site", { endpoint: `${server.origin}/w/api.php` });
    assert.equal(refused.ok, false, "a private address is refused");
  } finally {
    await server.close();
  }
});
