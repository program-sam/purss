import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliCompressSync, constants, deflateSync, gzipSync } from "node:zlib";
import { boundLookup, resolveDestination, safeFetch, USER_AGENT } from "./safe-fetch.ts";
import type { Resolver } from "./safe-fetch.ts";
import { allowLoopback, send, startServer } from "./testing.ts";

const neverResolve: Resolver = async () => {
  throw new Error("DNS must not be consulted for this input");
};

test("literal and spelled-out private addresses are blocked without any DNS or network use", async () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://2130706433/", // decimal spelling of 127.0.0.1
    "http://0177.0.0.1/", // octal
    "http://0x7f.0.0.1/", // hex
    "http://127.1/", // short form
    "http://017700000001/",
    "http://0/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1:8080/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/",
    "http://168.63.129.16/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://[64:ff9b::7f00:1]/",
    "http://[fe80::1]/",
    "http://[fd00:ec2::254]/",
    "http://[2002:7f00:1::]/",
    "http://localhost/",
    "http://localhost:8946/",
    "http://LOCALHOST./",
    "http://foo.localhost/",
    "http://router.local/",
    "http://metadata.google.internal/",
    "http://freshrss/",
    "http://intranet:8080/",
  ];
  for (const url of blocked) {
    const result = await safeFetch(url, { resolver: neverResolve, timeoutMs: 3000 });
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.reason, "blocked", `${url}: ${result.reason} ${result.detail}`);
  }
});

test("non-web schemes, credentials and service ports are refused", async () => {
  for (const url of ["ftp://example.com/feed", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)", "data:text/plain,hi", "not a url", ""]) {
    const result = await safeFetch(url, { resolver: neverResolve });
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.reason, "invalid", url);
  }
  for (const url of ["http://user:pass@example.com/", "https://token@example.com/feed"]) {
    const result = await safeFetch(url, { resolver: neverResolve });
    assert.equal(result.ok, false, url);
    if (!result.ok) {
      assert.equal(result.reason, "invalid", url);
      assert.match(result.message, /username or password/);
    }
  }
  for (const url of ["http://example.com:22/", "https://example.com:6379/", "http://example.com:25/"]) {
    const result = await safeFetch(url, { resolver: neverResolve });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "blocked", url);
  }
});

test("a name that resolves to a private address is blocked, and a mixed answer rejects the whole name", async () => {
  for (const answer of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["::ffff:10.0.0.1"], ["8.8.8.8", "127.0.0.1"], ["2606:4700:4700::1111", "fd00::1"]]) {
    const result = await safeFetch("http://feeds.example/rss", { resolver: async () => answer });
    assert.equal(result.ok, false, answer.join());
    if (!result.ok) assert.equal(result.reason, "blocked", answer.join());
  }
});

test("unresolvable and empty DNS answers are 'unreachable'", async () => {
  const gone = await safeFetch("http://nope.example/rss", {
    resolver: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    },
  });
  assert.ok(!gone.ok && gone.reason === "unreachable");
  const empty = await safeFetch("http://nope.example/rss", { resolver: async () => [] });
  assert.ok(!empty.ok && empty.reason === "unreachable");
});

test("DNS that hangs hits the resolve timeout", async () => {
  const result = await safeFetch("http://slow.example/", { resolver: () => new Promise(() => {}), phaseTimeoutsMs: { resolveMs: 100 } });
  assert.ok(!result.ok);
  assert.equal(result.reason, "timeout");
});

test("the connection is bound to the validated address: a rebinding resolver is consulted once", async () => {
  const server = await startServer((_req, res) => send(res, 200, "text/plain", "ok"));
  let calls = 0;
  const resolver: Resolver = async () => {
    calls++;
    return calls === 1 ? ["127.0.0.1"] : ["10.0.0.1"]; // the second answer would be the attack
  };
  try {
    const result = await safeFetch(`http://rebind.example:${server.port}/`, { resolver, testAllowAddress: allowLoopback });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.response.body.toString(), "ok");
    assert.equal(result.response.remoteAddress, "127.0.0.1");
    assert.equal(calls, 1);
    assert.equal(server.requests[0]?.headers.host, `rebind.example:${server.port}`);
  } finally {
    await server.close();
  }
});

