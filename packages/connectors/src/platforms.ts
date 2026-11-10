/*
 * Services that publish no feeds at all. Recognised by address alone, before anything is
 * fetched: asking such a service for "a feed" only produces slow, confusing failures, and
 * the honest answer is the same every time. The person is pointed at what usually exists
 * next to it (a channel, blog or newsletter) and may still keep the link itself.
 */

type Platform = {
  name: string;
  /** Host names; a subdomain of one of them counts too. */
  hosts: string[];
  /** Subdomains that are not the platform's own pages (its blog, say), so the normal check applies. */
  except?: string[];
};

const PLATFORMS: readonly Platform[] = [
  { name: "Instagram", hosts: ["instagram.com", "instagr.am", "ig.me"] },
  { name: "TikTok", hosts: ["tiktok.com"] },
  { name: "Facebook", hosts: ["facebook.com", "fb.com", "fb.me", "fb.watch", "messenger.com", "m.me"], except: ["engineering.fb.com", "developers.facebook.com"] },
  { name: "X (Twitter)", hosts: ["x.com", "twitter.com", "t.co"], except: ["developer.x.com", "developer.twitter.com", "blog.x.com", "blog.twitter.com"] },
  { name: "Threads", hosts: ["threads.net", "threads.com"] },
  { name: "WhatsApp", hosts: ["whatsapp.com", "wa.me"], except: ["blog.whatsapp.com"] },
  { name: "Discord", hosts: ["discord.com", "discord.gg", "discordapp.com"], except: ["support.discord.com", "blog.discord.com"] },
  { name: "Signal", hosts: ["signal.me", "signal.group"] },
  { name: "Telegram", hosts: ["t.me", "telegram.me", "telegram.dog", "telegram.org"] },
  { name: "Snapchat", hosts: ["snapchat.com"] },
  { name: "Twitch", hosts: ["twitch.tv"], except: ["blog.twitch.tv"] },
  { name: "Bandcamp", hosts: ["bandcamp.com"], except: ["daily.bandcamp.com"] },
  { name: "Spotify", hosts: ["spotify.com", "spotify.link"], except: ["podcasters.spotify.com", "newsroom.spotify.com", "engineering.atspotify.com"] },
  { name: "LinkedIn", hosts: ["linkedin.com", "lnkd.in"] },
];

/** An address that is itself a feed (a service's own blog feed, say) is never refused by name. */
const FEED_LIKE_PATH = /(?:^|\/)(?:feed|feeds|rss|atom)(?:\/|\.|$)|\.(?:rss|atom|xml)$/i;

export function noFeedMessage(platform: string): string {
  return `${platform} doesn't publish feeds, so it can't be followed here. If this creator also posts on YouTube, a blog or a newsletter, follow that instead.`;
}

/** The platform an address belongs to when that platform offers no feeds, or null. */
export function noFeedPlatform(url: URL): { name: string; message: string } | null {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (FEED_LIKE_PATH.test(url.pathname)) return null;
  for (const p of PLATFORMS) {
    if (p.except?.some((e) => host === e || host.endsWith(`.${e}`))) continue;
    if (p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { name: p.name, message: noFeedMessage(p.name) };
  }
  return null;
}
