import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APNS_TOKEN, call, FCM_TOKEN, SCOPE, sha256, startHarness, type Harness } from "./testing.ts";

const EXPECTED_APNS = {
  aps: { alert: { title: "PURSS", body: "You have something new in your PURSS." }, "mutable-content": 1, sound: "default" },
};

async function register(h: Harness, platform: "fcm" | "apns", token: string, scope = SCOPE, headers: Record<string, string> = {}) {
  return call(h.base, "POST", "/v1/register", { body: { platform, token, scope }, headers });
}
const notify = (h: Harness, handle: string, headers: Record<string, string> = {}) => call(h.base, "POST", "/v1/notify", { body: { handle }, headers });

describe("delivery", () => {
  let h: Harness;
  before(async () => { h = await startHarness({ fcm: true, apns: true, sandbox: true }); });
  after(() => h.stop());

  test("FCM: register then notify delivers only the content-free message to the right token", async () => {
    const registered = await register(h, "fcm", FCM_TOKEN);
    assert.equal(registered.status, 200);
    assert.match(registered.json.handle, /^rh_[A-Za-z0-9_-]{43}$/);
    const woken = await notify(h, registered.json.handle);
    assert.equal(woken.status, 202);
    assert.deepEqual(woken.json, { ok: true });
    assert.deepEqual(h.fcm!.messages, [{
      message: { token: FCM_TOKEN, data: { purss: "1" }, android: { priority: "HIGH", ttl: "86400s", collapse_key: "purss" } },
    }]);
    assert.deepEqual(h.fcm!.problems, []);
  });

  test("APNs: register then notify posts the neutral alert with the expected headers", async () => {
    const registered = await register(h, "apns", APNS_TOKEN.toUpperCase());
    assert.equal(registered.status, 200);
    const before = Math.floor(h.clock.now / 1000);
    assert.equal((await notify(h, registered.json.handle)).status, 202);
    const [sent] = h.apns!.calls;
    assert.equal(h.apns!.calls.length, 1);
    assert.equal(sent!.path, `/3/device/${APNS_TOKEN}`);
    assert.deepEqual(JSON.parse(sent!.body), EXPECTED_APNS);
    assert.equal(sent!.body, JSON.stringify(EXPECTED_APNS));
    assert.equal(sent!.headers["apns-topic"], "app.purss");
    assert.equal(sent!.headers["apns-push-type"], "alert");
    assert.equal(sent!.headers["apns-priority"], "10");
    assert.equal(sent!.headers["apns-collapse-id"], undefined, "each alert stays; a later one never replaces an earlier one");
    assert.equal(Number(sent!.headers["apns-expiration"]), before + 86_400);
    assert.deepEqual(h.apns!.problems, []);
    assert.equal(h.sandbox!.calls.length, 0);
  });

  test("handles are deterministic per platform, token and scope and differ by scope", async () => {
    const a = await register(h, "fcm", FCM_TOKEN, SCOPE);
    const again = await register(h, "fcm", FCM_TOKEN, SCOPE);
    const other = await register(h, "fcm", FCM_TOKEN, "other_scope_AAAAAAAAAAAAAAAA");
    const apns = await register(h, "apns", APNS_TOKEN, SCOPE);
    assert.equal(a.json.handle, again.json.handle);
    assert.notEqual(a.json.handle, other.json.handle);
    assert.notEqual(a.json.handle, apns.json.handle);
  });

  test("the database and its files never contain a handle", async () => {
    const handles = [
      (await register(h, "fcm", FCM_TOKEN, SCOPE)).json.handle as string,
      (await register(h, "apns", APNS_TOKEN, SCOPE)).json.handle as string,
    ];
    const db = new DatabaseSync(path.join(h.dir, "relay.db"), { readOnly: true });
    const keys = db.prepare("SELECT key FROM devices").all().map((r) => String(r.key));
    db.close();
    for (const handle of handles) assert.ok(keys.includes(sha256(handle)));
    for (const file of readdirSync(h.dir).filter((f) => f.startsWith("relay.db"))) {
      const bytes = readFileSync(path.join(h.dir, file));
      for (const handle of handles) {
        assert.ok(!bytes.includes(handle), `${file} holds a handle`);
        assert.ok(!bytes.includes(handle.slice(3)), `${file} holds a handle body`);
      }
    }
  });

  test("unregister, also twice and for an unknown handle, answers 204 and notify then says gone", async () => {
    const { handle } = (await register(h, "fcm", FCM_TOKEN, "unregister_scope_AAAAAAAAAAAA")).json;
    assert.equal((await call(h.base, "POST", "/v1/unregister", { body: { handle } })).status, 204);
    assert.equal((await call(h.base, "POST", "/v1/unregister", { body: { handle } })).status, 204);
    assert.equal((await call(h.base, "POST", "/v1/unregister", { body: { handle: `rh_${"A".repeat(43)}` } })).status, 204);
    const gone = await notify(h, handle);
    assert.equal(gone.status, 404);
    assert.deepEqual(gone.json, { error: "gone" });
  });

  test("an unknown handle is gone", async () => {
    assert.equal((await notify(h, `rh_${"B".repeat(43)}`)).status, 404);
  });

  test("FCM UNREGISTERED removes the row and answers 404", async () => {
    const { handle } = (await register(h, "fcm", `${FCM_TOKEN}-dead`, "dead_fcm_scope_AAAAAAAAAAAAA")).json;
    h.fcm!.replies.push({ status: 400, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } });
    assert.equal((await notify(h, handle)).status, 404);
    assert.equal(h.store.get(sha256(handle)), undefined);
  });

  test("FCM 404 means gone; other 4xx and 5xx are transient and keep the row", async () => {
    const gone = (await register(h, "fcm", `${FCM_TOKEN}-404`, "scope_404_AAAAAAAAAAAAAAAAAAAA")).json.handle;
    h.fcm!.replies.push({ status: 404 });
    assert.equal((await notify(h, gone)).status, 404);
    const kept = (await register(h, "fcm", `${FCM_TOKEN}-kept`, "scope_kept_AAAAAAAAAAAAAAAAAAA")).json.handle;
    for (const status of [400, 429, 503]) {
      h.fcm!.replies.push({ status });
      const answer = await notify(h, kept);
      assert.equal(answer.status, 502, `status ${status}`);
      assert.deepEqual(answer.json, { error: "provider" });
    }
    assert.ok(h.store.get(sha256(kept)));
  });

  test("FCM 401 drops the cached access token and retries once", async () => {
    const { handle } = (await register(h, "fcm", `${FCM_TOKEN}-401`, "scope_401_AAAAAAAAAAAAAAAAAAAA")).json;
    assert.equal((await notify(h, handle)).status, 202);
    const tokens = h.fcm!.tokenRequests;
    const sent = h.fcm!.messages.length;
    h.fcm!.revokeTokens();
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal(h.fcm!.tokenRequests, tokens + 1);
    assert.equal(h.fcm!.messages.length, sent + 1);
  });

  test("the FCM access token is cached across sends", async () => {
    const { handle } = (await register(h, "fcm", `${FCM_TOKEN}-cache`, "scope_cache_AAAAAAAAAAAAAAAAAA")).json;
    const tokens = h.fcm!.tokenRequests;
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal(h.fcm!.tokenRequests, tokens);
  });

  test("APNs 410 removes the row and answers 404", async () => {
    const { handle } = (await register(h, "apns", "cd".repeat(32), "apns_gone_scope_AAAAAAAAAAAA")).json;
    h.apns!.reply = () => ({ status: 410, body: { reason: "Unregistered" } });
    assert.equal((await notify(h, handle)).status, 404);
    assert.equal(h.store.get(sha256(handle)), undefined);
    h.apns!.reply = () => ({ status: 200 });
  });

  test("APNs BadDeviceToken falls back to the sandbox once and remembers it", async () => {
    const token = "ef".repeat(32);
    const { handle } = (await register(h, "apns", token, "apns_sandbox_scope_AAAAAAAAAA")).json;
    assert.equal(h.store.get(sha256(handle))!.apnsEnv, "production");
    h.apns!.reply = () => ({ status: 400, body: { reason: "BadDeviceToken" } });
    const production = h.apns!.calls.length;
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal(h.apns!.calls.length, production + 1);
    assert.equal(h.sandbox!.calls.length, 1);
    assert.equal(h.sandbox!.calls[0]!.path, `/3/device/${token}`);
    assert.equal(h.store.get(sha256(handle))!.apnsEnv, "sandbox");
    assert.deepEqual(h.sandbox!.problems, []);
    // From now on only the sandbox is contacted.
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal(h.apns!.calls.length, production + 1);
    assert.equal(h.sandbox!.calls.length, 2);
    h.apns!.reply = () => ({ status: 200 });
  });

  test("APNs BadDeviceToken from both environments deletes the row", async () => {
    const { handle } = (await register(h, "apns", "12".repeat(32), "apns_bad_scope_AAAAAAAAAAAAA")).json;
    h.apns!.reply = () => ({ status: 400, body: { reason: "BadDeviceToken" } });
    const original = h.sandbox!.reply;
    h.sandbox!.reply = () => ({ status: 400, body: { reason: "BadDeviceToken" } });
    assert.equal((await notify(h, handle)).status, 404);
    assert.equal(h.store.get(sha256(handle)), undefined);
    h.apns!.reply = () => ({ status: 200 });
    h.sandbox!.reply = original;
  });

  test("APNs 5xx is transient and keeps the row; ExpiredProviderToken is retried with a new token", async () => {
    const { handle } = (await register(h, "apns", "34".repeat(32), "apns_5xx_scope_AAAAAAAAAAAAA")).json;
    h.apns!.reply = () => ({ status: 503, body: { reason: "ServiceUnavailable" } });
    assert.equal((await notify(h, handle)).status, 502);
    assert.ok(h.store.get(sha256(handle)));
    let expired = false;
    h.apns!.reply = () => {
      if (expired) return { status: 200 };
      expired = true;
      return { status: 403, body: { reason: "ExpiredProviderToken" } };
    };
    const calls = h.apns!.calls.length;
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal(h.apns!.calls.length, calls + 2);
    h.apns!.reply = () => ({ status: 200 });
  });

  test("a successful send refreshes seen_at", async () => {
    const { handle } = (await register(h, "fcm", `${FCM_TOKEN}-seen`, "scope_seen_AAAAAAAAAAAAAAAAAA")).json;
    h.clock.now += 5 * 86_400_000;
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal(h.store.get(sha256(handle))!.seenAt, h.clock.now);
  });
});