test("a mixed loopback answer is rejected even when one address is allowed for tests", async () => {
  const server = await startServer((_req, res) => send(res, 200, "text/plain", "ok"));
  try {
    const result = await safeFetch(`http://rebind.example:${server.port}/`, { resolver: async () => ["127.0.0.1", "127.0.0.2"], testAllowAddress: allowLoopback });
    assert.ok(!result.ok);
    assert.equal(result.reason, "blocked");
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("boundLookup only ever answers with the validated addresses", () => {
  const lookup = boundLookup([
    { address: "203.0.113.9", family: 4 },
    { address: "2606:4700::1", family: 6 },
  ]) as unknown as (host: string, options: object, cb: (...args: unknown[]) => void) => void;
  let all: unknown;
  lookup("anything.example", { all: true }, (_e, list) => (all = list));
  assert.deepEqual(all, [
    { address: "203.0.113.9", family: 4 },
    { address: "2606:4700::1", family: 6 },
  ]);
  let single: unknown[] = [];
  lookup("evil.example", { family: 6 }, (...args) => (single = args));
  assert.deepEqual(single, [null, "2606:4700::1", 6]);
  let err: unknown;
  lookup("x.example", { family: 4, all: false }, (e) => (err = e));
  assert.equal(err, null);
});

test("redirects are followed manually and each hop is re-validated: redirect to loopback, metadata and local names", async () => {
  for (const target of ["http://127.0.0.2:1234/secret", "http://169.254.169.254/latest/meta-data/", "http://[::1]:8080/", "http://localhost:9999/x", "http://10.0.0.1/", "ftp://example.com/x", "file:///etc/passwd"]) {
    const server = await startServer((_req, res) => send(res, 302, "text/plain", "", { location: target }));
    try {
      const result = await safeFetch(server.url, { testAllowAddress: allowLoopback });
      assert.ok(!result.ok, target);
      assert.equal(result.reason, "blocked", `${target}: ${result.detail}`);
    } finally {
      await server.close();
    }
  }
});

test("a redirect that points at a name resolving to loopback is blocked after resolution", async () => {
  const server = await startServer((_req, res) => send(res, 301, "text/plain", "", { location: "http://later.example/feed" }));
  try {
    const result = await safeFetch(server.url, { testAllowAddress: allowLoopback, resolver: async () => ["127.0.0.2"] });
    assert.ok(!result.ok);
    assert.equal(result.reason, "blocked");
  } finally {
    await server.close();
  }
});

test("redirect chains: up to five hops work, six fail, loops fail, relative locations resolve", async () => {
  const server = await startServer((req, res) => {
    const m = /^\/hop(\d+)$/.exec(req.url ?? "");
    if (m) {
      const n = Number(m[1]);
      if (n >= Number(req.headers["x-stop-at"] ?? 99)) return send(res, 200, "text/plain", `done at ${n}`);
      return send(res, 302, "text/plain", "", { location: `/hop${n + 1}` });
    }
    if (req.url === "/loop") return send(res, 302, "text/plain", "", { location: "/loop" });
    send(res, 404, "text/plain", "nope");
  });
  try {
    const five = await safeFetch(`${server.url}/hop0`, { testAllowAddress: allowLoopback, headers: { "x-stop-at": "5" } });
    assert.ok(five.ok);
    assert.equal(five.response.body.toString(), "done at 5");
    assert.equal(five.response.redirects.length, 5);
    assert.ok(five.response.url.endsWith("/hop5"));
    const six = await safeFetch(`${server.url}/hop0`, { testAllowAddress: allowLoopback, headers: { "x-stop-at": "6" } });
    assert.ok(!six.ok);
    assert.equal(six.reason, "invalid");
    const loop = await safeFetch(`${server.url}/loop`, { testAllowAddress: allowLoopback });
    assert.ok(!loop.ok);
    assert.equal(loop.reason, "invalid");
  } finally {
    await server.close();
  }
});

test("credential headers go to the first hop only and a User-Agent without personal data is sent", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/start") return send(res, 302, "text/plain", "", { location: "/final" });
    send(res, 200, "text/plain", "x");
  });
  try {
    const result = await safeFetch(`${server.url}/start`, {
      testAllowAddress: allowLoopback,
      headers: { authorization: "Bearer topsecret", cookie: "session=abc", "x-custom": "kept" },
    });
    assert.ok(result.ok);
    const [first, second] = server.requests;
    assert.equal(first?.headers.authorization, "Bearer topsecret");
    assert.equal(second?.headers.authorization, undefined);
    assert.equal(second?.headers.cookie, undefined);
    assert.equal(second?.headers["x-custom"], "kept");
    assert.equal(second?.headers["user-agent"], USER_AGENT);
    assert.doesNotMatch(USER_AGENT, /sam|@|home|\/home/i);
    assert.equal(second?.headers.referer, undefined);
  } finally {
    await server.close();
  }
});

