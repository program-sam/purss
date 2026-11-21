import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeName } from "./typed-name.ts";

test("names of sites and shows are told from addresses", () => {
  for (const name of ["the verge", "Hacker News", "football weekly", "Football Weekly", "99% Invisible", "Dr. Phil", "Serial: Season 3", "serial", "Radiolab", "Les Podcasts de l'été", "Stuff You Should Know", "Top 10: 2024"]) assert.ok(looksLikeName(name), name);
  for (const addr of ["quietharbour.example", "bbc.co.uk/news", "https://example.org", "http://x", "@name@server", "name.bsky.social", "feed:https://x.example/rss", "youtube.com/@x", "a@b.c", "mailto:a@b.c", "localhost:8080", "intranet:3000", "", " ", "x", "1234", "!!!"]) assert.ok(!looksLikeName(addr), addr);
});
