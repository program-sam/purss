import test from "node:test";
import assert from "node:assert/strict";
import { PUSH_MESSAGES, PushController } from "./push.ts";
import type { PushDeps, PushPermission } from "./push.ts";

const RELAY = "https://push.example.org";
const handleFor = (token: string, scope: string) => `rh_${(token + scope).replace(/[^A-Za-z0-9]/g, "").padEnd(43, "x").slice(0, 43)}`;

function fake(over: Partial<PushDeps> & { workspaceRelay?: string | null } = {}) {
  const kv = new Map<string, string>();
  const calls: string[] = [];
  const state = { permission: "prompt" as PushPermission, prompts: 0, registered: null as string | null, target: null as string | null, token: "fcm-token-1", relayUp: true, workspaceUp: true };
  const workspaceRelay = over.workspaceRelay === undefined ? RELAY : over.workspaceRelay;
  const deps: PushDeps = {
    platform: "fcm",
    relay: RELAY,
    ready: true,
    store: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v), remove: (k) => void kv.delete(k) },
    api: async <T,>(path: string, init?: { method?: string; body?: unknown }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (!state.workspaceUp) throw new Error("offline");
      if (path === "/api/push" && !init?.method) return { relay: workspaceRelay, registered: state.registered !== null } as T;
      if (path === "/api/push/device" && init?.method === "POST") {
        state.registered = (init.body as { handle: string }).handle;
        return { fetchToken: `purss_push_${calls.length}` } as T;
      }
      if (path === "/api/push/device" && init?.method === "DELETE") { state.registered = null; return { ok: true } as T; }
      throw new Error(`unexpected ${path}`);
    },
    relayPost: async (path, body) => {
      calls.push(`relay ${path}`);
      if (!state.relayUp) throw new Error("offline");
      if (path === "/v1/register") {
        const b = body as { token: string; scope: string };
        return { status: 200, json: { handle: handleFor(b.token, b.scope) } };
      }
      return { status: 204, json: null };
    },
    permission: async () => state.permission,
    requestPermission: async () => { state.prompts++; if (state.permission === "prompt") state.permission = "granted"; return state.permission; },
    token: async () => state.token,
    setTarget: async (t) => { state.target = t; },
    clearTarget: async () => { state.target = null; },
    randomScope: () => "scope-abcdefghijklmnopqrstuv",
    ...over,
  };
  return { c: new PushController(deps), state, calls, kv };
}

test("nothing is asked until the person turns it on; turning it on prompts once and registers through the relay", async () => {
  const f = fake();
  assert.deepEqual(await f.c.status(), { state: "off", detail: null });
  await f.c.refresh();
  assert.equal(f.state.prompts, 0, "no prompt at start");
  assert.ok(!f.calls.some((c) => c.startsWith("relay")), "and nothing sent to the relay");
  assert.deepEqual(await f.c.enable(), { state: "on", detail: null });
  assert.equal(f.state.prompts, 1);
  assert.equal(f.state.registered, handleFor("fcm-token-1", "scope-abcdefghijklmnopqrstuv"));
  assert.match(f.state.target ?? "", /^purss_push_/);
  assert.deepEqual(await f.c.status(), { state: "on", detail: null });
});

test("a refused prompt, a build without push and a PURSS without it say why", async () => {
  const denied = fake();
  denied.state.permission = "denied";
  assert.deepEqual(await denied.c.enable(), { state: "denied", detail: PUSH_MESSAGES.denied });
  assert.equal(denied.state.registered, null);
  assert.deepEqual(await fake({ ready: false }).c.enable(), { state: "unavailable", detail: PUSH_MESSAGES.unavailable });
  assert.deepEqual(await fake({ workspaceRelay: null }).c.status(), { state: "unavailable", detail: PUSH_MESSAGES.workspaceOff });
  assert.deepEqual(await fake({ workspaceRelay: "https://other.example" }).c.enable(), { state: "unavailable", detail: PUSH_MESSAGES.otherRelay });
});

test("at start the registration follows a new push address, and a PURSS that forgot the phone gets it again", async () => {
  const f = fake();
  await f.c.enable();
  const first = f.state.registered;
  f.calls.length = 0;
  await f.c.refresh();
  assert.ok(!f.calls.includes("POST /api/push/device"), "same address, still registered: nothing to do");
  f.state.token = "fcm-token-2";
  await f.c.refresh();
  assert.notEqual(f.state.registered, first);
  f.state.registered = null; // the relay said the handle was gone
  await f.c.refresh();
  assert.equal(f.state.registered, handleFor("fcm-token-2", "scope-abcdefghijklmnopqrstuv"));
  f.state.permission = "denied"; // withdrawn in the system's settings
  assert.deepEqual(await f.c.status(), { state: "denied", detail: PUSH_MESSAGES.denied });
});

test("turning it off and forgetting the connection unregister from PURSS and the relay and clear the native credential", async () => {
  const f = fake();
  await f.c.enable();
  assert.deepEqual(await f.c.disable(), { state: "off", detail: null });
  assert.equal(f.state.registered, null);
  assert.equal(f.state.target, null);
  assert.ok(f.calls.includes("relay /v1/unregister"));
  await f.c.enable();
  f.calls.length = 0;
  await f.c.forget();
  assert.equal(f.state.target, null);
  assert.deepEqual(f.calls, ["relay /v1/unregister"]);
  assert.equal(f.kv.size, 0);
});

test("turned off while offline, the phone tells PURSS and the relay at its next start", async () => {
  const f = fake();
  await f.c.enable();
  f.state.relayUp = false;
  f.state.workspaceUp = false;
  await f.c.disable();
  assert.equal(f.state.target, null, "the native credential goes at once");
  assert.notEqual(f.state.registered, null, "PURSS couldn't be told");
  assert.equal(JSON.parse(f.kv.get("purss:push")!).unsent, true, "so it is remembered");
  f.state.relayUp = true;
  f.state.workspaceUp = true;
  f.calls.length = 0;
  await f.c.refresh();
  assert.deepEqual(f.calls, ["DELETE /api/push/device", "relay /v1/unregister"], "told at the next start, nothing registered again");
  assert.equal(f.state.registered, null);
  assert.equal(JSON.parse(f.kv.get("purss:push")!).unsent, undefined);
});

test("a relay that can't be reached fails the switch with a reason and leaves no credential", async () => {
  const f = fake();
  f.state.relayUp = false;
  await assert.rejects(f.c.enable(), new RegExp(PUSH_MESSAGES.relayDown));
  assert.equal(f.state.target, null);
  assert.equal(f.state.registered, null);
});
