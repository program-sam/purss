import test from "node:test";
import assert from "node:assert/strict";
import { EMBED_ORIGINS, embedFor } from "./embeds.ts";

const https = { protocol: "https:", hostname: "purss.example" };

test("YouTube video pages play in YouTube's no-cookie player, from where a link starts", () => {
  const src = (url: string) => embedFor(url, https)?.src;
  assert.equal(src("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
  assert.equal(src("https://youtu.be/dQw4w9WgXcQ?t=90"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90");
  assert.equal(src("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=3723");
  assert.equal(src("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
  assert.equal(src("https://www.youtube.com/live/dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
  for (const notVideo of ["https://www.youtube.com/@channel", "https://www.youtube.com/playlist?list=PL123", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%3E", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"]) {
    assert.equal(embedFor(notVideo, https), null, notVideo);
  }
});

test("Vimeo, Dailymotion and Odysee video pages play in their own players; other pages of theirs don't", () => {
  assert.equal(embedFor("https://vimeo.com/76979871", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
  assert.equal(embedFor("https://vimeo.com/76979871/abc123def", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1&h=abc123def", "an unlisted video keeps its key");
  assert.equal(embedFor("https://player.vimeo.com/video/76979871?h=abc123def", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1&h=abc123def");
  assert.equal(embedFor("https://player.vimeo.com/video/76979871?h=x%26dnt%3D0%26api%3D1", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1", "a key that isn't one can't add parameters to the player");
  assert.equal(embedFor("https://vimeo.com/channels/staffpicks/76979871", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
  assert.equal(embedFor("https://vimeo.com/showcase/123456/video/76979871", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1", "a video in a showcase is the video, not the showcase");
  assert.equal(embedFor("https://vimeo.com/groups/name/videos/76979871", https)?.src, "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
  for (const notVideo of ["https://vimeo.com/user123/videos", "https://vimeo.com/showcase/123456", "https://vimeo.com/album/123456", "https://vimeo.com/channels/staffpicks"]) assert.equal(embedFor(notVideo, https), null, notVideo);
  assert.equal(embedFor("https://www.dailymotion.com/video/x8j6v5c", https)?.src, "https://geo.dailymotion.com/player.html?video=x8j6v5c&autoplay=1");
  assert.equal(embedFor("https://dai.ly/x8j6v5c", https)?.src, "https://geo.dailymotion.com/player.html?video=x8j6v5c&autoplay=1");
  assert.equal(embedFor("https://www.dailymotion.com/somechannel", https), null);
  assert.equal(embedFor("https://odysee.com/@Odysee:8/odysee-is-live:5", https)?.src, "https://odysee.com/$/embed/@Odysee:8/odysee-is-live:5?autoplay=true", "the channel stays: a short id is unique only within it");
  assert.notEqual(embedFor("https://odysee.com/@one:a/test:b", https)?.src, embedFor("https://odysee.com/@two:c/test:b", https)?.src);
  assert.equal(embedFor("https://odysee.com/odysee-is-live:5", https)?.src, "https://odysee.com/$/embed/odysee-is-live:5?autoplay=true");
  assert.equal(embedFor("https://odysee.com/@Odysee:8", https), null, "a channel isn't a video");
  assert.equal(embedFor("https://odysee.com/$/rss/@Odysee:8", https), null);
});

test("Twitch is told the page's host name, and is left as a link where it would refuse to play", () => {
  assert.equal(embedFor("https://www.twitch.tv/videos/123456", https)?.src, "https://player.twitch.tv/?video=123456&parent=purss.example&autoplay=true");
  assert.equal(embedFor("https://clips.twitch.tv/FunnyClip-abc", https)?.src, "https://clips.twitch.tv/embed?clip=FunnyClip-abc&parent=purss.example&autoplay=true");
  assert.equal(embedFor("https://www.twitch.tv/name/clip/FunnyClip-abc", https)?.src, "https://clips.twitch.tv/embed?clip=FunnyClip-abc&parent=purss.example&autoplay=true");
  assert.equal(embedFor("https://www.twitch.tv/videos/123456", { protocol: "http:", hostname: "localhost" })?.src, "https://player.twitch.tv/?video=123456&parent=localhost&autoplay=true");
  assert.equal(embedFor("https://www.twitch.tv/videos/123456", { protocol: "http:", hostname: "purss.lan" }), null, "Twitch plays only on https pages");
  assert.equal(embedFor("https://www.twitch.tv/videos/123456", null), null);
  assert.equal(embedFor("https://www.twitch.tv/videos/123456", { protocol: "https:", hostname: "localhost" })?.src, "https://player.twitch.tv/?video=123456&parent=localhost&autoplay=true", "the Android app's page");
  assert.equal(embedFor("https://www.twitch.tv/somechannel", https), null, "a live channel page isn't embedded");
});

test("in an app whose page isn't a web address only Odysee is embedded: the other players refuse to play there", () => {
  for (const page of [{ protocol: "tauri:", hostname: "localhost" }, { protocol: "capacitor:", hostname: "localhost" }]) {
    for (const url of ["https://youtu.be/dQw4w9WgXcQ", "https://vimeo.com/76979871", "https://dai.ly/x8j6v5c", "https://www.twitch.tv/videos/1", "https://clips.twitch.tv/c"]) assert.equal(embedFor(url, page), null, `${page.protocol} ${url}`);
    assert.equal(embedFor("https://odysee.com/@Odysee:8/odysee-is-live:5", page)?.platform, "Odysee", page.protocol);
  }
  assert.equal(embedFor("https://youtu.be/dQw4w9WgXcQ", { protocol: "http:", hostname: "tauri.localhost" })?.platform, "YouTube", "the Windows desktop app's page is a web address");
});

test("PeerTube and other sites, and anything that isn't a web address, stay links", () => {
  for (const url of ["https://peertube.example/w/abc", "https://example.com/video.mp4", "javascript:alert(1)", "not a url", "", null]) assert.equal(embedFor(url, https), null, String(url));
});

test("every player address is on an origin the page policies allow, over https", () => {
  for (const url of ["https://youtu.be/dQw4w9WgXcQ", "https://vimeo.com/1", "https://dai.ly/x8j6v5c", "https://odysee.com/a:1", "https://www.twitch.tv/videos/1", "https://clips.twitch.tv/c"]) {
    const src = new URL(embedFor(url, https)!.src);
    assert.ok((EMBED_ORIGINS as readonly string[]).includes(src.origin), src.origin);
  }
});
