import test from "node:test";
import assert from "node:assert/strict";
import { challengeFor, cleanTypedCode, connectPageUrl, deviceNameFor, randomVerifier, readRedirect } from "./connect.ts";

test("the PKCE challenge is S256 of the verifier (RFC 7636 appendix B), and verifiers are fresh and well-formed", async () => {
  assert.equal(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const a = randomVerifier();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/, "what the PURSS accepts");
  assert.notEqual(a, randomVerifier());
});

test("the approval page address names the extension, the challenge and, for a redirect, where to return", () => {
  const typed = new URL(connectPageUrl("https://ws.example", { challenge: "C", deviceName: "Firefox on Linux" }));
  assert.equal(typed.origin + typed.pathname, "https://ws.example/app/connect");
  assert.deepEqual(Object.fromEntries(typed.searchParams), { client: "extension", code_challenge: "C", code_challenge_method: "S256", device_name: "Firefox on Linux" });
  const redirect = new URL(connectPageUrl("https://ws.example", { challenge: "C", deviceName: "Chrome on macOS", redirect: { uri: "https://abc.chromiumapp.org/", state: "S123456789" } }));
  assert.equal(redirect.searchParams.get("redirect_uri"), "https://abc.chromiumapp.org/");
  assert.equal(redirect.searchParams.get("state"), "S123456789");
});

test("only an answer to this attempt from this PURSS yields a code", () => {
  const expected = { redirectUri: "https://abc.chromiumapp.org/", state: "state-1", origin: "https://ws.example" };
  const back = (q: Record<string, string>, base = expected.redirectUri) => `${base}?${new URLSearchParams(q)}`;
  assert.deepEqual(readRedirect(back({ code: "K", state: "state-1", iss: "https://ws.example" }), expected), { ok: true, code: "K" });
  assert.equal((readRedirect(back({ error: "access_denied", state: "state-1", iss: "https://ws.example" }), expected) as { reason: string }).reason, "declined");
  assert.equal((readRedirect(back({ code: "K", state: "other", iss: "https://ws.example" }), expected) as { reason: string }).reason, "mismatch");
  assert.equal((readRedirect(back({ code: "K", state: "state-1", iss: "https://evil.example" }), expected) as { reason: string }).reason, "mismatch", "a code from another PURSS");
  assert.equal((readRedirect(back({ code: "K", state: "state-1" }), expected) as { reason: string }).reason, "mismatch", "no issuer");
  assert.equal((readRedirect(back({ code: "K", state: "state-1", iss: "https://ws.example" }, "https://evil.example/"), expected) as { reason: string }).reason, "invalid");
  assert.equal((readRedirect(back({ state: "state-1", iss: "https://ws.example" }), expected) as { reason: string }).reason, "invalid");
  assert.equal((readRedirect("not a url", expected) as { reason: string }).reason, "invalid");
});

test("typed codes and device names", () => {
  assert.equal(cleanTypedCode("  ABCD-efgh - IJKM \n"), "abcd-efgh-ijkm");
  const ua = {
    chrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:144.0) Gecko/20100101 Firefox/144.0",
    safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
  };
  assert.equal(deviceNameFor(ua.chrome), "Chrome on Linux");
  assert.equal(deviceNameFor(ua.edge), "Edge on Windows");
  assert.equal(deviceNameFor(ua.firefox), "Firefox on macOS");
  assert.equal(deviceNameFor(ua.safari), "Safari on iOS");
  assert.equal(deviceNameFor(ua.firefoxAndroid), "Firefox on Android");
  assert.equal(deviceNameFor("curl/8"), "Browser");
});
