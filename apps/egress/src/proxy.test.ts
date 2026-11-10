import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { FixtureAdapter, fixtureEntry } from "./gateway/fixture-adapter.ts";
import type { LogEvent } from "./proxy.ts";
import { startEgress } from "./server.ts";
import { allowLoopback, connectVia, control, makeConfig, startEcho, startUpstream, viaProxy } from "./testing.ts";
import type { ConfigOverrides } from "./testing.ts";

async function withEgress<T>(
  fn: (egress: Awaited<ReturnType<typeof startEgress>>, logs: LogEvent[]) => Promise<T>,
  opts: { config?: ConfigOverrides; allow?: boolean; resolver?: (h: string) => Promise<string[]> } = {},
): Promise<T> {
  const logs: LogEvent[] = [];
  const egress = await startEgress(makeConfig(opts.config), {
    log: (e) => logs.push(e),
    testAllowAddress: opts.allow ? allowLoopback : undefined,
    resolver: opts.resolver,
  });
  try {
    return await fn(egress, logs);
  } finally {
    await egress.stop();
  }
}

const toLocal = async () => ["127.0.0.1"];

test("absolute-form requests are forwarded to a validated destination; hop-by-hop and compression headers are not", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml", "x-upstream": "yes", connection: "keep-alive", "keep-alive": "timeout=5" });
    res.end("<rss/>");
  });
  try {
    await withEgress(
      async (egress) => {
        const r = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/feed.xml?x=1`, {
          headers: { "accept-encoding": "gzip, br", "proxy-authorization": "Basic c2VjcmV0", "proxy-connection": "keep-alive", authorization: "Basic dTpw", "user-agent": "FreshRSS/1.30" },
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.toString(), "<rss/>");
        assert.equal(r.headers["x-upstream"], "yes");
        assert.equal(r.headers["keep-alive"], undefined);
        const seen = upstream.requests[0]!;
        assert.equal(seen.url, "/feed.xml?x=1");
        assert.equal(seen.headers.host, `feeds.test:${upstream.port}`);
        assert.equal(seen.headers["accept-encoding"], undefined, "compression is not negotiated so sizes can be capped exactly");
        assert.equal(seen.headers["proxy-authorization"], undefined);
        assert.equal(seen.headers["proxy-connection"], undefined);
        assert.equal(seen.headers.authorization, "Basic dTpw", "origin credentials pass through to the origin only");
        assert.equal(seen.headers["user-agent"], "FreshRSS/1.30");
        assert.deepEqual(egress.stats.snapshot(), { allowedLastHour: 1, blockedLastHour: 0 });
      },
      { allow: true, resolver: toLocal },
    );
  } finally {
    await upstream.close();
  }
});

test("destinations on private, loopback, link-local, metadata and reserved addresses are refused with 403 and counted", async () => {
  const upstream = await startUpstream((_req, res) => res.end("should never be reached"));
  const targets = [
    `http://127.0.0.1:${upstream.port}/`,
    `http://2130706433:${upstream.port}/`,
    `http://0x7f.1:${upstream.port}/`,
    `http://localhost:${upstream.port}/`,
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://10.0.0.5/",
    "http://192.168.1.1:8080/",
    "http://100.100.100.200/",
    "http://0.0.0.0/",
    "http://metadata.google.internal/",
    "http://freshrss/",
    "http://printer.local/",
    "http://example.com:25/",
    "http://example.com:6379/",
  ];
  try {
    await withEgress(async (egress, logs) => {
      for (const t of targets) {
        const r = await viaProxy(egress.ports.proxy, t);
        assert.equal(r.status, 403, `${t} -> ${r.status} ${r.body}`);
        assert.match(r.body.toString(), /Blocked by egress policy/, t);
      }
      assert.equal(egress.stats.snapshot().blockedLastHour, targets.length);
      assert.equal(egress.stats.snapshot().allowedLastHour, 0);
      assert.equal(upstream.requests.length, 0, "nothing reached the local server");
      assert.ok(logs.filter((l) => l.event === "proxy.deny").length >= targets.length);
    });
  } finally {
    await upstream.close();
  }
});

test("a name that resolves to a private address, or only partly to public ones, is refused", async () => {
  for (const answer of [["10.0.0.9"], ["127.0.0.1"], ["8.8.8.8", "169.254.169.254"], ["::1"], ["fd00::1"]]) {
    await withEgress(
      async (egress) => {
        const r = await viaProxy(egress.ports.proxy, "http://rebind.example/feed");
        assert.equal(r.status, 403, answer.join());
      },
      { resolver: async () => answer },
    );
  }
  await withEgress(
    async (egress) => {
      const r = await viaProxy(egress.ports.proxy, "http://nowhere.example/feed");
      assert.equal(r.status, 502);
      assert.equal(egress.stats.snapshot().blockedLastHour, 0, "an unresolvable name is an error, not a policy block");
    },
    {
      resolver: async () => {
        throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      },
    },
  );
});