test("a POST sends its body under the same rules and never follows a redirect", async () => {
  const bodies: string[] = [];
  const server = await startServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => { data += c.toString(); });
    req.on("end", () => {
      bodies.push(`${req.method} ${req.headers["content-type"]} ${data}`);
      if (req.url === "/moved") return send(res, 307, "text/plain", "", { location: "/final" });
      send(res, 202, "application/json", "{\"ok\":true}");
    });
  });
  try {
    const ok = await safeFetch(`${server.url}/notify`, { testAllowAddress: allowLoopback, post: { body: "{\"handle\":\"x\"}", contentType: "application/json" } });
    assert.ok(ok.ok);
    assert.equal(ok.response.status, 202);
    assert.deepEqual(bodies, ['POST application/json {"handle":"x"}']);
    const moved = await safeFetch(`${server.url}/moved`, { testAllowAddress: allowLoopback, post: { body: "{}", contentType: "application/json" } });
    assert.equal(moved.ok, false);
    if (!moved.ok) assert.equal(moved.reason, "invalid");
    assert.equal(server.requests.length, 2, "the redirect target was never asked");
    const blocked = await safeFetch("http://127.0.0.1:9/notify", { post: { body: "{}", contentType: "application/json" } });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "blocked");
  } finally {
    await server.close();
  }
});

test("HTTP error statuses are returned as responses, not failures", async () => {
  const server = await startServer((_req, res) => send(res, 404, "text/html", "<p>gone</p>"));
  try {
    const result = await safeFetch(server.url, { testAllowAddress: allowLoopback });
    assert.ok(result.ok);
    assert.equal(result.response.status, 404);
    assert.equal(result.response.mediaType, "text/html");
  } finally {
    await server.close();
  }
});

test("oversize bodies are cut off: declared length, chunked and compressed", async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 97);
  const server = await startServer((req, res) => {
    if (req.url === "/declared") return send(res, 200, "text/plain", big);
    if (req.url === "/chunked") {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write(Buffer.alloc(256 * 1024, 98)), 5);
      res.on("close", () => clearInterval(timer));
      return;
    }
    send(res, 200, "text/plain", "small");
  });
  try {
    const declared = await safeFetch(`${server.url}/declared`, { testAllowAddress: allowLoopback, maxBytes: 1024 * 1024 });
    assert.ok(!declared.ok);
    assert.equal(declared.reason, "toolarge");
    const chunked = await safeFetch(`${server.url}/chunked`, { testAllowAddress: allowLoopback, maxBytes: 1024 * 1024 });
    assert.ok(!chunked.ok);
    assert.equal(chunked.reason, "toolarge");
    const fine = await safeFetch(`${server.url}/small`, { testAllowAddress: allowLoopback, maxBytes: 1024 * 1024 });
    assert.ok(fine.ok);
  } finally {
    await server.close();
  }
});

