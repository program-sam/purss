import test from "node:test";
import assert from "node:assert/strict";
import { PAGE_POLICY, workspacePolicy } from "./csp.ts";
import { EMBED_ORIGINS } from "../lib/embeds.ts";

test("once connected, requests and images are limited to PURSS and https publishers, and media to https publishers", () => {
  assert.equal(workspacePolicy("https://ws.example:8443"), "connect-src 'self' https://ws.example:8443; img-src 'self' https: data: https://ws.example:8443; media-src 'self' https:");
  assert.equal(workspacePolicy("http://192.168.1.20:8940"), "connect-src 'self' http://192.168.1.20:8940; img-src 'self' https: data: http://192.168.1.20:8940; media-src 'self' https:");
  assert.match(workspacePolicy("http://[::1]:8940"), /^connect-src 'self' http:;/, "an IPv6 address can't be a source; its scheme is");
});

test("the push relay is the one other origin the page may call, and only for requests", () => {
  assert.equal(workspacePolicy("https://ws.example", ["https://push.example.org/"]), "connect-src 'self' https://ws.example https://push.example.org; img-src 'self' https: data: https://ws.example; media-src 'self' https:");
});

test("the desktop app adds its IPC to requests and its own server on 127.0.0.1 to media, and nothing else", () => {
  assert.equal(workspacePolicy("https://ws.example", [], { media: "http://127.0.0.1:40123/k/" }),
    "connect-src 'self' https://ws.example ipc: http://ipc.localhost; img-src 'self' https: data: https://ws.example; media-src 'self' https: http://127.0.0.1:40123");
  assert.match(PAGE_POLICY, /connect-src 'self' https: http: ipc: http:\/\/ipc\.localhost;/);
});

test("the page's policy loads scripts only from the app itself and frames only the video players the reader embeds", () => {
  assert.match(PAGE_POLICY, /script-src 'self';/);
  assert.match(PAGE_POLICY, /object-src 'none'/);
  assert.match(PAGE_POLICY, new RegExp(`frame-src ${EMBED_ORIGINS.join(" ")};`));
  for (const o of EMBED_ORIGINS) assert.match(o, /^https:\/\/[a-z0-9.-]+$/, "a frame source is one https origin, never a scheme or a wildcard");
  assert.doesNotMatch(PAGE_POLICY, /unsafe-eval|script-src[^;]*unsafe-inline/);
});