test("redirects are not followed by the proxy; each hop the client follows is checked on its own", async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (req.url === "/to-local") {
      res.writeHead(301, { location: "http://127.0.0.1:1/secret" });
      return res.end();
    }
    res.end("ok");
  });
  try {
    await withEgress(
      async (egress) => {
        for (const path of ["/to-metadata", "/to-local"]) {
          const first = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}${path}`);
          assert.ok([301, 302].includes(first.status), "the redirect response is handed to the client untouched");
          const hop = await viaProxy(egress.ports.proxy, first.headers.location!);
          assert.equal(hop.status, 403, `${path}: the client's next request is refused`);
        }
        assert.equal(upstream.requests.length, 2, "the proxy itself never requested the redirect target");
      },
      { allow: true, resolver: toLocal },
    );
  } finally {
    await upstream.close();
  }
});

test("malformed or out-of-policy requests are rejected before any connection", async () => {
  const upstream = await startUpstream((_req, res) => res.end("x"));
  try {
    await withEgress(
      async (egress) => {
        const base = `http://feeds.test:${upstream.port}`;
        assert.equal((await viaProxy(egress.ports.proxy, `http://user:pw@feeds.test:${upstream.port}/`)).status, 400, "credentials in the address");
        assert.equal((await viaProxy(egress.ports.proxy, `${base}/`, { method: "POST" })).status, 405);
        assert.equal((await viaProxy(egress.ports.proxy, `${base}/`, { method: "DELETE" })).status, 405);
        assert.equal((await viaProxy(egress.ports.proxy, `${base}/`, { headers: { "content-length": "5" } })).status, 400, "body on GET");
        assert.equal((await viaProxy(egress.ports.proxy, "/just/a/path", { headers: { host: "x" } })).status, 404, "origin-form: nothing is served here");
        assert.equal((await viaProxy(egress.ports.proxy, "/status")).status, 404);
        assert.equal((await viaProxy(egress.ports.proxy, "https://feeds.test/")).status, 400, "https needs CONNECT");
        assert.equal(upstream.requests.length, 0);
      },
      { allow: true, resolver: toLocal },
    );
  } finally {
    await upstream.close();
  }
});

test("CONNECT tunnels to validated destinations carry bytes both ways; others are refused", async () => {
  const echo = await startEcho();
  try {
    await withEgress(
      async (egress) => {
        const ok = await connectVia(egress.ports.proxy, `tls.test:${echo.port}`);
        assert.equal(ok.status, 200);
        const reply = await new Promise<string>((resolve) => {
          ok.socket.once("data", (d) => resolve(d.toString()));
          ok.socket.write("hello through the tunnel");
        });
        assert.equal(reply, "hello through the tunnel");
        ok.socket.destroy();
        assert.equal(echo.connections, 1);
        assert.equal(egress.stats.snapshot().allowedLastHour, 1);
      },
      { allow: true, resolver: toLocal },
    );
    await withEgress(async (egress) => {
      for (const authority of [`127.0.0.1:${echo.port}`, "169.254.169.254:443", "[::1]:443", "10.1.2.3:443", "localhost:443", "intranet:443", "example.com:25", "example.com:22", "example.com:6379"]) {
        const r = await connectVia(egress.ports.proxy, authority);
        assert.equal(r.status, 403, authority);
        r.socket.destroy();
      }
      const bad = await connectVia(egress.ports.proxy, "no-port-here");
      assert.equal(bad.status, 400);
      bad.socket.destroy();
      assert.equal(echo.connections, 1, "no further connections reached the local server");
      assert.equal(egress.stats.snapshot().blockedLastHour, 10);
    });
  } finally {
    await echo.close();
  }
});

test("a tunnel is cut at the byte cap and an unreachable destination answers 502", async () => {
  const echo = await startEcho();
  try {
    await withEgress(
      async (egress) => {
        const t = await connectVia(egress.ports.proxy, `tls.test:${echo.port}`);
        assert.equal(t.status, 200);
        const closed = new Promise<void>((resolve) => t.socket.once("close", () => resolve()));
        t.socket.on("error", () => {});
        t.socket.write(Buffer.alloc(4096, 1));
        t.socket.write(Buffer.alloc(4096, 2));
        await closed;
        const refused = await startEcho();
        const dead = refused.port;
        await refused.close();
        const r = await connectVia(egress.ports.proxy, `tls.test:${dead}`);
        assert.equal(r.status, 502);
        r.socket.destroy();
      },
      { allow: true, resolver: toLocal, config: { limits: { maxTunnelBytes: 4096 + 1024 } } },
    );
  } finally {
    await echo.close();
  }
});

