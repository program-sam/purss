import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "@purss/translations/server";
import { cadenceText, POSTS } from "./cadence.ts";
import type { FeedItem } from "./feed.ts";

const c = server.sources.connectors.cadence;
const mk = (...dates: (string | null)[]): FeedItem[] =>
  dates.map((d) => ({ guid: null, url: null, title: "t", author: null, publishedAt: d, summaryHtml: null, contentHtml: null, imageUrl: null, enclosures: [], durationSeconds: null, videoId: null }));
const hours = (now: Date, ...ago: number[]) => mk(...ago.map((h) => new Date(now.getTime() - h * 3_600_000).toISOString()));
const days = (now: Date, ...ago: number[]) => hours(now, ...ago.map((d) => d * 24));

test("a busy list with a few old stragglers is read over its recent days, not over the whole sample", () => {
  const now = new Date("2026-11-05T14:30:00Z");
  // BBC Manchester: 15 stories in the last day and a half, and five more from 11 days to 7 weeks ago.
  const recent = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 26];
  const text = cadenceText(hours(now, ...recent, 24 * 11, 24 * 14, 24 * 20, 24 * 35, 24 * 49), POSTS, now)!;
  assert.equal(text, c.aboutADay(`14 ${POSTS.many}`));
});

test("a rhythm of a few posts a week is not called 'less than one a year' because of old items in the tail", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  // SPAB: two posts this week and eighteen from 2018-2023.
  const old = Array.from({ length: 18 }, (_, i) => 1800 + i * 40);
  const text = cadenceText(days(now, 2, 6, ...old), POSTS, now)!;
  assert.notEqual(text, c.lessThanOneAYear(POSTS.one));
  assert.notEqual(text, c.aboutAYear(`2 ${POSTS.many}`));
  assert.equal(text, c.latest(POSTS.one, c.ago(c.days(2))));
});

test("posts that arrive in one burst are not a daily rhythm", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  // Three newsletters at once every week for ten weeks.
  const weekly = Array.from({ length: 10 }, (_, w) => [w * 168 + 3, w * 168 + 3.01, w * 168 + 3.02]).flat();
  const text = cadenceText(hours(now, ...weekly), POSTS, now)!;
  assert.ok([2, 3, 4].some((n) => text === c.aboutAWeek(`${n} ${POSTS.many}`)), text);
});

test("a short feed is read over the time it covers", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  // Ten posts in the last ten hours: nine intervals over the nine hours they cover (a span under half a day counts as half a day).
  assert.equal(cadenceText(hours(now, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), POSTS, now), c.aboutADay(`18 ${POSTS.many}`));
  assert.equal(cadenceText(days(now, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10), POSTS, now), c.aboutAWeek(`7 ${POSTS.many}`));
  assert.equal(cadenceText(days(now, 3, 10, 17, 24, 31, 38), POSTS, now), c.aboutAWeek(`1 ${POSTS.one}`));
  assert.equal(cadenceText(mk(null, null, null), POSTS, now), null);
});
