import assert from "node:assert/strict";
import test from "node:test";
import { OFFICIAL_PUSH_RELAY } from "@purss/domain/distribution";
import { PUSH_MESSAGES } from "./push.ts";

Reflect.set(globalThis, "__PURSS_PHONE_PUSH_ENABLED__", false);
const { devicePush, pushSetup } = await import("./push-device.ts");
Reflect.deleteProperty(globalThis, "__PURSS_PHONE_PUSH_ENABLED__");

test("a FOSS build skips the native push setup", async () => {
  assert.deepEqual(await pushSetup(), { relay: OFFICIAL_PUSH_RELAY, ready: false, debugToken: "" });
});

test("a build without phone push explains that it is unavailable and skips the native listener", async () => {
  const device = devicePush("https://purss.example", { relay: "https://relay.example", ready: false, debugToken: "" });
  assert.deepEqual(await device.push.status(), { state: "unavailable", detail: PUSH_MESSAGES.unavailable });
  assert.deepEqual(await device.push.enable(), { state: "unavailable", detail: PUSH_MESSAGES.unavailable });
  assert.doesNotThrow(() => device.onTap(() => assert.fail("unavailable push must not register a listener")));
  await assert.doesNotReject(device.forget());
});