test("oversized responses are stopped by declared length and by streaming", async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === "/declared") return void res.end(Buffer.alloc(3 * 1024 * 1024, 97));
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write(Buffer.alloc(128 * 1024, 98)), 5);
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.end("small");
  });
  try {
    await withEgress(
      async (egress) => {
        const declared = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/declared`);
        assert.equal(declared.status, 502);
        const streamed = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/stream`);
        assert.ok(streamed.error || streamed.body.length <= 1024 * 1024 + 128 * 1024, "the stream is cut near the cap");
        assert.ok(streamed.body.length < 3 * 1024 * 1024);
        assert.equal((await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/small`)).body.toString(), "small");
      },
      { allow: true, resolver: toLocal, config: { limits: { maxResponseBytes: 1024 * 1024 } } },
    );
  } finally {
    await upstream.close();
  }
});

test("a slow but live upstream is not cut early, and a departing client stops the upstream transfer", async () => {
  let upstreamClosed = false;
  const upstream = await startUpstream((req, res) => {
    if (req.url === "/slow") return void setTimeout(() => res.end("late but fine"), 600);
    res.writeHead(200);
    const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024, 1)), 10);
    res.on("close", () => {
      clearInterval(timer);
      upstreamClosed = true;
    });
  });
  try {
    await withEgress(
      async (egress) => {
        const slow = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/slow`);
        assert.equal(slow.status, 200);
        assert.equal(slow.body.toString(), "late but fine");
        await new Promise<void>((resolve) => {
          const req = http.request({ host: "127.0.0.1", port: egress.ports.proxy, path: `http://feeds.test:${upstream.port}/endless`, headers: { host: `feeds.test:${upstream.port}` }, agent: false });
          req.on("response", (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          });
          req.on("error", () => {});
          req.end();
        });
        for (let i = 0; i < 100 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(upstreamClosed, true, "the upstream connection was closed when the client left");
      },
      { allow: true, resolver: toLocal, config: { limits: { connectTimeoutMs: 5000, idleTimeoutMs: 5000 } } },
    );
  } finally {
    await upstream.close();
  }
});

test("CONNECT accepts port 80 and bracketed IPv6 authorities syntactically; policy still applies", async () => {
  await withEgress(async (egress) => {
    for (const authority of ["example.com:80", "[2606:4700:4700::1111]:25", "[::1]:80", "UPPER.example.com:1"]) {
      const r = await connectVia(egress.ports.proxy, authority);
      assert.notEqual(r.status, 400, `${authority} is well-formed`);
      r.socket.destroy();
    }
    for (const bad of ["example.com", "example.com:0", "example.com:99999", "a b:80", ":80", "http://example.com:80"]) {
      const r = await connectVia(egress.ports.proxy, bad);
      assert.equal(r.status, 400, bad);
      r.socket.destroy();
    }
  });
});

test("silent and stalled upstreams are cut by the timeouts", async () => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === "/silent") return;
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("start");
  });
  try {
    await withEgress(
      async (egress) => {
        const started = Date.now();
        const silent = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/silent`);
        assert.equal(silent.status, 504);
        const stalled = await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/stalled`);
        assert.ok(stalled.error || stalled.body.toString() === "start", "the stalled body ends");
        assert.ok(Date.now() - started < 6000);
      },
      { allow: true, resolver: toLocal, config: { limits: { connectTimeoutMs: 300, idleTimeoutMs: 400 } } },
    );
  } finally {
    await upstream.close();
  }
});

test("logs carry host, port and a redacted path only: no query strings, credentials or tokens", async () => {
  const upstream = await startUpstream((_req, res) => res.end("ok"));
  try {
    await withEgress(
      async (egress, logs) => {
        await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/u/3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d/feed.xml?token=SUPERSECRET&x=1`, { headers: { authorization: "Basic U0VDUkVUUEFTUw==", cookie: "sid=COOKIESECRET" } });
        await viaProxy(egress.ports.proxy, "http://169.254.169.254/latest/meta-data/?key=DENIEDSECRET", { headers: { authorization: "Bearer BEARERSECRET" } });
        const text = JSON.stringify(logs);
        assert.ok(logs.length >= 2);
        assert.doesNotMatch(text, /SUPERSECRET|SECRETPASS|U0VDUkVUUEFTUw|COOKIESECRET|DENIEDSECRET|BEARERSECRET|3f9a1c7e5b2d4f8a9c0e1d2b3a4f5e6d|\?[^…]|x=1/);
        assert.match(text, /feeds\.test/);
      },
      { allow: true, resolver: toLocal },
    );
  } finally {
    await upstream.close();
  }
});

test("the control endpoint reports status and the hourly allowed/blocked counts; it needs the service token", async () => {
  const upstream = await startUpstream((_req, res) => res.end("ok"));
  try {
    await withEgress(
      async (egress) => {
        await viaProxy(egress.ports.proxy, `http://feeds.test:${upstream.port}/`);
        await viaProxy(egress.ports.proxy, "http://10.0.0.1/");
        await viaProxy(egress.ports.proxy, "http://127.0.0.1:1/");
        const ok = await control(egress.ports.control, "GET", "/status");
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.json, { status: "ok", blockedLastHour: 2, allowedLastHour: 1 });
        for (const token of [null, "wrong-token-wrong-token-wrong-token-wrong", "", "t"]) {
          const denied = await control(egress.ports.control, "GET", "/status", { token });
          assert.equal(denied.status, 401, String(token));
          assert.equal(denied.json.error.code, "unauthorized");
        }
        const rebinding = await control(egress.ports.control, "GET", "/status", { host: "attacker.example" });
        assert.equal(rebinding.status, 421, "browser DNS-rebinding requests are refused");
      },
      { allow: true, resolver: toLocal },
    );
  } finally {
    await upstream.close();
  }
});

