import test from "node:test";
import assert from "node:assert/strict";
import { hasCredentialShape } from "./text-safety.ts";

test("a link has a credential's shape for a username or a secret query value, not for an ordinary word in the query", () => {
  for (const url of ["https://u:p@x.example/feed", "https://x.example/feed?token=abcdef123456", "https://x.example/feed?key=Zk9aQ2xRbTJw", "https://x.example/feed?auth=abcdefgh1234", "https://x.example/feed?password=hunter22", "https://x.example/feed?sig=abcdef", "https://x.example/feed?key=xkqzvbnmplrtwhjd", "https://x.example/feed?pass=sunshine", "https://x.example/feed?auth=correcthorse", "https://x.example/feed?private=hunterhunter"]) assert.ok(hasCredentialShape(url), url);
  for (const url of ["https://x.example/feed?key=tech-news", "https://x.example/feed?key=1", "https://x.example/feed?page=2"]) assert.ok(!hasCredentialShape(url), url);
});