test("allowPartial returns the start of an oversized body, flagged, for previews", async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 97);
  const server = await startServer((req, res) => {
    if (req.url === "/gz") return send(res, 200, "text/plain", gzipSync(big), { "content-encoding": "gzip" });
    send(res, 200, "text/plain", big);
  });
  try {
    for (const path of ["/plain", "/gz"]) {
      const r = await safeFetch(`${server.url}${path}`, { testAllowAddress: allowLoopback, maxBytes: 100_000, allowPartial: true });
      assert.ok(r.ok, path);
      assert.equal(r.response.truncated, true);
      assert.equal(r.response.body.length, 100_000);
      assert.equal(r.response.body[0], 97);
    }
    const small = await safeFetch(`${server.url}/small-ok`, { testAllowAddress: allowLoopback, maxBytes: 10 * 1024 * 1024, allowPartial: true });
    assert.ok(small.ok);
    assert.equal(small.response.truncated, false);
    assert.equal(small.response.bytes, big.length);
    const strict = await safeFetch(`${server.url}/plain`, { testAllowAddress: allowLoopback, maxBytes: 100_000 });
    assert.ok(!strict.ok && strict.reason === "toolarge", "without the option oversize is still a failure");
  } finally {
    await server.close();
  }
});

test("decompression bombs are stopped by the decoded-size cap, quickly", async () => {
  const zeros = Buffer.alloc(48 * 1024 * 1024);
  const gz = gzipSync(zeros, { level: 9 });
  const df = deflateSync(zeros, { level: 9 });
  const br = brotliCompressSync(zeros, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  assert.ok(gz.length < 1024 * 1024, "fixture should be small on the wire");
  const server = await startServer((req, res) => {
    const enc = req.url === "/gz" ? "gzip" : req.url === "/df" ? "deflate" : "br";
    const body = enc === "gzip" ? gz : enc === "deflate" ? df : br;
    send(res, 200, "text/html", body, { "content-encoding": enc });
  });
  try {
    for (const path of ["/gz", "/df", "/br"]) {
      const started = Date.now();
      const result = await safeFetch(`${server.url}${path}`, { testAllowAddress: allowLoopback, maxBytes: 1024 * 1024 });
      assert.ok(!result.ok, path);
      assert.equal(result.reason, "toolarge", `${path}: ${result.detail}`);
      assert.ok(Date.now() - started < 3000, `${path} took ${Date.now() - started}ms`);
    }
  } finally {
    await server.close();
  }
});

test("compressed responses are decoded; corrupt and unknown encodings are refused", async () => {
  const text = "<rss>".padEnd(50_000, "x");
  const server = await startServer((req, res) => {
    if (req.url === "/gz") return send(res, 200, "application/xml", gzipSync(text), { "content-encoding": "gzip" });
    if (req.url === "/br") return send(res, 200, "application/xml", brotliCompressSync(text), { "content-encoding": "br" });
    if (req.url === "/chain") return send(res, 200, "application/xml", gzipSync(deflateSync(text)), { "content-encoding": "deflate, gzip" });
    if (req.url === "/corrupt") return send(res, 200, "application/xml", Buffer.from("this is not gzip data at all"), { "content-encoding": "gzip" });
    if (req.url === "/truncated") return send(res, 200, "application/xml", gzipSync(text).subarray(0, 40), { "content-encoding": "gzip" });
    send(res, 200, "application/xml", "plain", { "content-encoding": "compress" });
  });
  try {
    for (const path of ["/gz", "/br", "/chain"]) {
      const r = await safeFetch(`${server.url}${path}`, { testAllowAddress: allowLoopback });
      assert.ok(r.ok, path);
      assert.equal(r.response.body.toString(), text, path);
    }
    for (const path of ["/corrupt", "/truncated", "/unknown"]) {
      const r = await safeFetch(`${server.url}${path}`, { testAllowAddress: allowLoopback });
      assert.ok(!r.ok, path);
      assert.equal(r.reason, "invalid", `${path}: ${r.detail}`);
    }
  } finally {
    await server.close();
  }
});

test("timeouts: no response, stalled body and an overall deadline", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/silent") return; // never answers
    if (req.url === "/stall") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("start");
      return;
    }
    if (req.url === "/drip") {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("."), 40);
      res.on("close", () => clearInterval(timer));
    }
  });
  try {
    const silent = await safeFetch(`${server.url}/silent`, { testAllowAddress: allowLoopback, phaseTimeoutsMs: { firstByteMs: 150 } });
    assert.ok(!silent.ok);
    assert.equal(silent.reason, "timeout");
    const stall = await safeFetch(`${server.url}/stall`, { testAllowAddress: allowLoopback, phaseTimeoutsMs: { idleMs: 150 } });
    assert.ok(!stall.ok);
    assert.equal(stall.reason, "timeout");
    const drip = await safeFetch(`${server.url}/drip`, { testAllowAddress: allowLoopback, timeoutMs: 400, phaseTimeoutsMs: { idleMs: 5000 } });
    assert.ok(!drip.ok);
    assert.equal(drip.reason, "timeout");
  } finally {
    await server.close();
  }
});

