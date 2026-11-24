import assert from "node:assert/strict";
import { test } from "node:test";
import { connectRequestSchema } from "./api.ts";
import { randomToken, readConnectAnswer, readProviderCode, s256Challenge } from "./connect-protocol.ts";

// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("the challenge is S256 of the verifier, and the PURSS takes what is made", async () => {
  assert.equal(await s256Challenge(VERIFIER), CHALLENGE);
  const verifier = randomToken(32);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/, "what the PURSS accepts of a verifier (RFC 7636 section 4.1)");
  const request = { client: "mobile", code_challenge: await s256Challenge(verifier), code_challenge_method: "S256", state: randomToken(16), redirect_uri: "purss://connect" };
  assert.equal(connectRequestSchema.safeParse(request).success, true, "and of a challenge and a state");
});

test("tokens are fresh, in base64url without padding, and made from the random bytes given", () => {
  assert.notEqual(randomToken(32), randomToken(32));
  assert.match(randomToken(16), /^[A-Za-z0-9_-]{22}$/);
  assert.equal(randomToken(3, () => new Uint8Array([0xfb, 0xff, 0xbf])), "-_-_", "the URL-safe alphabet, not + and /");
  assert.equal(randomToken(4, (n) => new Uint8Array(n).fill(255)), "_____w", "no = padding");
  const asked: number[] = [];
  randomToken(32, (n) => { asked.push(n); return new Uint8Array(n); });
  assert.deepEqual(asked, [32]);
});

const expected = { state: "state-123456789", issuer: "https://ws.example" };
const answer = (q: Record<string, string>) => new URLSearchParams(q);

test("an answer is taken only when it is this attempt's and this PURSS's, and then it says what the person did", () => {
  const mine = { state: expected.state, iss: expected.issuer };
  assert.deepEqual(readConnectAnswer(answer({ ...mine, code: "K" }), expected), { kind: "code", code: "K" });
  assert.deepEqual(readConnectAnswer(answer({ ...mine, error: "access_denied" }), expected), { kind: "declined" });
  assert.deepEqual(readConnectAnswer(answer({ ...mine, error: "access_denied", code: "K" }), expected), { kind: "declined" }, "a refusal wins");
  assert.deepEqual(readConnectAnswer(answer({ ...mine, error: "server_error" }), expected), { kind: "no-code" });
  assert.deepEqual(readConnectAnswer(answer(mine), expected), { kind: "no-code" });
  assert.deepEqual(readConnectAnswer(answer({ ...mine, code: "" }), expected), { kind: "no-code" });

  assert.deepEqual(readConnectAnswer(answer({ ...mine, state: "other", code: "K" }), expected), { kind: "other-attempt" });
  assert.deepEqual(readConnectAnswer(answer({ iss: expected.issuer, code: "K" }), expected), { kind: "other-attempt" }, "no state");
  assert.deepEqual(readConnectAnswer(answer({ ...mine, iss: "https://evil.example", code: "K" }), expected), { kind: "other-purss" });
  assert.deepEqual(readConnectAnswer(answer({ state: expected.state, code: "K" }), expected), { kind: "other-purss" }, "no issuer");
  assert.deepEqual(readConnectAnswer(answer({ ...mine, iss: `${expected.issuer}/`, code: "K" }), expected), { kind: "other-purss" }, "the origin, spelled exactly");
  assert.deepEqual(readConnectAnswer(answer({ ...mine, iss: "HTTPS://WS.EXAMPLE", code: "K" }), expected), { kind: "other-purss" });
  // Nothing of a refusal or a code from another attempt or PURSS is said: whose it is comes first.
  assert.deepEqual(readConnectAnswer(answer({ state: "other", iss: "https://evil.example", error: "access_denied" }), expected), { kind: "other-attempt" });
  assert.deepEqual(readConnectAnswer(answer({ ...mine, iss: "https://evil.example", error: "access_denied" }), expected), { kind: "other-purss" });
  // The first value of a repeated name is the one read.
  assert.deepEqual(readConnectAnswer(new URLSearchParams(`state=other&state=${expected.state}&iss=${encodeURIComponent(expected.issuer)}&code=K`), expected), { kind: "other-attempt" });
});

test("the code of a provider link or confirmation is taken only by its own name, from this attempt and this PURSS", () => {
  const mine = { state: expected.state, iss: expected.issuer };
  assert.equal(readProviderCode(answer({ ...mine, link_code: "LC" }), expected, "link_code"), "LC");
  assert.equal(readProviderCode(answer({ ...mine, confirm_code: "CC" }), expected, "confirm_code"), "CC");
  assert.equal(readProviderCode(answer({ ...mine, link_code: "LC" }), expected, "confirm_code"), null, "one kind's code is not the other's");
  assert.equal(readProviderCode(answer({ ...mine, code: "K" }), expected, "link_code"), null, "nor a connection's");
  assert.equal(readProviderCode(answer({ ...mine, link_code: "" }), expected, "link_code"), null);
  assert.equal(readProviderCode(answer({ ...mine, state: "other", link_code: "LC" }), expected, "link_code"), null);
  assert.equal(readProviderCode(answer({ ...mine, iss: "https://evil.example", link_code: "LC" }), expected, "link_code"), null);
  assert.equal(readProviderCode(answer({ state: expected.state, link_code: "LC" }), expected, "link_code"), null);
});
