import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFraming, framingAllowed } from "./frame-policy.ts";
import { safeFetch } from "./safe-fetch.ts";
import type { SafeFetchOptions } from "./safe-fetch.ts";
import { allowLoopback, fakeFailure, fakeResponse, send, startServer } from "./testing.ts";

const PURSS = "https://purss.example";
const allowed = (headers: Record<string, string>, page = "https://site.example/a") => framingAllowed(headers, page, PURSS);

test("a page without frame headers may be framed; DENY and SAMEORIGIN refuse another site", () => {
  assert.equal(allowed({}), true);
  assert.equal(allowed({ "x-frame-options": "DENY" }), false);
  assert.equal(allowed({ "x-frame-options": "sameorigin" }), false);
  assert.equal(allowed({ "x-frame-options": "SAMEORIGIN, SAMEORIGIN" }), false);
  assert.equal(allowed({ "x-frame-options": "SAMEORIGIN" }, "https://purss.example/page"), true, "PURSS's own origin");
  // The browsers ignore ALLOW-FROM, which then allows any frame.
  assert.equal(allowed({ "x-frame-options": "ALLOW-FROM https://other.example" }), true);
});

test("frame-ancestors decides over X-Frame-Options, and every policy that names it must allow the frame", () => {
  assert.equal(allowed({ "content-security-policy": "default-src 'self'; frame-ancestors *", "x-frame-options": "DENY" }), true);
  assert.equal(allowed({ "content-security-policy": "frame-ancestors 'none'" }), false);
  assert.equal(allowed({ "content-security-policy": "frame-ancestors 'self'" }), false);
  assert.equal(allowed({ "content-security-policy": "frame-ancestors 'self'" }, "https://purss.example/x"), true);
  assert.equal(allowed({ "content-security-policy": "frame-ancestors https:" }), true);
  assert.equal(allowed({ "content-security-policy": "frame-ancestors http:" }), true, "http: matches its upgrade");
  assert.equal(allowed({ "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" }), false);
  assert.equal(allowed({ "content-security-policy": "upgrade-insecure-requests, frame-ancestors *" }), true, "a policy without it doesn't count");
  assert.equal(allowed({ "content-security-policy": "FRAME-ANCESTORS https://PURSS.example; frame-ancestors 'none'" }), true, "the first one counts");
  // Only enforced policies count.
  assert.equal(allowed({ "content-security-policy-report-only": "frame-ancestors 'none'" }), true);
});

test("host sources match by scheme, host (with a leading wildcard) and port", () => {
  const fa = (list: string, embedder = PURSS) => framingAllowed({ "content-security-policy": `frame-ancestors ${list}` }, "https://site.example/a", embedder);
  // What large sites send (checked on 2026-11-14).
  assert.equal(fa("'self' https://*.substack.com https://substack.com"), false);
  assert.equal(fa("https://platform.theverge.com https://*.theverge.com 'self'"), false);
  assert.equal(fa("'self' https://x.com https://x.com:443 https://twitter.com"), false);
  assert.equal(fa("https://*.example"), true);
  assert.equal(fa("*.example"), true, "no scheme: the page's own, here https");
  assert.equal(fa("https://*.purss.example"), false, "a wildcard needs a subdomain");
  assert.equal(fa("https://*"), true, "any host over https");
  assert.equal(fa("https://*", "http://purss.example"), false);
  assert.equal(fa("purss.example"), true);
  assert.equal(fa("purss.example:443"), true);
  assert.equal(fa("purss.example:8443"), false);
  assert.equal(fa("purss.example:*", "https://purss.example:8443"), true);
  assert.equal(fa("purss.example", "https://purss.example:8443"), false);
  assert.equal(fa("https://purss.example/"), true);
  assert.equal(fa("https://purss.example/reader"), false, "an origin has no path");
  assert.equal(fa("http://purss.example"), true, "upgrade");
  assert.equal(fa("https://purss.example", "http://purss.example"), false, "no downgrade");
  assert.equal(fa("purss.example", "http://purss.example"), false, "an https page's sources without a scheme mean https");
  assert.equal(fa("'unsafe-inline' 'nonce-abc'"), false);
});

test("the check reads the answer's headers after redirects, and frames only success over https", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/open") return send(res, 200, "text/html", "<p>hi</p>");
    if (req.url === "/deny") return send(res, 200, "text/html", "<p>hi</p>", { "x-frame-options": "DENY" });
    if (req.url === "/moved") { res.writeHead(302, { location: "/open", "x-frame-options": "DENY" }); return res.end(); }
    if (req.url === "/wall") return send(res, 403, "text/html", "Just a moment");
    if (req.url === "/file.pdf") return send(res, 200, "application/pdf", "%PDF-1.7", { "content-disposition": "attachment; filename=\"a.pdf\"" });
    send(res, 404, "text/plain", "no");
  });
  try {
    const fetch = (url: string, opts: SafeFetchOptions) => safeFetch(url, { ...opts, testAllowAddress: allowLoopback });
    const check = (path: string, embedder = "http://purss.lan") => checkFraming(`${server.origin}${path}`, embedder, { fetch });
    assert.deepEqual(await check("/open"), { frame: true, url: `${server.origin}/open` });
    assert.deepEqual(await check("/deny"), { frame: false });
    assert.deepEqual(await check("/moved"), { frame: true, url: `${server.origin}/open` }, "the redirect's own headers don't count");
    assert.deepEqual(await check("/wall"), { frame: false });
    assert.deepEqual(await check("/file.pdf"), { frame: false }, "a download keeps its behaviour");
    assert.deepEqual(await check("/open", PURSS), { frame: false }, "an https PURSS can't frame a plain http page");
  } finally {
    await server.close();
  }
  const failing = async () => fakeFailure("timeout");
  assert.deepEqual(await checkFraming("https://site.example/", PURSS, { fetch: failing }), { frame: false });
  const upgraded = async () => fakeResponse("https://site.example/a", "<p>x</p>", "text/html", 200, { redirects: ["http://site.example/a"] });
  assert.deepEqual(await checkFraming("http://site.example/a", PURSS, { fetch: upgraded }), { frame: true, url: "https://site.example/a" });
});