/** Runs `body` against a fresh relay so each limit starts full. */
async function withRelay(body: (h: Harness) => Promise<void>): Promise<void> {
  const h = await startHarness({ fcm: true });
  try {
    await body(h);
  } finally {
    await h.stop();
  }
}

describe("limits", () => {
  test("a handle allows a burst of five and refills one a minute", async () => withRelay(async (h) => {
    const { handle } = (await register(h, "fcm", FCM_TOKEN)).json;
    for (let i = 0; i < 5; i += 1) assert.equal((await notify(h, handle)).status, 202);
    const limited = await notify(h, handle);
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: "slow_down" });
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal(h.fcm!.messages.length, 5);
    h.clock.now += 61_000;
    assert.equal((await notify(h, handle)).status, 202);
    assert.equal((await notify(h, handle)).status, 429);
  }));

  test("a sending address is held to 600 a minute", async () => withRelay(async (h) => {
    const bad = `rh_${"C".repeat(43)}`;
    for (let i = 0; i < 600; i += 1) assert.equal((await notify(h, bad)).status, 404, `request ${i}`);
    const limited = await notify(h, bad);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "1");
    h.clock.now += 1000;
    assert.equal((await notify(h, bad)).status, 404);
  }));

  test("register allows 30 per 10 minutes per address", async () => withRelay(async (h) => {
    for (let i = 0; i < 30; i += 1) assert.equal((await register(h, "fcm", FCM_TOKEN, `limit_scope_${String(i).padStart(10, "0")}_AAAA`)).status, 200);
    const limited = await register(h, "fcm", FCM_TOKEN, "limit_scope_last_AAAAAAAAAAAA");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    h.clock.now += 600_000;
    assert.equal((await register(h, "fcm", FCM_TOKEN, "limit_scope_last_AAAAAAAAAAAA")).status, 200);
  }));

  test("a handle gets at most 200 wakes a day", async () => withRelay(async (h) => {
    const { handle } = (await register(h, "fcm", FCM_TOKEN)).json;
    // Five at once every five minutes, as fast as the per-minute limit allows, until the daily one stops it.
    const start = h.clock.now;
    let sent = 0;
    for (;;) {
      const answer = await notify(h, handle);
      if (answer.status === 429) {
        if (Number(answer.headers["retry-after"]) > 60) break;
        h.clock.now += 300_000;
        continue;
      }
      assert.equal(answer.status, 202);
      sent += 1;
    }
    assert.ok(sent >= 200 && sent < 250, `${sent} wakes before the daily limit`);
    assert.ok(h.clock.now - start < 86_400_000, "reached within the day");
  }));

  test("all registrations together are held to a budget, from any number of addresses", async () => {
    const h = await startHarness({ fcm: true, trustProxy: true });
    try {
      const reg = (i: number) => call(h.base, "POST", "/v1/register", { body: { platform: "fcm", token: FCM_TOKEN, scope: `budget_scope_${String(i).padStart(12, "0")}` }, headers: { "x-forwarded-for": `198.51.${i >> 8}.${i & 255}` } });
      for (let i = 0; i < 300; i += 1) assert.equal((await reg(i)).status, 200, `registration ${i}`);
      assert.equal((await reg(300)).status, 429);
      h.clock.now += 1000;
      assert.equal((await reg(301)).status, 200);
    } finally {
      await h.stop();
    }
  });

  test("unregister allows 60 per 10 minutes per address", async () => withRelay(async (h) => {
    const body = { handle: `rh_${"D".repeat(43)}` };
    for (let i = 0; i < 60; i += 1) assert.equal((await call(h.base, "POST", "/v1/unregister", { body })).status, 204);
    const limited = await call(h.base, "POST", "/v1/unregister", { body });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
  }));
});

