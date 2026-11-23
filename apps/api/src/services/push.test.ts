import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { server as copy } from "@purss/translations/server";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushPending } from "@purss/domain";
import { makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { nowIso } from "../http.ts";
import { signIn, startTestServer, call } from "../features-testing.ts";
import { publicRouter } from "../routes/public.ts";
import { extraRouters } from "../routes/index.ts";
import { createDeviceToken, revokeAllDevices } from "../connect/devices.ts";
import { insertItem } from "./items.ts";
import { notifyArrivals } from "./notifications.ts";
import { listSources } from "./sources.ts";
import { setPreferences } from "./preferences.ts";
import { setRelayFetchForTests, startPush, wakeHeld, wakePhones } from "./push.ts";

const HANDLE = `rh_${"A".repeat(43)}`;
const OTHER_HANDLE = `rh_${"B".repeat(43)}`;

type Relay = { url: string; requests: { path: string; headers: IncomingMessage["headers"]; body: string }[]; answer: { status: number; headers?: Record<string, string> }; close: () => Promise<void> };

/** A stand-in for the push relay: records what the PURSS sends and answers as told. */
async function fakeRelay(): Promise<Relay> {
  const relay: Relay = { url: "", requests: [], answer: { status: 202 }, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      relay.requests.push({ path: `${req.method} ${req.url}`, headers: req.headers, body });
      res.writeHead(relay.answer.status, { "content-type": "application/json", ...relay.answer.headers }).end(relay.answer.status === 202 ? '{"ok":true}' : '{"error":"x"}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  relay.close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return relay;
}

async function boot() {
  const { app, cleanup } = makeTestApp();
  const relay = await fakeRelay();
  app.config.pushRelay = relay.url;
  setRelayFetchForTests({ testAllowAddress: (ip) => ip === "127.0.0.1" });
  const owner = makeOwner(app);
  const server = await startTestServer(app, [publicRouter(), ...extraRouters.api()], extraRouters.pages());
  const phone = createDeviceToken(app, owner.accountId, "mobile", "Pixel").secret;
  const src = makeSource(app, owner, "Tidal Notes", "feed/1");
  app.db.run("UPDATE sources SET notify = 'on' WHERE id = ?", src);
  const asPhone = async (method: string, path: string, body?: unknown, token = phone) => {
    const res = await fetch(server.base + path, { method, headers: { authorization: `Bearer ${token}`, origin: "https://localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  // What the phone's native notification code sends: its fetch credential only, no device token, no cookie, no Origin.
  const fetchPending = async (fetchToken: string) => {
    const res = await fetch(`${server.base}/api/push/pending`, { method: "POST", headers: { authorization: `Bearer ${fetchToken}`, "content-type": "application/json" }, body: "{}" });
    return { status: res.status, json: await res.json() as PushPending & { error?: { code: string } } };
  };
  const register = async (handle = HANDLE) => {
    const r = await asPhone("POST", "/api/push/device", { relay: relay.url, handle });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // Registering hands the phone everything up to this millisecond; what a test makes arrive next must come after it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    return r.json.fetchToken as string;
  };
  const arrive = (n = 1) => notifyArrivals(app, owner.accountId, [[src, n]]);
  return {
    app, owner, relay, server, phone, src, asPhone, fetchPending, register, arrive,
    close: async () => { await server.close(); await relay.close(); setRelayFetchForTests({}); cleanup(); },
  };
}

test("a phone registers its relay handle; only the phone app can, and only for the PURSS's relay", async () => {
  const b = await boot();
  try {
    assert.deepEqual((await b.asPhone("GET", "/api/push")).json, { relay: b.relay.url, registered: false });
    const ext = createDeviceToken(b.app, b.owner.accountId, "extension", "Firefox").secret;
    assert.equal((await b.asPhone("POST", "/api/push/device", { relay: b.relay.url, handle: HANDLE }, ext)).status, 403, "the extension's token doesn't reach it");
    const browser = await call(b.app, b.server.base, "POST", "/api/push/device", signIn(b.app, b.owner.accountId), { relay: b.relay.url, handle: HANDLE });
    assert.equal(browser.status, 400, "a browser session isn't a phone");
    assert.equal((await b.asPhone("POST", "/api/push/device", { relay: "https://other-relay.example", handle: HANDLE })).json.error.code, "push_relay");
    assert.equal((await b.asPhone("POST", "/api/push/device", { relay: b.relay.url, handle: "not-a-handle" })).status, 400);
    assert.equal((await b.asPhone("POST", "/api/push/device", { relay: b.relay.url, handle: HANDLE, extra: 1 })).status, 400);
    const token = await b.register();
    assert.match(token, /^purss_push_[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(b.app.db.all("SELECT * FROM push_devices")).includes(token.slice(9)), "only the credential's hash is stored");
    assert.deepEqual((await b.asPhone("GET", "/api/push")).json, { relay: b.relay.url, registered: true });
    b.app.config.pushRelay = null;
    assert.deepEqual((await b.asPhone("GET", "/api/push")).json, { relay: null, registered: false });
    assert.equal((await b.asPhone("POST", "/api/push/device", { relay: b.relay.url, handle: HANDLE })).json.error.code, "push_off");
  } finally { await b.close(); }
});

test("a new notification wakes the phone by handle only; the phone then fetches the text once, and again when it grows", async () => {
  const b = await boot();
  const stop = startPush(b.app);
  try {
    const token = await b.register();
    b.arrive();
    // The waker gathers for a few seconds after a notification, then asks the relay.
    for (let i = 0; i < 100 && !b.relay.requests.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(b.relay.requests.length, 1);
    const sent = b.relay.requests[0]!;
    assert.equal(sent.path, "POST /v1/notify");
    assert.equal(sent.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(sent.body), { handle: HANDLE }, "nothing but the handle: no title, account or address");
    assert.equal(sent.headers.authorization, undefined);

    const first = await b.fetchPending(token);
    assert.equal(first.status, 200);
    assert.equal(first.json.notifications.length, 1);
    assert.deepEqual({ ...first.json.notifications[0], id: "x" }, { id: "x", title: copy.api.notifications.newFrom("Tidal Notes"), body: null, itemId: null, sourceId: b.src });
    assert.deepEqual((await b.fetchPending(token)).json.notifications, [], "handed once");

    b.arrive(2); // within the hour: the same notification grows
    const grown = await b.fetchPending(token);
    assert.equal(grown.json.notifications.length, 1);
    assert.equal(grown.json.notifications[0]!.title, copy.api.notifications.newCountFrom(3, "Tidal Notes"));
    assert.equal(grown.json.notifications[0]!.id, first.json.notifications[0]!.id, "the phone replaces the one it shows");
  } finally { await stop(); await b.close(); }
});

test("the fetch says how many new items there are, as the sidebar adds them up, even with notifications off", async () => {
  const b = await boot();
  try {
    const token = await b.register();
    const other = makeSource(b.app, b.owner, "Salt Marsh", "feed/2");
    let n = 0;
    const add = (sourceId: string | null, isNew: boolean) => b.app.db.tx(() => insertItem(b.app, {
      accountId: b.owner.accountId, sourceId, kind: "article", title: `Item ${++n}`, url: `https://example.org/p/${n}`,
      author: null, summaryHtml: null, contentHtml: null, imageUrl: null, durationSeconds: null, doi: null, curatorNote: null,
      publishedAt: null, discoveredAt: nowIso(), enclosures: [], isNew, reason: "test",
    }));
    add(b.src, true); add(b.src, true); add(other, true); add(other, false); add(null, false);
    const sidebar = listSources(b.app, b.owner).reduce((sum, s) => sum + s.newCount, 0);
    assert.equal(sidebar, 3);
    assert.equal((await b.fetchPending(token)).json.newItems, 3);
    b.app.db.run("UPDATE sources SET followed = 0 WHERE id = ?", other);
    assert.equal((await b.fetchPending(token)).json.newItems, 2, "an unfollowed source isn't in the sidebar");
    setPreferences(b.app, b.owner.accountId, { notifications: { frequency: "off" } });
    assert.deepEqual((await b.fetchPending(token)).json, { notifications: [], newItems: 2 });
  } finally { await b.close(); }
});

test("bodies follow 'Show item titles in notifications'; read notices aren't handed and Never still delivers independent notices", async () => {
  const b = await boot();
  try {
    const token = await b.register();
    setPreferences(b.app, b.owner.accountId, { notifications: { previews: true } });
    b.arrive();
    b.app.db.run("UPDATE notifications SET body = 'Mudflat ecology'"); // the latest item's title, as notifyArrivals writes it with titles on
    assert.equal((await b.fetchPending(token)).json.notifications[0]!.body, "Mudflat ecology");
    setPreferences(b.app, b.owner.accountId, { notifications: { previews: false } });
    b.app.db.run("UPDATE notifications SET changed_at = ?", new Date(Date.now() + 500).toISOString());
    assert.equal((await b.fetchPending(token)).json.notifications[0]!.body, null, "titles off: no body");

    b.app.db.run("UPDATE notifications SET created_at = '2020-01-01T00:00:00.000Z'"); // a isNew arrival notification, not a grown one
    b.arrive();
    b.app.db.run("UPDATE notifications SET seen_at = ?", new Date().toISOString());
    assert.deepEqual((await b.fetchPending(token)).json.notifications, [], "read in the bell already");

    setPreferences(b.app, b.owner.accountId, { notifications: { frequency: "off" } });
    b.app.db.run("INSERT INTO notifications (id, account_id, kind, title, dedup_key, created_at) VALUES ('reminder', ?, 'reminder', ?, 'reminder:test', ?)", b.owner.accountId, copy.api.shared.reminderSubjectOne, new Date(Date.now() + 2000).toISOString());
    assert.equal(await wakePhones(b.app, b.owner.accountId), null, "a successful wake needs no retry");
    assert.equal(b.relay.requests.length, 1, "the reminder wakes the phone under Never");
    const reminder = (await b.fetchPending(token)).json.notifications;
    assert.equal(reminder.length, 1, "Never leaves reminders available to the phone");
    assert.equal(reminder[0]!.title, copy.api.shared.reminderSubjectOne);
  } finally { await b.close(); }
});

test("quiet hours hold the wake back; it waits in the bell and comes with the next wake after them", async () => {
  const b = await boot();
  try {
    const token = await b.register();
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    setPreferences(b.app, b.owner.accountId, { timezone: "UTC", notifications: { quietStart: hhmm(new Date(now.getTime() - 3_600_000)), quietEnd: hhmm(new Date(now.getTime() + 3_600_000)) } });
    b.arrive();
    assert.equal(await wakePhones(b.app, b.owner.accountId, now.getTime()), null);
    assert.equal(b.relay.requests.length, 0);
    assert.equal(await wakePhones(b.app, b.owner.accountId, now.getTime() + 2 * 3_600_000), null, "after quiet hours");
    assert.equal(b.relay.requests.length, 1);
    assert.equal((await b.fetchPending(token)).json.notifications.length, 1);
  } finally { await b.close(); }
});

test("a phone is woken at most once a minute; a relay that asks to slow down is waited for", async () => {
  const b = await boot();
  try {
    await b.register();
    b.arrive();
    const t0 = Date.now();
    assert.equal(await wakePhones(b.app, b.owner.accountId, t0), null);
    await new Promise((r) => setTimeout(r, 5));
    b.arrive(); // more arrives (the notification grows) before the phone fetched
    const again = await wakePhones(b.app, b.owner.accountId, t0 + 20_000);
    assert.equal(b.relay.requests.length, 1, "something new waits, but it was woken 20 s ago");
    assert.ok(again !== null && again > 39_000 && again <= 40_000, String(again));
    b.relay.answer = { status: 429, headers: { "retry-after": "120" } };
    assert.equal(await wakePhones(b.app, b.owner.accountId, t0 + 61_000), 120_000);
  } finally { await b.close(); }
});

test("a relay that no longer knows the handle drops the registration; revoking the device drops it and its credential", async () => {
  const b = await boot();
  try {
    const token = await b.register();
    b.arrive();
    b.relay.answer = { status: 404 };
    await wakePhones(b.app, b.owner.accountId);
    assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_devices")!.n, 0);
    assert.equal((await b.fetchPending(token)).status, 401);

    const second = await b.register(OTHER_HANDLE);
    assert.equal((await b.fetchPending(second)).status, 200);
    assert.equal((await b.asPhone("DELETE", "/api/push/device")).status, 200);
    assert.equal((await b.fetchPending(second)).status, 401, "unregistered");

    const third = await b.register();
    revokeAllDevices(b.app, b.owner.accountId);
    assert.equal(b.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_devices")!.n, 0, "goes with the device token");
    assert.equal((await b.fetchPending(third)).status, 401);
    assert.equal((await b.fetchPending("purss_dev_notapushtoken")).status, 401);
    assert.equal((await b.fetchPending("")).status, 401);
  } finally { await b.close(); }
});

test("the fetch credential reaches nothing else, and a device token doesn't reach the fetch", async () => {
  const b = await boot();
  try {
    const token = await b.register();
    const asFetch = await fetch(`${b.server.base}/api/notifications`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(asFetch.status, 401, "not a device token, not a session");
    assert.equal((await b.fetchPending(b.phone)).status, 401);
  } finally { await b.close(); }
});

test("a phone registered with another relay isn't woken after the operator changes relays", async () => {
  const b = await boot();
  try {
    await b.register();
    b.arrive();
    b.app.config.pushRelay = "https://push.example.org";
    assert.equal(await wakePhones(b.app, b.owner.accountId), null);
    assert.equal(b.relay.requests.length, 0);
    assert.deepEqual((await b.asPhone("GET", "/api/push")).json, { relay: "https://push.example.org", registered: false }, "the app registers again");
  } finally { await b.close(); }
});

test("what quiet hours held back wakes the phone once they end, from the maintenance tick, also after a restart", async () => {
  const b = await boot();
  const waitForRequests = async (n: number) => { for (let i = 0; i < 100 && b.relay.requests.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    const token = await b.register();
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    setPreferences(b.app, b.owner.accountId, { timezone: "UTC", notifications: { quietStart: hhmm(new Date(now.getTime() - 3_600_000)), quietEnd: hhmm(new Date(now.getTime() + 3_600_000)) } });
    let stop = startPush(b.app);
    b.arrive();
    wakeHeld(b.app);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b.relay.requests.length, 0, "nothing during quiet hours");
    // The server restarts during the night: nothing about the held wake was kept in memory.
    await stop();
    stop = startPush(b.app);
    // Quiet hours are over.
    setPreferences(b.app, b.owner.accountId, { notifications: { quietStart: null, quietEnd: null } });
    wakeHeld(b.app, Date.now() + 61_000);
    await waitForRequests(1);
    assert.equal(b.relay.requests.length, 1, "one wake once quiet hours end");
    assert.equal(b.relay.requests[0]!.body, JSON.stringify({ handle: HANDLE }));
    // The phone doesn't answer (offline): later ticks don't wake it again for the same notifications.
    wakeHeld(b.app, Date.now() + 2 * 61_000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b.relay.requests.length, 1, "a wake isn't repeated for what it already announced");
    assert.equal((await b.fetchPending(token)).json.notifications.length, 1, "what waited is fetched");
    await stop();
  } finally { await b.close(); }
});
