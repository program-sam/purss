import assert from "node:assert/strict";
import test from "node:test";
import { startEgress } from "./server.ts";
import { control, makeConfig } from "./testing.ts";

/*
 * The control listener answers requests addressed to the address it is bound to. In Compose that is a private address
 * (EGRESS_CONTROL_HOST), and it is the address the API calls, so its Host header names that address, not loopback.
 * 127.0.0.2 stands in for it here: it is not one of the loopback names the listener always accepts.
 */

const PRIVATE = "127.0.0.2";

test("a control listener bound to a private address answers requests addressed to it, and still refuses any other host name", async () => {
  const egress = await startEgress(makeConfig({ control: { host: PRIVATE, port: 0 } }));
  try {
    const port = egress.ports.control;
    const at = (host: string, token?: string | null) => control(port, "GET", "/status", { connect: PRIVATE, host, token });
    const ok = await at(`${PRIVATE}:${port}`);
    assert.equal(ok.status, 200, "the address the API calls");
    assert.equal(ok.json.status, "ok");
    assert.equal((await at(`127.0.0.1:${port}`)).status, 200, "loopback names stay valid");
    assert.equal((await at(`localhost:${port}`)).status, 200);
    assert.equal((await at(`${PRIVATE}:${port + 1}`)).status, 421, "another port");
    assert.equal((await at(PRIVATE)).status, 421, "no port");
    assert.equal((await at(`evil.example:${port}`)).status, 421, "a name pointed at this address (DNS rebinding)");
    assert.equal((await at(`${PRIVATE}:${port}`, null)).status, 401, "the right host still needs the service token");
    assert.equal((await at(`${PRIVATE}:${port}`, "x".repeat(48))).status, 401);
  } finally {
    await egress.stop();
  }
});

test("a control listener on loopback accepts only loopback names", async () => {
  const egress = await startEgress(makeConfig());
  try {
    const port = egress.ports.control;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) assert.equal((await control(port, "GET", "/status", { host })).status, 200, host);
    for (const host of [`127.0.0.2:${port}`, `172.31.88.10:${port}`, `evil.example:${port}`]) assert.equal((await control(port, "GET", "/status", { host })).status, 421, host);
  } finally {
    await egress.stop();
  }
});
