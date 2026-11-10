import test from "node:test";
import assert from "node:assert/strict";
import { webRoute } from "./web-routes.ts";

const site = { withSite: true, signedIn: false };

test("the app lives under /app/ and loads its page for every route there", () => {
  assert.deepEqual(webRoute("/app/", site), { kind: "app", file: "/" });
  assert.deepEqual(webRoute("/app/c/col_1", site), { kind: "app", file: "/c/col_1" });
  assert.deepEqual(webRoute("/app/assets/index-1.js", { withSite: false, signedIn: false }), { kind: "app", file: "/assets/index-1.js" });
  assert.deepEqual(webRoute("/app", site), { kind: "redirect", to: "/app/" });
});

test("with the website, the root and its pages are the website's", () => {
  assert.deepEqual(webRoute("/", site), { kind: "site", file: "/index.html" });
  assert.deepEqual(webRoute("/terms.html", site), { kind: "site", file: "/terms.html" });
  assert.deepEqual(webRoute("/no-such-page", site), { kind: "site", file: "/no-such-page" });
  assert.deepEqual(webRoute("/application", site), { kind: "site", file: "/application" });
});

test("someone signed in who opens the root goes to the app; the website's other pages stay readable", () => {
  const signedIn = { withSite: true, signedIn: true };
  assert.deepEqual(webRoute("/", signedIn), { kind: "redirect", to: "/app/" });
  assert.deepEqual(webRoute("/terms.html", signedIn), { kind: "site", file: "/terms.html" });
});

test("without the website (self-hosted), the root opens the app and nothing else is there", () => {
  assert.deepEqual(webRoute("/", { withSite: false, signedIn: false }), { kind: "redirect", to: "/app/" });
  assert.deepEqual(webRoute("/terms.html", { withSite: false, signedIn: false }), { kind: "missing" });
});