test("hourly counters roll off after an hour", async () => {
  let clock = 1_000_000_000_000;
  const egress = await startEgress(makeConfig(), { now: () => clock });
  try {
    await viaProxy(egress.ports.proxy, "http://10.0.0.1/");
    assert.equal(egress.stats.snapshot().blockedLastHour, 1);
    clock += 59 * 60_000;
    assert.equal(egress.stats.snapshot().blockedLastHour, 1);
    clock += 2 * 60_000;
    assert.equal(egress.stats.snapshot().blockedLastHour, 0);
  } finally {
    await egress.stop();
  }
});

test("the gateway listener is an operator-fixed exception matched by exact name and port, and only for plain GET", async () => {
  const config = makeConfig();
  const adapter = new FixtureAdapter("fixture", [fixtureEntry(1), fixtureEntry(2)]);
  const egress = await startEgress(config, { adapters: [adapter] });
  try {
    const gw = egress.ports.gateway;
    config.internalDestinations.push({ host: "feed-gateway.internal", port: gw, connectHost: "127.0.0.1", connectPort: gw });
    egress.gateway.upsertFeed({ feedId: "feed-abcdefgh", adapter: "fixture", title: "Private" });
    const cred = egress.gateway.issueCredential("feed-abcdefgh");

    const unauth = await viaProxy(egress.ports.proxy, `http://feed-gateway.internal:${gw}/feeds/feed-abcdefgh`);
    assert.equal(unauth.status, 401, "reached the gateway listener (unauthenticated)");
    assert.match(String(unauth.headers["www-authenticate"]), /Basic/);
    const basic = `Basic ${Buffer.from(`${cred.username}:${cred.secret}`).toString("base64")}`;
    const feed = await viaProxy(egress.ports.proxy, `http://feed-gateway.internal:${gw}/feeds/feed-abcdefgh`, { headers: { authorization: basic } });
    assert.equal(feed.status, 200, "FreshRSS-style request: absolute-form GET through the proxy with Basic auth");
    assert.match(feed.body.toString(), /<guid isPermaLink="false">fixture-1<\/guid>/);

    assert.equal((await viaProxy(egress.ports.proxy, `http://feed-gateway.internal:${gw + 1}/feeds/feed-abcdefgh`)).status, 403, "same name on another port is not an exception");
    assert.equal((await viaProxy(egress.ports.proxy, `http://other.internal:${gw}/feeds/feed-abcdefgh`)).status, 403);
    assert.equal((await viaProxy(egress.ports.proxy, `http://127.0.0.1:${gw}/feeds/feed-abcdefgh`, { headers: { authorization: basic } })).status, 403, "the loopback address itself stays forbidden");
    assert.equal((await viaProxy(egress.ports.proxy, `http://feed-gateway.internal:${gw}/feeds/feed-abcdefgh`, { method: "POST" })).status, 405);
    const tunnel = await connectVia(egress.ports.proxy, `feed-gateway.internal:${gw}`);
    assert.equal(tunnel.status, 403, "no CONNECT tunnels to internal destinations");
    tunnel.socket.destroy();
  } finally {
    await egress.stop();
  }
});

test("the proxy refuses to run with a wildcard or public bind address", async () => {
  const { assertInternalBind, ConfigError } = await import("./config.ts");
  for (const host of ["0.0.0.0", "::", "8.8.8.8", "2606:4700:4700::1111", "example.com", ""]) {
    assert.throws(() => assertInternalBind(host, "x"), ConfigError, host);
  }
  for (const host of ["127.0.0.1", "::1", "10.89.0.1", "192.168.1.20", "172.20.0.1", "169.254.1.2"]) {
    assert.doesNotThrow(() => assertInternalBind(host, "x"), host);
  }
  assert.throws(() => assertInternalBind("10.0.0.1", "control", { loopbackOnly: true }), ConfigError);
});
