/*
 * A podcast feed shaped like the big real ones (The Daily's is 19.6 MB for 3,039 episodes): each episode carries its notes twice over (as
 * `description` and `content:encoded`, about 2.2 KB each, never the same text twice), a summary and a subtitle, a long tracking
 * enclosure address, several `itunes:`, `media:` and author elements: about 6.3 KB. Words are made up (a fixed pseudo-random run), so the
 * fixture is the shape and weight of a real feed without any real feed's text.
 */

const VOWELS = "aeiou";
const CONSONANTS = "bcdfghjklmnpqrstvwxz";

/** A deterministic run of made-up words, `chars` characters long, different for every `seed`. */
function words(seed: number, chars: number): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  const next = (n: number): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x % n;
  };
  const out: string[] = [];
  let length = 0;
  while (length < chars) {
    const len = 2 + next(8);
    let w = "";
    for (let k = 0; k < len; k++) w += k % 2 === 0 ? CONSONANTS[next(CONSONANTS.length)] : VOWELS[next(VOWELS.length)];
    out.push(w);
    length += w.length + 1;
  }
  return out.join(" ");
}

const paragraphs = (seed: number, total: number): string => {
  const parts: string[] = [];
  let used = 0;
  for (let k = 0; used < total; k++) {
    const p = `<p>${words(seed * 31 + k, 280)}.</p>`;
    parts.push(p);
    used += p.length;
  }
  return parts.join("");
};

export const FIXTURE_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<atom:link href="https://show.example/feed" rel="self" type="application/atom+xml"/>
<title>The Big Show</title>
<link>https://show.example/</link>
<description>A show with a very long back catalogue.</description>
<language>en</language>
<image><link>https://show.example/</link><title>The Big Show</title><url>https://cdn.example/art.jpg</url></image>
<itunes:author>Show Author</itunes:author>
<itunes:image href="https://cdn.example/art.jpg"/>
<itunes:category text="News"><itunes:category text="Daily News"/></itunes:category>
`;

export const FIXTURE_TAIL = "</channel>\n</rss>\n";

/** Episode `i`, dated a day after episode `i - 1` from 2020-01-01. */
export function fixtureEpisode(i: number): string {
  const notes = paragraphs(i + 1, 2200);
  const summary = words(i + 7_000_000, 105);
  const date = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toUTCString();
  return `<item>
<guid isPermaLink="false">ep-${i}</guid>
<title>Episode ${i}</title>
<description><![CDATA[${notes}]]></description>
<pubDate>${date}</pubDate>
<author>show@example.com (Show Author)</author>
<link>https://show.example/ep/${i}</link>
<media:thumbnail height="720" url="https://cdn.example/images/${i}/thumb-1280x720.jpg" width="1280"/>
<content:encoded><![CDATA[${paragraphs(i + 1, 2200)}]]></content:encoded>
<enclosure length="21729863" type="audio/mpeg" url="https://track.example/redirect.mp3/p/${words(i + 3, 40).replace(/ /g, "")}/n/${words(i + 5, 60).replace(/ /g, "")}/episodes/${i}/audio/128/default.mp3?aid=rss_feed&amp;awCollectionId=${words(i + 9, 30).replace(/ /g, "")}&amp;awEpisodeId=${words(i + 11, 30).replace(/ /g, "")}&amp;feed=abc123"/>
<itunes:title>Episode ${i}</itunes:title>
<itunes:author>Show Author</itunes:author>
<itunes:image href="https://cdn.example/art.jpg"/>
<itunes:duration>00:22:38</itunes:duration>
<itunes:summary>${summary}</itunes:summary>
<itunes:subtitle>${summary}</itunes:subtitle>
<itunes:explicit>false</itunes:explicit>
<itunes:episodeType>full</itunes:episodeType>
</item>
`;
}

/** The numbers of the episodes in the order the feed lists them. */
export type FixtureOrder = "newest-first" | "shuffled";
export function fixtureListing(count: number, order: FixtureOrder): number[] {
  const ids = Array.from({ length: count }, (_, i) => i);
  if (order === "newest-first") return ids.reverse();
  return ids.sort((a, b) => ((a * 7919) % 10007) - ((b * 7919) % 10007));
}
