import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkspaceAddress } from "@purss/domain";
import { checkInfo, connectPageUrl, parseConnection, parsePending, pkce, providersOffered, providerStartUrl, readAppCode, readCallback, signinOffered, signupOffer } from "./connect.ts";

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

test("the app offers its own sign-up only where PURSS says it can, and an emailed link only where sign-up is open", () => {
  const checked = (v: unknown) => { const c = checkInfo(v); assert.ok(c.ok); return c.info; };
  assert.equal(signupOffer(checked(info)), null, "an older PURSS: sign up in the browser");
  const older = { endpoint: "https://ws.example/api/connect/signup", invitation: true, open: true, passwordMin: 10 };
  assert.equal(signupOffer(checked({ ...info, signup: older })), null, "an older PURSS with another kind of sign-up: sign up in the browser");
  const signup = { endpoint: "https://ws.example/api/connect/signup", start: null, passwordMin: 10 };
  assert.deepEqual(signupOffer(checked({ ...info, signup })), { start: null, passwordMin: 10 });
  assert.deepEqual(signupOffer(checked({ ...info, signup: { ...signup, start: "https://ws.example/api/signup/start" } })), { start: "https://ws.example/api/signup/start", passwordMin: 10 });
});

test("the app signs in itself only where PURSS offers a password", () => {
  const checked = (v: unknown) => { const c = checkInfo(v); assert.ok(c.ok); return c.info; };
  assert.equal(signinOffered(checked(info)), false, "an older PURSS: sign in through the browser");
  const signin = { endpoint: "https://ws.example/api/connect/signin", methods: ["password"], passwordReset: null };
  assert.equal(signinOffered(checked({ ...info, signin })), true);
  assert.equal(signinOffered(checked({ ...info, signin: { ...signin, methods: ["password", "passkey"] } })), true);
  assert.equal(signinOffered(checked({ ...info, signin: { ...signin, methods: ["passkey"] } })), false);
});

const google = { id: "google", label: "Google", start: "https://ws.example/api/auth/oidc/google/start" };

test("the external sign-ins a PURSS offers are read defensively; an older PURSS offers none", () => {
  const withProviders = { ...info, signin: { endpoint: "e", methods: ["password"], passkeyOptions: null, passwordReset: null, passwordResetConfirm: null, providers: [google, { id: 1 }, null] } };
  assert.deepEqual(providersOffered(withProviders as never), [google]);
  assert.deepEqual(providersOffered(info as never), []);
  assert.deepEqual(providersOffered({ ...info, signin: { providers: "nope" } } as never), []);
});

test("Continue with Google opens the provider's sign-in in the browser and returns to the approval page for this app", () => {
  const request = { challenge: "CH", state: "ST", deviceName: "Pixel 8" };
  // The Connect page is at /app/connect on a PURSS; the provider's start takes the path inside the app.
  const url = new URL(providerStartUrl(google.start, "https://ws.example/app/connect", request));
  assert.equal(`${url.origin}${url.pathname}`, google.start);
  const next = url.searchParams.get("next")!;
  assert.ok(next.startsWith("/connect?"), "an in-app path, not the /app prefix (the server adds it)");
  assert.deepEqual([...new URL(`https://ws.example${next}`).searchParams], [...new URL(connectPageUrl("https://ws.example/connect", request)).searchParams]);
  assert.equal(new URL(`https://ws.example${next}`).searchParams.get("code_challenge"), "CH");
  assert.equal(new URL(`https://ws.example${next}`).searchParams.get("redirect_uri"), "purss://connect");
  // A PURSS whose Connect page isn't under /app keeps its path.
  assert.ok(new URL(providerStartUrl(google.start, "https://ws.example/connect", request)).searchParams.get("next")!.startsWith("/connect?"));
});

test("the code for a provider the app is linking or confirming with is taken only from its own answer: its kind, its state, PURSS naming itself", () => {
  const expected = { state: "ST", issuer: "https://ws.example" };
  const iss = "iss=https%3A%2F%2Fws.example";
  assert.deepEqual(readAppCode(`purss://connect?link_code=LC&state=ST&${iss}`, "link", expected), { kind: "code", code: "LC" });
  assert.deepEqual(readAppCode(`purss://connect?confirm_code=CC&state=ST&${iss}`, "confirm", expected), { kind: "code", code: "CC" });
  // One kind's code is never taken for the other's, nor a connection's `code` for either.
  assert.deepEqual(readAppCode(`purss://connect?link_code=LC&state=ST&${iss}`, "confirm", expected), { kind: "ignored" });
  assert.deepEqual(readAppCode(`purss://connect?confirm_code=CC&state=ST&${iss}`, "link", expected), { kind: "ignored" });
  assert.deepEqual(readAppCode(`purss://connect?code=LC&state=ST&${iss}`, "link", expected), { kind: "ignored" });
  assert.deepEqual(readAppCode(`purss://connect?confirm_code=CC&state=OTHER&${iss}`, "confirm", expected), { kind: "ignored" }, "another request's state");
  assert.deepEqual(readAppCode("purss://connect?confirm_code=CC&state=ST&iss=https%3A%2F%2Fother.example", "confirm", expected), { kind: "ignored" }, "another PURSS");
  assert.deepEqual(readAppCode("purss://connect?confirm_code=CC&state=ST", "confirm", expected), { kind: "ignored" }, "PURSS didn't name itself");
  assert.deepEqual(readAppCode(`purss://open?confirm_code=CC&state=ST&${iss}`, "confirm", expected), { kind: "ignored" }, "another address");
  // And the first screen's reader doesn't take either for a connection's code.
  assert.notEqual(readCallback(`purss://connect?confirm_code=CC&state=ST&${iss}`, expected).kind, "code");
  assert.notEqual(readCallback(`purss://connect?link_code=LC&state=ST&${iss}`, expected).kind, "code");
});
