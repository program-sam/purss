import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceAddress } from "@purss/domain";
import { checkInfo, connectPageUrl, parseConnection, parsePending, pkce, readCallback, signinOffered, signupOffer } from "./connect.ts";

test("the app takes the same addresses as the extension: https, or plain http on this device or the local network, flagged as unencrypted", () => {
  assert.deepEqual(parseWorkspaceAddress(" workspace.example.org/inbox?x=1 "), { ok: true, origin: "https://workspace.example.org", unencrypted: false });
  assert.deepEqual(parseWorkspaceAddress("http://localhost:19990"), { ok: true, origin: "http://localhost:19990", unencrypted: false });
  assert.deepEqual(parseWorkspaceAddress("http://192.168.1.20:8940"), { ok: true, origin: "http://192.168.1.20:8940", unencrypted: true });
  for (const bad of ["", "http://workspace.example", "ftp://x.example", "https://me:pw@ws.example", "https://"]) assert.equal(parseWorkspaceAddress(bad).ok, false, bad);
  assert.deepEqual(parseConnection({ origin: "http://nas.local:8940", token: "purss_dev_x" }), { origin: "http://nas.local:8940", token: "purss_dev_x", passkeys: false });
  assert.equal(parseConnection({ origin: "https://ws.example", token: "purss_dev_x", passkeys: true })?.passkeys, true);
  assert.equal(parseConnection({ origin: "http://workspace.example", token: "purss_dev_x" }), null);
});

const info = { service: "purss", name: "PURSS", origin: "https://ws.example", hosted: false,
  connect: { page: "https://ws.example/connect", token: "https://ws.example/api/connect/token", codeChallengeMethods: ["S256"], clients: { mobile: { redirectUris: ["purss://connect"], typedCode: true }, extension: { redirectUris: [], typedCode: true } } },
  features: { urlLookup: true } };

test("only a PURSS that takes this app's return address and S256 counts", () => {
  assert.equal(checkInfo(info).ok, true);
  assert.equal(checkInfo({ hello: 1 }).ok, false);
  assert.equal(checkInfo(null).ok, false);
  assert.equal(checkInfo({ ...info, connect: { ...info.connect, codeChallengeMethods: ["plain"] } }).ok, false);
  assert.equal(checkInfo({ ...info, connect: { ...info.connect, clients: { mobile: { redirectUris: ["https://x"], typedCode: true } } } }).ok, false);
});

test("PKCE follows RFC 7636: the appendix B verifier gives its challenge", async () => {
  const octets = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
  const p = await pkce((n) => (n === 32 ? new Uint8Array(octets) : new Uint8Array(n).fill(7)));
  assert.equal(p.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.match(p.state, /^[A-Za-z0-9_-]{22}$/);
  const real = await pkce();
  assert.notEqual(real.verifier, (await pkce()).verifier);
  const url = new URL(connectPageUrl(info.connect.page, { challenge: p.challenge, state: p.state, deviceName: "Pixel 8" }));
  assert.deepEqual(Object.fromEntries(url.searchParams), { client: "mobile", redirect_uri: "purss://connect", state: p.state, code_challenge: p.challenge, code_challenge_method: "S256", device_name: "Pixel 8" });
});

test("only the answer to this app's own request counts", () => {
  const expected = { state: "s-123456789", issuer: "https://ws.example" };
  assert.deepEqual(readCallback("purss://connect?code=K&state=s-123456789&iss=https%3A%2F%2Fws.example", expected), { kind: "code", code: "K" });
  assert.equal(readCallback("purss://connect?code=K&state=s-123456789", expected).kind, "error", "PURSS must say it answered (iss), as for the extension");
  assert.deepEqual(readCallback("purss://connect?error=access_denied&state=s-123456789&iss=https%3A%2F%2Fws.example", expected), { kind: "declined" });
  assert.deepEqual(readCallback("purss://connect?code=K&state=other", expected), { kind: "ignored" }, "someone else's request");
  assert.deepEqual(readCallback("purss://connect?code=K&state=s-123456789", null), { kind: "ignored" }, "nothing was started");
  assert.deepEqual(readCallback("purss://share?code=K&state=s-123456789", expected), { kind: "ignored" });
  assert.deepEqual(readCallback("purss://connect/x?code=K&state=s-123456789", expected), { kind: "ignored" });
  assert.deepEqual(readCallback("purss://connect?code=K&state=s-123456789&iss=https%3A%2F%2Fws.example#frag", expected), { kind: "code", code: "K" });
  assert.equal(readCallback("purss://connect?code=K&state=s-123456789&iss=https%3A%2F%2Fevil.example", expected).kind, "error");
  assert.equal(readCallback("purss://connect?state=s-123456789&iss=https%3A%2F%2Fws.example", expected).kind, "error");
});

test("a waiting connection lasts ten minutes; the saved connection must be a device token for a valid origin", () => {
  const p = { origin: "https://ws.example", issuer: "https://ws.example", verifier: "v", state: "s", startedAt: 1000 };
  assert.deepEqual(parsePending(JSON.stringify(p), 1000 + 9 * 60_000), { ...p, passkeys: false });
  assert.equal(parsePending(JSON.stringify(p), 1000 + 11 * 60_000), null);
  assert.equal(parsePending("{", 0), null);
  assert.deepEqual(parseConnection({ origin: "https://ws.example", token: "purss_dev_abc" }), { origin: "https://ws.example", token: "purss_dev_abc", passkeys: false });
  assert.equal(parseConnection({ origin: "https://ws.example/path", token: "purss_dev_abc" }), null);
  assert.equal(parseConnection({ origin: "http://ws.example", token: "purss_dev_abc" }), null);
  assert.equal(parseConnection({ origin: "https://ws.example", token: "purss_pat_abc" }), null);
  assert.equal(parseConnection(null), null);
});

test("the app offers its own sign-up only where PURSS says it can, with open sign-up only when it's on", () => {
  const checked = (v: unknown) => { const c = checkInfo(v); assert.ok(c.ok); return c.info; };
  assert.equal(signupOffer(checked(info)), null, "an older PURSS: sign up in the browser");
  const signup = { endpoint: "https://ws.example/api/connect/signup", invitation: true, open: false, passwordMin: 10 };
  assert.deepEqual(signupOffer(checked({ ...info, signup })), { open: false, passwordMin: 10 });
  assert.deepEqual(signupOffer(checked({ ...info, signup: { ...signup, open: true } })), { open: true, passwordMin: 10 });
});

test("the app signs in itself only where PURSS offers both a password and a recovery code", () => {
  const checked = (v: unknown) => { const c = checkInfo(v); assert.ok(c.ok); return c.info; };
  assert.equal(signinOffered(checked(info)), false, "an older PURSS: sign in through the browser");
  const signin = { endpoint: "https://ws.example/api/connect/signin", methods: ["password", "recovery"], passwordReset: null };
  assert.equal(signinOffered(checked({ ...info, signin })), true);
  assert.equal(signinOffered(checked({ ...info, signin: { ...signin, methods: ["password"] } })), false);
});
