import type { FeedItem } from "./feed.ts";

/** Plain-language posting rhythm estimated from the dates in a feed sample. */

const DAY = 86_400_000;

function plural(n: number, noun: { one: string; many: string }): string {
  return `${n} ${n === 1 ? noun.one : noun.many}`;
}

export type Noun = { one: string; many: string };
export const POSTS: Noun = { one: "post", many: "posts" };
export const EPISODES: Noun = { one: "episode", many: "episodes" };
export const VIDEOS: Noun = { one: "video", many: "videos" };

function agoText(days: number): string {
  if (days < 1) return "less than a day ago";
  if (days < 45) {
    const d = Math.round(days);
    return d === 1 ? "1 day ago" : `${d} days ago`;
  }
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round((days / 365) * 10) / 10;
  return years < 1.5 ? "about a year ago" : `about ${Math.round(years)} years ago`;
}

/** Windows (days) tried from the shortest, so a busy feed is read over its recent days and a quiet one over months. */
const WINDOWS = [1, 3, 7, 30, 90, 365];

/**
 * Items per day over the recent past, from the dates in the sample (newest first). The shortest window
 * that holds at least three items and a real spread of them is used: a burst of posts in one hour is not
 * a rhythm, and a few old items in a long tail do not make a busy feed quiet (a feed that lists 25 posts
 * from the last two days and a handful from last month posts many a day, not four a week). When the
 * sample reaches back past the window the count is divided by the window; when it does not, by the time
 * the sample really covers.
 */
function recentRate(times: number[], now: number): number | null {
  const oldest = times[times.length - 1]!;
  const coverage = Math.max((now - oldest) / DAY, 0.5);
  for (const w of WINDOWS) {
    const inside = times.filter((t) => now - t <= w * DAY);
    if (inside.length < 3) continue;
    const spread = (inside[0]! - inside[inside.length - 1]!) / DAY;
    if (spread < 0.4 * Math.min(w, coverage)) continue;
    if (w <= coverage) return inside.length / w;
    return (inside.length - 1) / Math.max(spread, (now - inside[0]!) / DAY, 0.5);
  }
  return null;
}

/**
 * "about 2 posts a week", "about 1 episode a month" or a staleness note. Returns null
 * when the feed gives too few dates to say anything honest.
 */
export function cadenceText(items: FeedItem[], noun: Noun, now: Date): string | null {
  const times = items
    .map((i) => (i.publishedAt ? Date.parse(i.publishedAt) : NaN))
    .filter((t) => Number.isFinite(t) && t <= now.getTime() + DAY)
    .sort((a, b) => b - a)
    .slice(0, 50);
  if (items.length === 0) return `No ${noun.many} yet`;
  if (times.length < 2) return times.length === 1 ? `Latest ${noun.one} ${agoText((now.getTime() - times[0]!) / DAY)}` : null;
  const newest = times[0]!;
  const staleDays = (now.getTime() - newest) / DAY;
  if (staleDays > 180) return `No new ${noun.many} for ${agoText(staleDays).replace(" ago", "")}`;
  if (times.length < 3) return `Latest ${noun.one} ${agoText(staleDays)}`;
  let perDay = recentRate(times, now.getTime());
  if (perDay === null) {
    // No recent rhythm to read. The whole sample says how often it posted over its span, a long silence
    // since the newest item lowering the rate; but a rate far below a month when the newest item is
    // recent only describes an old tail, so say when it last posted instead.
    const recent = times.slice(0, 20);
    const spanDays = Math.max((newest - recent[recent.length - 1]!) / DAY, 0.5);
    perDay = (recent.length - 1) / Math.max(spanDays, staleDays);
    if (perDay * 30.4 < 0.9 && staleDays < 30) return `Latest ${noun.one} ${agoText(staleDays)}`;
  }
  if (perDay >= 1.5) return `about ${plural(Math.round(perDay), noun)} a day`;
  const perWeek = perDay * 7;
  if (perWeek >= 0.9) return `about ${plural(Math.max(1, Math.round(perWeek)), noun)} a week`;
  const perMonth = perDay * 30.4;
  if (perMonth >= 0.9) return `about ${plural(Math.max(1, Math.round(perMonth)), noun)} a month`;
  const perYear = perDay * 365;
  if (perYear >= 1.5) return `about ${plural(Math.max(2, Math.round(perYear)), noun)} a year`;
  return `less than one ${noun.one} a year`;
}
