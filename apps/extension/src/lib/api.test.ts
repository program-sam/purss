import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceError, exchangeCode, fetchInfo, signedOut, workspace } from "./api.ts";

type Seen = { url: string; init: RequestInit };
function fakeFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    return reply(String(input), init);
  }) as typeof fetch;
  return { f, seen };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const info = (origin: string) => ({ service: "purss", name: "PURSS", origin, hosted: false, connect: {}, features: { urlLookup: true, browserCapture: true } });

test("connect info must come from a PURSS that calls itself by this address", async () => {
  assert.equal((await fetchInfo("https://ws.example", fakeFetch(() => json(200, info("https://ws.example"))).f)).name, "PURSS");
  await assert.rejects(fetchInfo("https://ws.example", fakeFetch(() => json(200, info("https://other.example"))).f), (e: WorkspaceError) => e.code === "other_origin" && /https:\/\/other.example/.test(e.message));
  await assert.rejects(fetchInfo("https://ws.example", fakeFetch(() => json(200, { hello: "world" })).f), (e: WorkspaceError) => e.code === "not_workspace");
  await assert.rejects(fetchInfo("https://ws.example", fakeFetch(() => new Response("<html>", { status: 404 })).f), (e: WorkspaceError) => e.code === "not_workspace");
  await assert.rejects(fetchInfo("https://ws.example", fakeFetch(() => { throw new TypeError("network"); }).f), (e: WorkspaceError) => e.code === "offline");
});

test("requests carry the device token, never cookies, and only go to the PURSS", async () => {
  const { f, seen } = fakeFetch((url) => url.includes("lookup") ? json(200, { item: null, followedSources: [] }) : json(200, { itemId: "itm_1" }));
  const ws = workspace({ origin: "https://ws.example", token: "purss_dev_secret" }, f);
  await ws.lookup("https://news.example/a?b=1&c=2#x");
  await ws.keep({ url: "https://news.example/a", basketId: "bsk_1", title: "A" });
  assert.equal(seen[0]!.url, "https://ws.example/api/items/lookup?url=https%3A%2F%2Fnews.example%2Fa%3Fb%3D1%26c%3D2%23x");
  assert.equal(seen[1]!.url, "https://ws.example/api/items/manual");
  for (const s of seen) {
    assert.equal(s.init.credentials, "omit");
    assert.equal((s.init.headers as Record<string, string>).authorization, "Bearer purss_dev_secret");
  }
  assert.deepEqual(JSON.parse(String(seen[1]!.init.body)), { url: "https://news.example/a", basketId: "bsk_1", title: "A" });
});

test("a revoked token, a refusal and an oversized page are told apart", async () => {
  const ws = (r: Response) => workspace({ origin: "https://ws.example", token: "t" }, fakeFetch(() => r).f);
  const revoked = await ws(json(401, { error: { code: "device_signed_out", message: "Connect it again." } })).baskets().catch((e) => e);
  assert.ok(signedOut(revoked));
  const refused = await ws(json(403, { error: { code: "not_for_apps", message: "The extension can't do that." } })).baskets().catch((e) => e);
  assert.deepEqual([refused.status, refused.code, refused.message, signedOut(refused)], [403, "not_for_apps", "The extension can't do that.", false]);
  const big = await ws(new Response("", { status: 413 })).keepWithText({ url: "https://a.example", basketId: "b", html: "<p>x</p>" }).catch((e) => e);
  assert.equal(big.code, "too_large");
});

test("the code exchange names the extension and sends the verifier", async () => {
  const { f, seen } = fakeFetch(() => json(200, { token: "purss_dev_x", tokenType: "Bearer", device: { id: "dev_1" } }));
  await exchangeCode("https://ws.example", { code: "abcd-efgh-ijkm", verifier: "v".repeat(43) }, f);
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { client: "extension", code: "abcd-efgh-ijkm", codeVerifier: "v".repeat(43) });
  await exchangeCode("https://ws.example", { code: "K", verifier: "v".repeat(43), redirectUri: "https://abc.chromiumapp.org/" }, f);
  assert.equal(JSON.parse(String(seen[1]!.init.body)).redirectUri, "https://abc.chromiumapp.org/");
});