test("an AbortSignal cancels before and during a request", async () => {
  const server = await startServer(() => {});
  try {
    const already = AbortSignal.abort();
    const a = await safeFetch(server.url, { testAllowAddress: allowLoopback, signal: already });
    assert.ok(!a.ok);
    assert.equal(a.reason, "aborted");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const b = await safeFetch(server.url, { testAllowAddress: allowLoopback, signal: controller.signal, timeoutMs: 5000 });
    assert.ok(!b.ok);
    assert.equal(b.reason, "aborted");
    assert.ok(Date.now() - started < 2000);
  } finally {
    await server.close();
  }
});

test("refused connections are 'unreachable'", async () => {
  const server = await startServer(() => {});
  const url = server.url;
  await server.close();
  const result = await safeFetch(url, { testAllowAddress: allowLoopback });
  assert.ok(!result.ok);
  assert.equal(result.reason, "unreachable");
});

test("failure details never include the query string or credentials of the URL", async () => {
  const result = await safeFetch("http://10.0.0.1/feed/aaaabbbbccccddddeeeeffff1111?token=SECRETVALUE123");
  assert.ok(!result.ok);
  assert.doesNotMatch(result.detail + result.message, /SECRETVALUE123|aaaabbbbcccc/);
});

test("IPv6 literal hosts work when allowed for tests (brackets are handled)", async (t) => {
  const net = await import("node:net");
  const http = await import("node:http");
  const server = http.createServer((_req, res) => send(res, 200, "text/plain", "v6 ok"));
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "::1", () => resolve(true));
  });
  if (!listening) {
    t.skip("IPv6 loopback is not available on this host");
    return;
  }
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const refused = await safeFetch(`http://[::1]:${port}/`);
    assert.ok(!refused.ok && refused.reason === "blocked");
    const allowed = await safeFetch(`http://[::1]:${port}/`, { testAllowAddress: (ip) => ip === "::1" });
    assert.ok(allowed.ok, JSON.stringify(allowed));
    assert.equal(allowed.response.body.toString(), "v6 ok");
    assert.equal(net.isIP(allowed.response.remoteAddress ?? ""), 6);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("resolveDestination returns only validated addresses for names and literals", async () => {
  const good = await resolveDestination("feeds.example", { resolver: async () => ["93.184.216.34", "2606:2800:220:1::1"] });
  assert.ok(good.ok);
  assert.equal(good.addresses.length, 2);
  const literal = await resolveDestination("[2606:4700:4700::1111]");
  assert.ok(literal.ok);
  const bad = await resolveDestination("feeds.example", { resolver: async () => ["93.184.216.34", "192.168.0.9"] });
  assert.ok(!bad.ok);
  assert.equal(bad.reason, "blocked");
});

