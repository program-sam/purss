import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { server } from "@purss/copy/server";
import { BRIDGE_SERVICES, bridgeDescriptor, bridgeRoutePath, bridgeService, bridgeSignature, bridgeSignatureMatches, bridgeTargetForPage, copyOnlyPicture, parseBridgeDescriptor } from "./bridges.ts";
import { discover } from "./discover.ts";
import { parseFeed } from "./feed.ts";
import type { BridgeClient } from "./discover.ts";

const copy = server.sources.connectors;

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
    ["https://www.instagram.com/some.maker_studio/", "instagram/some.maker_studio"],
    ["https://instagram.com/NatGeo", "instagram/natgeo"],
    ["https://www.instagram.com/natgeo/reels/", "instagram/natgeo"],
    ["https://www.instagram.com/natgeo/?hl=en", "instagram/natgeo"],
    ["https://www.instagram.com/p/DfxGoxTl16O/", null],
    ["https://www.instagram.com/reel/Df2QAetAuYB/", null],
    ["https://www.instagram.com/stories/natgeo/123/", null],
    ["https://www.instagram.com/explore/tags/glacier/", null],
    ["https://www.instagram.com/accounts/login/", null],
    ["https://www.instagram.com/creators/", "instagram/creators"],
    ["https://www.instagram.com/legal/", "instagram/legal"],
    ["https://www.instagram.com/.natgeo/", null],
    ["https://www.instagram.com/nat..geo/", null],
    ["https://www.instagram.com/natgeo./", null],
    ["https://www.instagram.com/natgeo/followers/", null],
    ["https://about.instagram.com/blog", null],
    ["https://mangadex.org/title/801513ba-a712-498c-8f57-cae55b38cc92", "mangadex/801513ba-a712-498c-8f57-cae55b38cc92"],
    ["https://mangadex.org/title/801513BA-A712-498C-8F57-CAE55B38CC92/berserk", "mangadex/801513ba-a712-498c-8f57-cae55b38cc92"],
    ["https://mangadex.org/chapter/c0cd4656-6946-4be8-8d33-0aeb2fbeddfb", null],
    ["https://mangadex.org/title/not-a-uuid", null],
    ["https://mangadex.org/titles/latest", null],
    ["https://api.mangadex.org/title/801513ba-a712-498c-8f57-cae55b38cc92", null],
    ["https://vkvideo.ru/@thoisoi", "vkvideo/thoisoi"],
    ["https://www.vkvideo.ru/@Thoisoi/clips", "vkvideo/thoisoi"],
    ["https://vk.com/video/@thoisoi", "vkvideo/thoisoi"],
    ["https://vkvideo.ru/video-22629421_456240181", null],
    ["https://vkvideo.ru/playlist/-142758151_-4", null],
    ["https://vkvideo.ru/@thoisoi/other", null],
    ["https://vk.com/thoisoi", null],
    ["https://vk.com/video/@", null],
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
  assert.equal(id("instagram", "natgeo", "https://www.instagram.com/p/DfxGoxTl16O/"), "instagram:p/DfxGoxTl16O", "short codes keep their case");
  assert.equal(id("instagram", "natgeo", "https://www.instagram.com/reel/DfxGoxTl16O/"), "instagram:p/DfxGoxTl16O", "a reel is the same post");
  assert.equal(id("instagram", "natgeo", "https://www.instagram.com/natgeo/"), null);
  assert.equal(id("instagram", "natgeo", "https://www.instagram.com/p/DfxGoxTl16O/media"), null);
  assert.equal(id("instagram", "natgeo", "https://example.com/p/DfxGoxTl16O/"), null);
  assert.equal(id("applemusic", "909253", "https://music.apple.com/us/album/yard-sale-single/1876582352?uo=4"), "applemusic:album/1876582352");
  const berserk = "801513ba-a712-498c-8f57-cae55b38cc92";
  assert.equal(id("mangadex", berserk, "https://mangadex.org/chapter/C0CD4656-6946-4BE8-8D33-0AEB2FBEDD"), null, "not a uuid");
  assert.equal(id("mangadex", berserk, "https://mangadex.org/chapter/C0CD4656-6946-4BE8-8D33-0AEB2FBEDDFB"), "mangadex:chapter/c0cd4656-6946-4be8-8d33-0aeb2fbeddfb");
  assert.equal(id("mangadex", berserk, `https://mangadex.org/title/${berserk}`), null);
  assert.equal(id("mangadex", berserk, "https://example.com/chapter/c0cd4656-6946-4be8-8d33-0aeb2fbeddfb"), null);
  assert.equal(id("vkvideo", "thoisoi", "https://vkvideo.ru/video-22629421_456240181"), "vkvideo:video/-22629421_456240181");
  assert.equal(id("vkvideo", "thoisoi", "https://vkvideo.ru/video123_456"), "vkvideo:video/123_456");
  assert.equal(id("vkvideo", "thoisoi", "https://vkvideo.ru/@thoisoi"), null);
  assert.equal(id("vkvideo", "thoisoi", "https://vkvideo.ru/playlist/-142758151_-4"), null);
  assert.equal(id("vkvideo", "thoisoi", "https://vkvideo.ru/video-22629421"), null);
  assert.equal(id("vkvideo", "thoisoi", "https://example.com/video-22629421_456240181"), null);
});

