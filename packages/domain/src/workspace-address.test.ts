import test from "node:test";
import assert from "node:assert/strict";
import { isLocalNetworkHost, isLoopbackHost, parseWorkspaceAddress, startingServer } from "./workspace-address.ts";

test("a typed PURSS address becomes its origin; plain http only on this device or the local network", () => {
  const ok = (input: string) => { const r = parseWorkspaceAddress(input); assert.ok(r.ok, `${input}: ${!r.ok ? r.message : ""}`); return r; };
  assert.deepEqual(ok("ws.example.org"), { ok: true, origin: "https://ws.example.org", unencrypted: false });
  assert.deepEqual(ok("  https://WS.example.org/some/page?x=1#y "), { ok: true, origin: "https://ws.example.org", unencrypted: false });
  assert.deepEqual(ok("https://ws.example.org:8443"), { ok: true, origin: "https://ws.example.org:8443", unencrypted: false });
  assert.deepEqual(ok("localhost:8940"), { ok: true, origin: "http://localhost:8940", unencrypted: false }, "local without a scheme means http");
  assert.deepEqual(ok("http://127.0.0.1:8940"), { ok: true, origin: "http://127.0.0.1:8940", unencrypted: false });
  assert.deepEqual(ok("http://[::1]:8940"), { ok: true, origin: "http://[::1]:8940", unencrypted: false });
  assert.deepEqual(ok("http://10.0.2.2:8940"), { ok: true, origin: "http://10.0.2.2:8940", unencrypted: true }, "the computer an Android emulator runs on");
  assert.deepEqual(ok("192.168.1.20:8940"), { ok: true, origin: "http://192.168.1.20:8940", unencrypted: true });
  assert.deepEqual(ok("http://nas.local:8940"), { ok: true, origin: "http://nas.local:8940", unencrypted: true });
  assert.deepEqual(ok("http://[fd12:3456::1]:8940"), { ok: true, origin: "http://[fd12:3456::1]:8940", unencrypted: true });
  assert.deepEqual(ok("https://192.168.1.20"), { ok: true, origin: "https://192.168.1.20", unencrypted: false });
  for (const bad of ["", "   ", "http://ws.example.org", "ftp://ws.example.org", "https://user:pw@ws.example.org", "javascript:alert(1)", "http://8.8.8.8", "http://[2001:db8::1]", "https://", "http://local", "http://.lan"]) {
    assert.equal(parseWorkspaceAddress(bad).ok, false, bad);
  }
});

test("local hosts are loopback, private, shared and link-local ranges, and local-only names", () => {
  for (const h of ["localhost", "127.0.0.1", "127.8.9.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.1.1", "169.254.10.1",
    "[::1]", "[fd00::1]", "[fc00::1]", "[fe80::1]", "[febf::1]", "nas.local", "box.lan", "pi.home.arpa", "x.internal", "app.localhost", "NAS.Local."]) {
    assert.ok(isLocalNetworkHost(h), h);
  }
  for (const h of ["example.org", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.63.0.1", "100.128.0.1", "169.253.0.1", "8.8.8.8", "256.1.1.1", "local", "lan",
    "notlocal.com", "localhost.example.org", "[2001:db8::1]", "[fec0::1]", "[::ffff:c0a8:101]"]) {
    assert.ok(!isLocalNetworkHost(h), h);
  }
  assert.ok(isLoopbackHost("127.0.0.1") && isLoopbackHost("[::1]") && isLoopbackHost("a.localhost"));
  assert.ok(!isLoopbackHost("10.0.2.2") && !isLoopbackHost("nas.local"));
});

test("a connect screen starts on the official server unless another one was chosen before", () => {
  const official = "https://workspace.example.org";
  assert.deepEqual(startingServer(null, official), { kind: "official", origin: official });
  assert.deepEqual(startingServer("", official), { kind: "official", origin: official });
  assert.deepEqual(startingServer("https://workspace.example.org", official), { kind: "official", origin: official }, "the official server, chosen before");
  assert.deepEqual(startingServer("https://ws.home.example", official), { kind: "other", address: "https://ws.home.example" });
  assert.deepEqual(startingServer("http://192.168.1.20:8940", official), { kind: "other", address: "http://192.168.1.20:8940" }, "a remembered local server keeps its http");
  assert.deepEqual(startingServer("http://8.8.8.8", official), { kind: "official", origin: official }, "a remembered address the rules refuse isn't taken");
  assert.deepEqual(startingServer(null, ""), { kind: "other", address: "" }, "no official server: only the address field");
  assert.deepEqual(startingServer("https://ws.home.example", ""), { kind: "other", address: "https://ws.home.example" });
  assert.deepEqual(startingServer(null, "  "), { kind: "other", address: "" });
});
