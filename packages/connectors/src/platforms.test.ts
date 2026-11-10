import assert from "node:assert/strict";
import { test } from "node:test";
import { noFeedMessage, noFeedPlatform } from "./platforms.ts";

const U = (s: string) => new URL(s);

test("platforms that publish no feeds are named, with the same plain message", () => {
  const cases: [string, string][] = [
    ["https://www.instagram.com/someone/", "Instagram"],
    ["https://instagr.am/p/abc", "Instagram"],
    ["https://www.tiktok.com/@creator", "TikTok"],
    ["https://vm.tiktok.com/abc", "TikTok"],
    ["https://www.facebook.com/page", "Facebook"],
    ["https://m.facebook.com/page", "Facebook"],
    ["https://fb.watch/abc", "Facebook"],
    ["https://x.com/user", "X (Twitter)"],
    ["https://twitter.com/user", "X (Twitter)"],
    ["https://mobile.twitter.com/user", "X (Twitter)"],
    ["https://www.threads.net/@user", "Threads"],
    ["https://chat.whatsapp.com/invite", "WhatsApp"],
    ["https://wa.me/31612345678", "WhatsApp"],
    ["https://discord.gg/abc", "Discord"],
    ["https://discord.com/invite/abc", "Discord"],
    ["https://signal.group/#abc", "Signal"],
    ["https://t.me/channel", "Telegram"],
    ["https://www.snapchat.com/add/user", "Snapchat"],
    ["https://www.twitch.tv/streamer", "Twitch"],
    ["https://someone.bandcamp.com/", "Bandcamp"],
    ["https://sacredbonesrecords.bandcamp.com/album/x", "Bandcamp"],
    ["https://open.spotify.com/show/abc", "Spotify"],
    ["https://www.linkedin.com/company/x", "LinkedIn"],
  ];
  for (const [url, name] of cases) {
    const p = noFeedPlatform(U(url));
    assert.ok(p, url);
    assert.equal(p.name, name, url);
    assert.equal(p.message, `${name} doesn't publish feeds, so it can't be followed here. If this creator also posts on YouTube, a blog or a newsletter, follow that instead.`, url);
  }
  assert.equal(noFeedMessage("Instagram"), "Instagram doesn't publish feeds, so it can't be followed here. If this creator also posts on YouTube, a blog or a newsletter, follow that instead.");
});

test("look-alike hosts, a platform's own blog and feed addresses are not refused by name", () => {
  for (const url of [
    "https://notinstagram.com/x",
    "https://instagram.com.evil.example/x",
    "https://example.org/instagram.com",
    "https://blog.twitch.tv/",
    "https://daily.bandcamp.com/",
    "https://podcasters.spotify.com/pod/show/x",
    "https://engineering.fb.com/",
    "https://signal.org/blog/",
    "https://www.example.com/feed",
    "https://twitter.com/i/rss/feed.xml",
  ]) {
    assert.equal(noFeedPlatform(U(url)), null, url);
  }
});