test("descriptors carry no host, backend or credential, and only catalogued keys parse", () => {
  assert.equal(bridgeDescriptor("telegram", "durov"), "bridge:telegram/durov");
  assert.equal(parseBridgeDescriptor("bridge:telegram/durov")?.key, "durov");
  for (const bad of ["bridge:telegram/Du rov", "bridge:tiktok/nasa", "bridge:instagram/.nasa", "bridge:telegram/a", "bridge:telegram/durov/x", "telegram/durov", "bridge:telegram/durov?x=1"]) {
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
  assert.equal(c.origin, copy.bridges.telegram);
  assert.equal(c.title, "Durov's Channel");
  assert.equal(c.samples[0]!.title, "Hello");
  assert.ok(c.note);
  const again = await discover("bridge:telegram/durov", { bridge });
  assert.ok(again.ok && again.candidates[0]!.feedUrl === "bridge:telegram/durov");
});

test("without a bridge, those services keep the honest no-feed answer, and a descriptor can't be followed", async () => {
  const r = await discover("https://t.me/durov");
  assert.ok(!r.ok && r.reason === "unsupported" && r.message === copy.platforms.noFeed("Telegram"));
  const d = await discover("bridge:telegram/durov");
  assert.ok(!d.ok && d.reason === "unsupported");
});

test("a failing router is a plain 'try again', never an empty source", async () => {
  const r = await discover("https://www.twitch.tv/shroud", { bridge: async () => ({ status: 503, body: Buffer.from("x") }) });
  assert.ok(!r.ok && r.reason === "unreachable" && r.message === copy.discover.bridgeNoPostsCheck("Twitch", "shroud"));
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

test("a MangaDex title page and a VK Video channel page become sources previewed through the router, named by what the service's address names", async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>A source</title><link>https://example.com/</link>`
    + `<item><title>One</title><link>https://example.com/1</link><guid isPermaLink="false">x:1</guid><pubDate>Sun, 11 Oct 2026 14:52:40 GMT</pubDate></item></channel></rss>`;
  const berserk = "801513ba-a712-498c-8f57-cae55b38cc92";
  for (const [page, descriptor, site, origin] of [
    [`https://mangadex.org/title/${berserk.toUpperCase()}/berserk`, `bridge:mangadex/${berserk}`, `https://mangadex.org/title/${berserk}`, copy.bridges.mangadex],
    ["https://vk.com/video/@Thoisoi", "bridge:vkvideo/thoisoi", "https://vkvideo.ru/@thoisoi", copy.bridges.vkvideo],
  ] as const) {
    const asked: string[] = [];
    const r = await discover(page, { bridge: async (t) => { asked.push(`bridge:${t.service.id}/${t.key}`); return { status: 200, body: Buffer.from(rss) }; } });
    assert.ok(r.ok, page);
    assert.deepEqual(asked, [descriptor], page);
    assert.equal(r.candidates[0]!.feedUrl, descriptor, page);
    assert.equal(r.candidates[0]!.siteUrl, site, page);
    assert.equal(r.candidates[0]!.origin, origin, page);
    // What an export writes for the source is its page address, which names the same source again.
    assert.equal(target(site), descriptor.slice("bridge:".length), page);
  }
});

test("each RSS-Bridge service asks its bridge for what it needs, and nothing the person typed but the key", () => {
  const ask = (id: string, key: string) => {
    const b = bridgeService(id)!.backend;
    return b.kind === "rss-bridge" ? { bridge: b.bridge, ...b.params(key) } : null;
  };
  assert.deepEqual(ask("mangadex", "801513ba-a712-498c-8f57-cae55b38cc92"), {
    bridge: "MangaDexBridge", context: "Title Chapters", url: "https://mangadex.org/title/801513ba-a712-498c-8f57-cae55b38cc92", limit: "50", images: "no",
  });
  assert.deepEqual(ask("vkvideo", "thoisoi"), { bridge: "VkVideoBridge", context: "Channel", u: "@thoisoi" });
});

test("only a service's own key patterns pass: a key can't reach past its place in the bridge's address", () => {
  const accepts = (id: string, key: string) => bridgeService(id)!.keyPattern.test(key);
  for (const [id, key] of [
    ["mangadex", "801513ba-a712-498c-8f57-cae55b38cc9"], ["mangadex", "801513ba-a712-498c-8f57-cae55b38cc92/feed"], ["mangadex", "801513BA-A712-498C-8F57-CAE55B38CC92"],
    ["vkvideo", "thoi/soi"], ["vkvideo", "@thoisoi"], ["vkvideo", "t"], ["vkvideo", ".thoisoi"],
  ] as const) assert.equal(accepts(id, key), false, `${id}/${key}`);
  for (const [id, key] of [["mangadex", "801513ba-a712-498c-8f57-cae55b38cc92"], ["vkvideo", "thoisoi"], ["vkvideo", "a.b_c"]] as const) {
    assert.equal(accepts(id, key), true, `${id}/${key}`);
  }
});

test("the backend's decoration is taken off MangaDex's source name", () => {
  assert.equal(bridgeService("mangadex")!.cleanTitle!("Berserk Chapters"), "Berserk");
});

const recorded = (name: string) => parseFeed(readFileSync(new URL(`./fixtures/bridges/${name}.atom`, import.meta.url)), "application/atom+xml");

test("recorded outputs of MangaDex and VK Video give every entry a distinct stable id from its link, and the entries are dated", () => {
  const berserk = "801513ba-a712-498c-8f57-cae55b38cc92";
  for (const [file, service, key, want] of [
    ["mangadex-berserk", "mangadex", berserk, [
      "c0cd4656-6946-4be8-8d33-0aeb2fbeddfb", "cb0148ea-ba2e-487a-b368-2a9346350b5c", "a153d3b0-d79c-459e-912b-ed6c24dc1738", "62650219-b889-4a63-960b-0ac4add893a7",
      "4b7b0d08-b690-47a3-b9d1-73c1e230c4e1", "c95f6343-24c9-4476-af3c-a4d904238734", "17f089d2-d457-4718-89f5-4c41cf5f29a4", "88d18567-d54a-4c76-8e4e-d419291ce38b",
    ].map((u) => `mangadex:chapter/${u}`)],
    ["vkvideo-thoisoi", "vkvideo", "thoisoi", [456240181, 456240180, 456240179, 456240178, 456240177].map((n) => `vkvideo:video/-22629421_${n}`)],
  ] as const) {
    const feed = recorded(file);
    const svc = bridgeService(service)!;
    assert.deepEqual(feed.items.map((i) => svc.postId(key, new URL(i.url!))), want, file);
    assert.ok(feed.items.every((i) => i.publishedAt && !Number.isNaN(Date.parse(i.publishedAt))), `${file}: every entry is dated`);
    assert.equal(svc.excluded?.(key, new URL(feed.items[0]!.url!)) ?? false, false, file);
  }
  // Names, with the backend's decoration off: the source's own.
  assert.equal(bridgeService("mangadex")!.cleanTitle!(recorded("mangadex-berserk").title!), "Berserk");
  // MangaDex marks each chapter's language in its title, every language arriving in one list.
  assert.match(recorded("mangadex-berserk").items[0]!.title!, /^Volume 14 Chapter 93 - .+ \[bg\]$/);
  // VK's titles arrive with HTML escapes already undone by the feed reader.
  assert.equal(recorded("vkvideo-thoisoi").items[0]!.title, "Расплавленная СОЛЬ - Самая ОПАСНАЯ Жидкость!");
});

test("a MangaDex title the site doesn't know comes back as a feed with no entries, which is why the service counts that as a failure", () => {
  const feed = recorded("mangadex-unknown-title");
  assert.equal(feed.items.length, 0);
  assert.equal(bridgeService("mangadex")!.emptyIsFailure, true);
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

test("Instagram posts keep only their caption in their text; an escape linked as a hashtag is undone", () => {
  const ig = bridgeService("instagram")!;
  const feed = parseFeed(readFileSync(new URL("./fixtures/bridges/instagram-natgeo.atom", import.meta.url)), "application/atom+xml");
  assert.equal(ig.cleanTitle!(feed.title!), "natgeo");
  const [video, carousel, picture] = feed.items.map((i) => ig.cleanHtml!(i.contentHtml!));
  for (const html of [video!, carousel!, picture!]) assert.doesNotMatch(html, /<img|<video|<source|cdninstagram|fbcdn|media\?size/);
  assert.match(video!, /^Not sure we can think of an answer better than @tanyabadillo/);
  assert.match(carousel!, /^National Geographic photographers/);
  assert.match(picture!, /^Drawn to the light filtering through its ice formations/);
  assert.match(picture!, /Alaska&#039;s Sheridan Glacier/);
  assert.equal(ig.emptyIsFailure, true);
});

test("an Instagram post names its pictures for keeping: its lasting first picture, then the rest of a carousel", () => {
  const ig = bridgeService("instagram")!;
  const feed = parseFeed(readFileSync(new URL("./fixtures/bridges/instagram-natgeo.atom", import.meta.url)), "application/atom+xml");
  const [video, carousel, picture] = feed.items.map((i) => ig.keptPictures!(new URL(i.url!), i.contentHtml!));
  assert.deepEqual(video, { cover: "https://www.instagram.com/p/Df2QAetAuYB/media/?size=l", more: [] });
  assert.deepEqual(carousel, { cover: "https://www.instagram.com/p/Df147tCiAyB/media/?size=l",
    more: ["https://scontent.cdninstagram.com/v/t51.82787-15/914384603_18720223210019133_7491756309452445712_n.jpg?stp=dst-jpg&oe=00000000"] });
  assert.deepEqual(picture, { cover: "https://www.instagram.com/p/DfxGoxTl16O/media/?size=l", more: [] });
  // Only Instagram's own picture servers: anything else the HTML names is not a picture of the post.
  assert.deepEqual(ig.keptPictures!(new URL("https://www.instagram.com/p/AbCdE1/"), '<img src="https://scontent.cdninstagram.com/a.jpg"><img src="https://evil.example/b.jpg"><img src="http://scontent.cdninstagram.com/c.jpg"><img src="https://x.fbcdn.net/d.jpg?a=1&amp;b=2">').more,
    ["https://x.fbcdn.net/d.jpg?a=1&b=2"]);
});

test("Instagram's pictures are shown only from a stored copy; every other picture as it is", () => {
  for (const u of ["https://scontent-fra5-1.cdninstagram.com/v/x.jpg", "https://www.instagram.com/p/AbCdE1/media/?size=l", "https://instagram.com/reel/AbCdE1/media", "https://x.fbcdn.net/y.jpg"])
    assert.equal(copyOnlyPicture(u), true, u);
  for (const u of [null, "", "not a url", "https://www.instagram.com/p/AbCdE1/", "https://cdninstagram.com.evil.example/x.jpg", "https://example.com/media/?size=l"])
    assert.equal(copyOnlyPicture(u), false, String(u));
});
