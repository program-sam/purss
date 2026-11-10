import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIDGE_SERVICES, bridgeDescriptor, bridgeRoutePath, bridgeService, bridgeSignature, bridgeSignatureMatches, bridgeTargetForPage, parseBridgeDescriptor } from "./bridges.ts";
import { discover } from "./discover.ts";
import type { BridgeClient } from "./discover.ts";

const target = (url: string) => {
  const t = bridgeTargetForPage(new URL(url));
  return t ? `${t.service.id}/${t.key}` : null;
};

test("page addresses name a source; the service's other pages don't", () => {
  const cases: [string, string | null][] = [
    ["https://t.me/durov", "telegram/durov"],
    ["https://t.me/Durov/552", "telegram/durov"],
    ["https://t.me/s/durov", "telegram/durov"],
    ["https://telegram.me/durov", "telegram/durov"],
    ["https://t.me/joinchat/AbCdEf", null],
    ["https://t.me/+AbCdEfGh", null],
    ["https://t.me/addstickers/pack", null],
    ["https://t.me/abc", null],
    ["https://telegram.org/blog", null],
    ["https://nilsfrahm.bandcamp.com/", "bandcamp/nilsfrahm"],
    ["https://nilsfrahm.bandcamp.com/album/night", "bandcamp/nilsfrahm"],
    ["https://daily.bandcamp.com/features", null],
    ["https://bandcamp.com/discover", null],
    ["https://soundcloud.com/flume", "soundcloud/flume"],
    ["https://soundcloud.com/flume/tracks", "soundcloud/flume"],
    ["https://soundcloud.com/flume/all-of-the-worlds", null],
    ["https://soundcloud.com/discover", null],
    ["https://www.twitch.tv/shroud", "twitch/shroud"],
    ["https://www.twitch.tv/shroud/videos", "twitch/shroud"],
    ["https://www.twitch.tv/directory", null],
    ["https://www.twitch.tv/videos/2914038727", null],
    ["https://www.mixcloud.com/NTSRadio/", "mixcloud/ntsradio"],
    ["https://www.mixcloud.com/NTSRadio/uploads/", "mixcloud/ntsradio"],
    ["https://www.mixcloud.com/discover/jazz/", null],
    ["https://www.mixcloud.com/NTSRadio/some-show-5th-november/", null],
    ["https://rutube.ru/channel/1342940/", "rutube/1342940"],
    ["https://rutube.ru/channel/1342940/videos/", "rutube/1342940"],
    ["https://rutube.ru/video/526a0a452bab5e0d81341a49f61ea26b/", null],
    ["https://music.apple.com/us/artist/jack-johnson/909253", "applemusic/909253"],
    ["https://music.apple.com/artist/909253", "applemusic/909253"],
    ["https://music.apple.com/us/album/yard-sale-single/1876582352", null],
    ["https://example.com/durov", null],
    ["ftp://t.me/durov", null],
  ];
  for (const [url, want] of cases) assert.equal(target(url), want, url);
});

test("post ids come from the post address and belong to the source", () => {
  const id = (service: string, key: string, link: string) => bridgeService(service)!.postId(key, new URL(link));
  assert.equal(id("telegram", "durov", "https://t.me/durov/552"), "telegram:durov/552");
  assert.equal(id("telegram", "durov", "https://t.me/s/durov/552"), "telegram:durov/552");
  assert.equal(id("telegram", "breakingmash", "https://t.me/mash/79215"), "telegram:mash/79215", "a channel's posts carry its main name");
  assert.equal(id("telegram", "durov", "https://t.me/durov/552/extra"), null);
  assert.equal(id("telegram", "durov", "https://t.me/durov"), null);
  assert.equal(id("bandcamp", "nilsfrahm", "https://nilsfrahm.bandcamp.com/album/Night"), "bandcamp:nilsfrahm/album/night");
  assert.equal(id("bandcamp", "nilsfrahm", "https://other.bandcamp.com/album/night"), null);
  assert.equal(id("soundcloud", "flume", "https://soundcloud.com/flume/all-of-the-worlds"), "soundcloud:flume/all-of-the-worlds");
  assert.equal(id("soundcloud", "flume", "https://soundcloud.com/flume/sets/palaces"), "soundcloud:flume/sets/palaces");
  assert.equal(id("soundcloud", "flume", "https://soundcloud.com/someone/track"), null);
  assert.equal(id("twitch", "shroud", "https://www.twitch.tv/videos/2914038727"), "twitch:video/2914038727");
  assert.equal(id("twitch", "shroud", "https://www.twitch.tv/shroud"), null);
  assert.equal(id("mixcloud", "ntsradio", "https://www.mixcloud.com/NTSRadio/temporal-cove-5th-november-2026/"), "mixcloud:ntsradio/temporal-cove-5th-november-2026");
  assert.equal(id("mixcloud", "djjazzyjeff", "https://www.mixcloud.com/someone-else/their-show/"), null, "a show the account listened to isn't its own");
  assert.equal(id("rutube", "1342940", "https://rutube.ru/video/526a0a452bab5e0d81341a49f61ea26b/"), "rutube:video/526a0a452bab5e0d81341a49f61ea26b");
  assert.equal(id("applemusic", "909253", "https://music.apple.com/us/album/yard-sale-single/1876582352?uo=4"), "applemusic:album/1876582352");
});

test("descriptors carry no host, backend or credential, and only catalogued keys parse", () => {
  assert.equal(bridgeDescriptor("telegram", "durov"), "bridge:telegram/durov");
  assert.equal(parseBridgeDescriptor("bridge:telegram/durov")?.key, "durov");
  for (const bad of ["bridge:telegram/Du rov", "bridge:instagram/nasa", "bridge:telegram/a", "bridge:telegram/durov/x", "telegram/durov", "bridge:telegram/durov?x=1"]) {
    assert.equal(parseBridgeDescriptor(bad), null, bad);
  }
});