describe("client address", () => {
  let h: Harness;
  let proxied: Harness;
  before(async () => { [h, proxied] = await Promise.all([startHarness({ fcm: true }), startHarness({ fcm: true, trustProxy: true })]); });
  after(async () => { await h.stop(); await proxied.stop(); });

  test("forwarding headers are ignored unless the proxy is trusted", async () => {
    for (let i = 0; i < 30; i += 1) await call(h.base, "POST", "/v1/unregister", { body: { handle: `rh_${"E".repeat(43)}` }, headers: { "x-forwarded-for": `10.1.1.${i}` } });
    for (let i = 0; i < 30; i += 1) await call(h.base, "POST", "/v1/unregister", { body: { handle: `rh_${"E".repeat(43)}` }, headers: { "x-forwarded-for": `10.1.2.${i}` } });
    const answer = await call(h.base, "POST", "/v1/unregister", { body: { handle: `rh_${"E".repeat(43)}` }, headers: { "x-forwarded-for": "10.9.9.9" } });
    assert.equal(answer.status, 429);
  });

  test("only the trusted proxy's own hop identifies the client: hops and X-Real-IP the client sends change nothing", async () => {
    const body = { handle: `rh_${"E".repeat(43)}` };
    for (let i = 0; i < 60; i += 1) await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5" } });
    assert.equal((await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.5" } })).status, 429);
    assert.equal((await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": "203.0.113.5", "x-real-ip": "203.0.113.7" } })).status, 429, "X-Real-IP is ignored");
    assert.equal((await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": "203.0.113.6" } })).status, 204);
  });

  test("IPv6 clients are limited by their /64", async () => {
    const body = { handle: `rh_${"F".repeat(43)}` };
    for (let i = 0; i < 60; i += 1) await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": `2001:db8:1:2::${(i + 1).toString(16)}` } });
    assert.equal((await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": "2001:db8:1:2:ffff:1:2:3" } })).status, 429);
    assert.equal((await call(proxied.base, "POST", "/v1/unregister", { body, headers: { "x-forwarded-for": "2001:db8:1:3::1" } })).status, 204);
  });
});

describe("strict input", () => {
  let h: Harness;
  before(async () => { h = await startHarness({ fcm: true }); });
  after(() => h.stop());
  const good = { platform: "fcm", token: FCM_TOKEN, scope: SCOPE };

  test("register rejects unknown keys, missing keys, wrong types and non-objects", async () => {
    for (const body of [
      { ...good, extra: "x" }, { platform: "fcm", token: FCM_TOKEN }, { ...good, scope: 5 }, { ...good, platform: ["fcm"] },
      { ...good, platform: "web" }, [], null, "text", 7,
    ]) {
      const answer = await call(h.base, "POST", "/v1/register", { body });
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.deepEqual(answer.json, { error: "invalid" });
    }
    assert.equal((await call(h.base, "POST", "/v1/register", { raw: "{not json" })).status, 400);
    assert.equal((await call(h.base, "POST", "/v1/register", { raw: "" })).status, 400);
  });

  test("register rejects bad token and scope formats", async () => {
    const bad = [
      { ...good, token: "short" }, { ...good, token: `${FCM_TOKEN} space` }, { ...good, token: "a".repeat(513) },
      { ...good, scope: "tooshort" }, { ...good, scope: `${SCOPE}!` }, { ...good, scope: "a".repeat(65) },
      { platform: "apns", token: "ab".repeat(31), scope: SCOPE }, { platform: "apns", token: "zz".repeat(32), scope: SCOPE },
      { platform: "apns", token: "ab".repeat(101), scope: SCOPE },
    ];
    for (const body of bad) assert.equal((await call(h.base, "POST", "/v1/register", { body })).status, 400, JSON.stringify(body));
    assert.equal((await call(h.base, "POST", "/v1/register", { body: { platform: "apns", token: "AB".repeat(32), scope: SCOPE } })).status, 200);
  });

  test("unregister and notify reject unknown keys, wrong types and malformed handles", async () => {
    const handle = `rh_${"A".repeat(43)}`;
    for (const path of ["/v1/unregister", "/v1/notify"]) {
      for (const body of [{ handle, extra: 1 }, { handle: 5 }, {}, { handle: "rh_short" }, { handle: `rh_${"A".repeat(44)}` }, { handle: `xx_${"A".repeat(43)}` }, { handle: `rh_${"A".repeat(42)}+` }, []]) {
        assert.equal((await call(h.base, "POST", path, { body })).status, 400, `${path} ${JSON.stringify(body)}`);
      }
    }
  });

  test("a body over 4096 bytes is answered 413", async () => {
    const big = JSON.stringify({ ...good, scope: "A".repeat(5000) });
    for (const path of ["/v1/register", "/v1/unregister", "/v1/notify"]) {
      assert.equal((await call(h.base, "POST", path, { raw: big })).status, 413);
    }
    const exact = JSON.stringify({ platform: "fcm", token: FCM_TOKEN, scope: SCOPE });
    assert.equal((await call(h.base, "POST", "/v1/register", { raw: exact })).status, 200);
  });

  test("only application/json is accepted, parameters allowed", async () => {
    const raw = JSON.stringify(good);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx", "text/json"]) {
      assert.equal((await call(h.base, "POST", "/v1/register", { raw, headers: { "content-type": type } })).status, 415, type);
    }
    const missing = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ default: http }) => {
        const req = http.request(h.base + "/v1/register", { method: "POST", agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", reject);
        req.end(raw);
      });
    });
    assert.equal(missing, 415);
    assert.equal((await call(h.base, "POST", "/v1/register", { raw, headers: { "content-type": "application/json; charset=utf-8" } })).status, 200);
  });

  test("unknown paths are 404 and wrong methods 405", async () => {
    assert.equal((await call(h.base, "POST", "/v1/other", { body: {} })).status, 404);
    assert.equal((await call(h.base, "GET", "/")).status, 404);
    for (const path of ["/v1/register", "/v1/unregister", "/v1/notify"]) {
      assert.equal((await call(h.base, "GET", path)).status, 405);
      assert.equal((await call(h.base, "PUT", path, { body: {} })).status, 405);
    }
    assert.equal((await call(h.base, "OPTIONS", "/v1/notify")).status, 405);
    assert.equal((await call(h.base, "POST", "/healthz", { body: {} })).status, 405);
  });
});

describe("CORS", () => {
  let h: Harness;
  before(async () => { h = await startHarness({ fcm: true }); });
  after(() => h.stop());
  const body = { platform: "fcm", token: FCM_TOKEN, scope: SCOPE };

  test("the three app origins are echoed on register and unregister; nothing else is", async () => {
    for (const origin of ["capacitor://localhost", "https://localhost", "http://localhost"]) {
      const answer = await call(h.base, "POST", "/v1/register", { body, headers: { origin } });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["access-control-allow-origin"], origin);
      assert.equal(answer.headers.vary, "Origin");
      assert.equal(answer.headers["access-control-allow-credentials"], undefined);
      const rejected = await call(h.base, "POST", "/v1/unregister", { body: { handle: "bad" }, headers: { origin } });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.headers["access-control-allow-origin"], origin);
    }
    for (const origin of ["https://evil.example", "http://localhost:3000", "https://localhost.evil.example", "null", "HTTP://LOCALHOST"]) {
      const answer = await call(h.base, "POST", "/v1/register", { body, headers: { origin } });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["access-control-allow-origin"], undefined, origin);
    }
    assert.equal((await call(h.base, "POST", "/v1/register", { body })).headers["access-control-allow-origin"], undefined);
  });

  test("preflight is answered for the app origins only", async () => {
    const ask = (origin: string) => call(h.base, "OPTIONS", "/v1/register", {
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    const allowed = await ask("capacitor://localhost");
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], "capacitor://localhost");
    assert.match(String(allowed.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(allowed.headers["access-control-allow-headers"]), /content-type/i);
    const denied = await ask("https://evil.example");
    assert.equal(denied.status, 204);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
    assert.equal(denied.headers["access-control-allow-methods"], undefined);
  });

  test("notify and healthz carry no CORS headers", async () => {
    const origin = "capacitor://localhost";
    const woken = await call(h.base, "POST", "/v1/notify", { body: { handle: `rh_${"A".repeat(43)}` }, headers: { origin } });
    assert.equal(woken.headers["access-control-allow-origin"], undefined);
    assert.equal((await call(h.base, "GET", "/healthz", { headers: { origin } })).headers["access-control-allow-origin"], undefined);
  });
});

describe("unconfigured platforms", () => {
  let h: Harness;
  before(async () => { h = await startHarness({ fcm: true }); });
  after(() => h.stop());

  test("notify answers 503 for a platform without credentials, healthz says which are set", async () => {
    const { handle } = (await register(h, "apns", APNS_TOKEN)).json;
    const answer = await notify(h, handle);
    assert.equal(answer.status, 503);
    assert.deepEqual(answer.json, { error: "unavailable" });
    assert.ok(h.store.get(sha256(handle)));
    assert.deepEqual((await call(h.base, "GET", "/healthz")).json, { ok: true, fcm: true, apns: false });
  });

  test("with no credentials at all the relay still registers and reports both unavailable", async () => {
    const bare = await startHarness();
    try {
      assert.deepEqual((await call(bare.base, "GET", "/healthz")).json, { ok: true, fcm: false, apns: false });
      const { handle } = (await register(bare, "fcm", FCM_TOKEN)).json;
      assert.equal((await notify(bare, handle)).status, 503);
    } finally {
      await bare.stop();
    }
  });
});

describe("privacy", () => {
  test("counts and logs never contain tokens, handles or scopes", async () => {
    const h = await startHarness({ fcm: true });
    try {
      const { handle } = (await register(h, "fcm", FCM_TOKEN)).json;
      h.fcm!.replies.push({ status: 400 });
      await notify(h, handle);
      const seen = JSON.stringify([h.counts, h.logs]);
      for (const secret of [FCM_TOKEN, handle, SCOPE, handle.slice(3)]) assert.ok(!seen.includes(secret));
      assert.ok(h.logs.length > 0);
    } finally {
      await h.stop();
    }
  });
});