test("HTTPS certificates are verified; a trusted local CA works for tests only through the in-process option", async (t) => {
  let openssl = true;
  const dir = mkdtempSync(join(tmpdir(), "purss-tls-"));
  try {
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:tls.example,IP:127.0.0.1"], { stdio: "ignore" });
    } catch {
      openssl = false;
    }
    if (!openssl) {
      t.skip("openssl is not available on this host");
      return;
    }
    const key = readFileSync(join(dir, "k.pem"));
    const cert = readFileSync(join(dir, "c.pem"));
    const server = https.createServer({ key, cert }, (_req, res) => send(res, 200, "text/plain", "secure"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      const untrusted = await safeFetch(`https://tls.example:${port}/`, { resolver: async () => ["127.0.0.1"], testAllowAddress: allowLoopback });
      assert.ok(!untrusted.ok);
      assert.equal(untrusted.reason, "unreachable");
      assert.match(untrusted.message, /certificate/i);
      const trusted = await safeFetch(`https://tls.example:${port}/`, { resolver: async () => ["127.0.0.1"], testAllowAddress: allowLoopback, testTlsCa: cert });
      assert.ok(trusted.ok, JSON.stringify(trusted));
      assert.equal(trusted.response.body.toString(), "secure");
      const wrongName = await safeFetch(`https://other.example:${port}/`, { resolver: async () => ["127.0.0.1"], testAllowAddress: allowLoopback, testTlsCa: cert });
      assert.ok(!wrongName.ok, "a certificate for another name must be rejected");
    } finally {
      server.close();
      server.closeAllConnections();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing in the environment can switch the address checks off", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { PURSS_ALLOW_PRIVATE: "1", PURSS_TEST_ALLOW_ADDRESS: "1", ALLOW_PRIVATE_ADDRESSES: "true", NODE_ENV: "test", SSRF_DISABLED: "1" });
    const result = await safeFetch("http://127.0.0.1:9/");
    assert.ok(!result.ok);
    assert.equal(result.reason, "blocked");
  } finally {
    process.env = saved;
  }
});

test("a name that was not answered in time is asked once more, and the second answer is validated like any other", async () => {
  const server = await startServer((_req, res) => send(res, 200, "text/plain", "ok"));
  try {
    let calls = 0;
    const late: Resolver = (_host, signal) => {
      calls++;
      return calls === 1 ? new Promise<string[]>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))) : Promise.resolve(["127.0.0.1"]);
    };
    const ok = await safeFetch(`http://slow.example:${server.port}/`, { resolver: late, testAllowAddress: allowLoopback, phaseTimeoutsMs: { resolveMs: 80 } });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(calls, 2);
    // Two silences in a row are still a timeout, and a private answer on the second try is still refused.
    let twice = 0;
    const never: Resolver = () => { twice++; return new Promise(() => {}); };
    const gone = await safeFetch("http://slow.example/", { resolver: never, phaseTimeoutsMs: { resolveMs: 50 } });
    assert.ok(!gone.ok && gone.reason === "timeout");
    assert.equal(twice, 2, "asked twice, not more");
    let n = 0;
    const rebinding: Resolver = () => { n++; return n === 1 ? new Promise(() => {}) : Promise.resolve(["10.0.0.9"]); };
    const blocked = await safeFetch("http://slow.example/", { resolver: rebinding, phaseTimeoutsMs: { resolveMs: 50 } });
    assert.ok(!blocked.ok && blocked.reason === "blocked");
  } finally {
    await server.close();
  }
});
