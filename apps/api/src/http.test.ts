import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { clientAddress, parseTrustProxy, watchTrustedProxies } from "./http.ts";

const req = (peer: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

test("the client address comes from the proxy only when configured and the peer is private", () => {
  assert.equal(clientAddress(req("172.18.0.5", { "x-real-ip": "203.0.113.9" }), "private"), "172.18.0.5", "X-Real-IP alone is ignored");
  assert.equal(clientAddress(req("172.18.0.5", { "x-real-ip": "10.6.6.6", "x-forwarded-for": "203.0.113.9" }), "private"), "203.0.113.9", "as Nginx Proxy Manager sends both");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "10.6.6.6, 203.0.113.9" }), "private"), "203.0.113.9", "a hop the client made up, left of the proxy's");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "198.51.100.1, 203.0.113.9" }), "private"), "203.0.113.9", "the hop the proxy appended");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "203.0.113.9" }), false), "172.18.0.5", "not configured");
  assert.equal(clientAddress(req("203.0.113.50", { "x-forwarded-for": "10.0.0.1" }), "private"), "203.0.113.50", "a public peer can't spoof it");
});

test("named proxies: only they may give the client address, other private peers can't", async () => {
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("0"), false);
  assert.equal(parseTrustProxy("1"), "private");
  assert.deepEqual(parseTrustProxy(" 172.18.0.5, Proxy.Local "), ["172.18.0.5", "proxy.local"]);
  const byAddress = parseTrustProxy("172.18.0.5");
  assert.equal(clientAddress(req("172.18.0.5", { "x-forwarded-for": "203.0.113.9" }), byAddress), "203.0.113.9", "the named proxy");
  assert.equal(clientAddress(req("::ffff:172.18.0.5", { "x-forwarded-for": "203.0.113.9" }), byAddress), "203.0.113.9", "the same proxy over IPv4-mapped IPv6");
  assert.equal(clientAddress(req("172.18.0.6", { "x-forwarded-for": "203.0.113.9" }), byAddress), "172.18.0.6", "a neighbour on the proxy network");
  const byName = parseTrustProxy("localhost");
  const stop = watchTrustedProxies(byName);
  try {
    for (let i = 0; i < 50 && clientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), byName) === "127.0.0.1"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(clientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), byName), "203.0.113.9", "a proxy named by host name, once looked up");
    assert.equal(clientAddress(req("10.0.0.7", { "x-forwarded-for": "203.0.113.9" }), byName), "10.0.0.7", "a private peer the name doesn't resolve to");
  } finally { stop(); }
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

test("a large upload that stalls or trickles is given up, so it can't hold the one-at-a-time slot", async () => {
  const { readBody, HttpError } = await import("./http.ts");
  const upload = (headers: Record<string, string> = {}) => Object.assign(new PassThrough(), { method: "POST", headers }) as unknown as IncomingMessage & PassThrough;
  const big = 10_000_000;
  const pace = { stallMs: 100, minRate: 1000, rateAfterMs: 150 };
  const isCode = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;

  const stalled = upload();
  stalled.write("{\"a\":");
  await assert.rejects(readBody(stalled, big, pace), isCode("upload_stalled"), "nothing more for longer than the pause allowed");

  const trickle = upload();
  const drip = setInterval(() => trickle.write("x"), 20);
  await assert.rejects(readBody(trickle, big, pace), isCode("upload_stalled"), "a byte at a time, never pausing long, is still too slow");
  clearInterval(drip);

  const endless = upload();
  const pour = setInterval(() => endless.write("x".repeat(100)), 10);
  await assert.rejects(readBody(endless, big, { ...pace, minRate: 1, maxMs: 200 }), isCode("upload_stalled"), "a steady upload past its time limit is given up");
  clearInterval(pour);

  const steady = upload({ "content-type": "application/json" });
  setTimeout(() => steady.end("{\"ok\":true}"), 50);
  assert.deepEqual(await readBody(steady, big, pace), { ok: true }, "an upload that keeps coming is read");

  const announced = upload({ "content-length": String(big + 1) });
  await assert.rejects(readBody(announced, big, pace), isCode("too_large"), "refused on its announced size, before reading");

  const small = upload();
  setTimeout(() => small.end("quick and small"), 50);
  assert.equal(await readBody(small, 1000, pace), "quick and small", "a small body that arrives is read");
});