test("signatures bind the service and key to the installation's key", () => {
  const key = "s".repeat(43);
  const s = bridgeSignature(key, "telegram", "durov");
  assert.equal(s.length, 43);
  assert.equal(bridgeSignatureMatches(key, "telegram", "durov", s), true);
  assert.equal(bridgeSignatureMatches(key, "telegram", "pavel", s), false);
  assert.equal(bridgeSignatureMatches("t".repeat(43), "telegram", "durov", s), false);
  assert.equal(bridgeSignatureMatches(key, "telegram", "durov", s.slice(1)), false);
  assert.equal(bridgeRoutePath(key, "telegram", "durov"), `/b/telegram/durov/${s}`);
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Durov's Channel</title><link>https://t.me/durov</link>
<item><title>Hello</title><link>https://t.me/durov/552</link><guid isPermaLink="false">telegram:durov/552</guid><pubDate>Sun, 11 Oct 2026 14:52:40 GMT</pubDate></item></channel></rss>`;

test("with a bridge, a page address becomes a source previewed through the router, followed as its descriptor", async () => {
  const asked: string[] = [];
  const bridge: BridgeClient = async (t) => { asked.push(`${t.service.id}/${t.key}`); return { status: 200, body: Buffer.from(RSS) }; };
  const r = await discover("https://t.me/s/durov", { bridge });
  assert.ok(r.ok);
  assert.deepEqual(asked, ["telegram/durov"]);
  const c = r.candidates[0]!;
  assert.equal(c.feedUrl, "bridge:telegram/durov");
  assert.equal(c.siteUrl, "https://t.me/durov");
  assert.equal(c.origin, "Telegram channel");
  assert.equal(c.title, "Durov's Channel");
  assert.equal(c.samples[0]!.title, "Hello");
  assert.ok(c.note);
  const again = await discover("bridge:telegram/durov", { bridge });
  assert.ok(again.ok && again.candidates[0]!.feedUrl === "bridge:telegram/durov");
});

test("without a bridge, those services keep the honest no-feed answer, and a descriptor can't be followed", async () => {
  const r = await discover("https://t.me/durov");
  assert.ok(!r.ok && r.reason === "unsupported" && /Telegram doesn't publish feeds/.test(r.message));
  const d = await discover("bridge:telegram/durov");
  assert.ok(!d.ok && d.reason === "unsupported");
});

test("a failing router is a plain 'try again', never an empty source", async () => {
  const r = await discover("https://www.twitch.tv/shroud", { bridge: async () => ({ status: 503, body: Buffer.from("x") }) });
  assert.ok(!r.ok && r.reason === "unreachable" && /Twitch/.test(r.message));
  const t = await discover("https://www.twitch.tv/shroud", { bridge: async () => ({ failed: true }) });
  assert.ok(!t.ok && t.reason === "unreachable");
});

test("a service's pages that name no source still get the no-feed answer with a bridge", async () => {
  const bridge: BridgeClient = async () => { throw new Error("must not be asked"); };
  const r = await discover("https://t.me/joinchat/AbCdEf", { bridge });
  assert.ok(!r.ok && r.reason === "unsupported");
});

test("Telegram's placeholders for media it can't show are taken out; titles lose the backend's suffix", () => {
  const tg = bridgeService("telegram")!;
  const html = `<div class="message_media_not_supported">     <div class="message_media_not_supported_label">Media is too big</div>     <span class="message_media_view_in_telegram">VIEW IN TELEGRAM</span>   </div> Forwarded from&nbsp;<span class="tgme_widget_message_forwarded_from_name"><span dir="auto"></span></span><br><br><a href="https://t.me/durov/552">
Media is too big<br><br>
VIEW IN TELEGRAM<br><br>
<img src="https://cdn4.telesco.pe/x.jpg"/></a><div class="tgme_widget_message_text">Designers × AI</div>`;
  const out = tg.cleanHtml!(html);
  assert.doesNotMatch(out, /Media is too big|VIEW IN TELEGRAM|Forwarded from/);
  assert.match(out, /<img src="https:\/\/cdn4\.telesco\.pe\/x\.jpg"\/>/);
  assert.match(out, /Designers × AI/);
  assert.equal(tg.cleanTitle!("Pavel Durov (@durov) - Telegram"), "Pavel Durov (@durov)");
  assert.equal(bridgeService("bandcamp")!.cleanTitle!("Nils Frahm - Bandcamp Band"), "Nils Frahm");
  assert.equal(bridgeService("soundcloud")!.cleanTitle!("The Kid LAROI. - All - Soundcloud"), "The Kid LAROI.");
});

test("bridged discovery keeps discovery's deadline: cancelled, it asks nothing and says it took too long", async () => {
  let asked = 0;
  const controller = new AbortController();
  controller.abort();
  const r = await discover("https://t.me/durov", { signal: controller.signal, bridge: async () => { asked++; return { status: 200, body: Buffer.from(RSS) }; } });
  assert.ok(!r.ok && r.reason === "timeout");
  assert.equal(asked, 0);
  const slow = await discover("https://t.me/durov", { timeoutMs: 50, bridge: (_t, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ failed: true }))) });
  assert.ok(!slow.ok && slow.reason === "timeout");
});

test("every service's example account is a valid key that its own page address names", () => {
  for (const service of BRIDGE_SERVICES) {
    assert.match(service.example, service.keyPattern, service.id);
    assert.equal(service.keyFromPage(new URL(service.pageUrl(service.example))), service.example, service.id);
  }
});
