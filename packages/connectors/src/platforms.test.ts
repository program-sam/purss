import assert from "node:assert/strict";
import { test } from "node:test";
import { server } from "@purss/translations/server";
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
    ["https://www.reddit.com/r/modeltrains/", "Reddit"],
    ["https://old.reddit.com/user/spez", "Reddit"],
    ["https://redd.it/abc", "Reddit"],
    // Reddit's own feed addresses answer with nothing to follow, so they are named too rather than fetched.
    ["https://www.reddit.com/r/modeltrains/.rss", "Reddit"],
  ];
  for (const [url, name] of cases) {
    const p = noFeedPlatform(U(url));
    assert.ok(p, url);
    assert.equal(p.name, name, url);
    assert.equal(p.message, server.sources.connectors.platforms.noFeed(name), url);
  }
  assert.equal(noFeedMessage("Instagram"), server.sources.connectors.platforms.noFeed("Instagram"));
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
    "https://notreddit.com/r/x",
  ]) {
    assert.equal(noFeedPlatform(U(url)), null, url);
  }
});