test("public bodies being read add up to a limit, overall and per sender; the internal listener's don't count", async () => {
  const { readBody, HttpError, BODIES_IN_MEMORY_LIMIT, BODIES_PER_ACCOUNT_LIMIT, BODIES_PER_ADDRESS_LIMIT, accountSender, addressSender } = await import("./http.ts");
  const upload = () => Object.assign(new PassThrough(), { method: "POST", headers: {} }) as unknown as IncomingMessage & PassThrough;
  const piece = Buffer.alloc(256 * 1024, 120);
  const busy = (e: unknown) => e instanceof HttpError && e.status === 503 && e.code === "busy";
  const hold = (from: ReturnType<typeof accountSender> | null) => { const u = upload(); const read = readBody(u, 4 * piece.length, undefined, from); u.write(piece); return { u, read }; };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const held: ReturnType<typeof hold>[] = [];

  // Someone not signed in: a small share per network address, an IPv6 /64 counting as one.
  held.push(...Array.from({ length: BODIES_PER_ADDRESS_LIMIT / piece.length }, (_, i) => hold(addressSender(`2001:db8:1:2::${i + 1}`))));
  await settle();
  await assert.rejects(hold(addressSender("2001:db8:1:2:ffff::9")).read, busy, "another address in the same /64 shares the share");
  held.push(hold(addressSender("2001:db8:1:3::1")));
  // A signed-in account: a quarter of the whole.
  held.push(...Array.from({ length: BODIES_PER_ACCOUNT_LIMIT / piece.length }, () => hold(accountSender("acc_a"))));
  await settle();
  await assert.rejects(hold(accountSender("acc_a")).read, busy, "the account is turned away past its share");
  // Everyone together: fill the rest from other accounts, then even a new sender waits.
  const room = BODIES_IN_MEMORY_LIMIT - BODIES_PER_ADDRESS_LIMIT - piece.length - BODIES_PER_ACCOUNT_LIMIT;
  held.push(...Array.from({ length: room / piece.length }, (_, i) => hold(accountSender(`acc_${Math.floor(i / 32)}`))));
  await settle();
  await assert.rejects(hold(accountSender("acc_new")).read, busy, "full overall");
  const signIn = upload();
  const small = readBody(signIn, 64 * 1024, undefined, addressSender("192.0.2.200"));
  signIn.end("{\"email\":\"a@example.org\"}");
  assert.deepEqual(JSON.parse((await small) as string), { email: "a@example.org" }, "a small form still gets in: small bodies have a budget of their own");
  const internal = hold(null);
  internal.u.end();
  assert.equal(((await internal.read) as string).length, piece.length, "the internal listener's bodies aren't counted or refused");
  for (const h of held) h.u.end();
  await Promise.all(held.map((h) => h.read));
  const after = hold(accountSender("acc_a"));
  after.u.end();
  assert.equal(((await after.read) as string).length, piece.length, "room again once they finish");
  assert.equal(addressSender("::ffff:203.0.113.5").key, "address:203.0.113.5", "an IPv4 address written as IPv6 is the IPv4 address");
});


test("a small body that stalls is given up too, so slow requests can't hold memory", async () => {
  const { readBody, HttpError } = await import("./http.ts");
  const u = Object.assign(new PassThrough(), { method: "POST", headers: {} }) as unknown as IncomingMessage & PassThrough;
  u.write("{\"email\":");
  await assert.rejects(readBody(u, 64 * 1024, { stallMs: 100, minRate: 1000, rateAfterMs: 150 }), (e: unknown) => e instanceof HttpError && e.code === "upload_stalled");
});
