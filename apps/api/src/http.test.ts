import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { clientAddress } from "./http.ts";

const req = (peer: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

test("the client address comes from the proxy only when configured and the peer is private", () => {
  assert.equal(clientAddress(req("172.18.0.5", { "x-real-ip": "203.0.113.9" }), true), "172.18.0.5", "X-Real-IP alone is ignored");
  assert.equal(clientAddress(req("172.18.0.5", { "x-real-ip": "10.6.6.6", "x-forwarded-for": "203.0.113.9" }), true), "203.0.113.9", "as Nginx Proxy Manager sends both");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "10.6.6.6, 203.0.113.9" }), true), "203.0.113.9", "a hop the client made up, left of the proxy's");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "198.51.100.1, 203.0.113.9" }), true), "203.0.113.9", "the hop the proxy appended");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "203.0.113.9" }), false), "172.18.0.5", "not configured");
  assert.equal(clientAddress(req("203.0.113.50", { "x-forwarded-for": "10.0.0.1" }), true), "203.0.113.50", "a public peer can't spoof it");
});

test("the policy built into the web page never narrows what the server's header allows", async () => {
  const { CSP } = await import("./server.ts");
  const { PAGE_POLICY } = await import("../../web/src/platform/csp.ts");
  const parse = (policy: string) => new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name!, sources]));
  const page = parse(PAGE_POLICY);
  for (const [name, sources] of parse(CSP)) {
    if (name === "frame-ancestors") continue; // not available to a page's own policy; the header sets it
    const allowed = page.get(name) ?? page.get("default-src")!;
    for (const s of sources) assert.ok(allowed.includes(s) || (s === "'none'" && allowed.length === 1 && allowed[0] === "'none'"), `${name} ${s}`);
  }
});

test("the server's header frames exactly the video players the reader embeds", async () => {
  const { CSP } = await import("./server.ts");
  const { EMBED_ORIGINS } = await import("../../web/src/lib/embeds.ts");
  const frames = /frame-src ([^;]+);/.exec(CSP)![1]!.split(" ");
  assert.deepEqual(frames, [...EMBED_ORIGINS]);
});

