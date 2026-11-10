import test from "node:test";
import assert from "node:assert/strict";
import type { DeviceConnection as Connection, DownloadPlanRequest, ItemDetail } from "@purss/domain";
import { chooseDownloads, downloadCandidate, expectedBytes, MAX_DOWNLOAD_BYTES, mediaToDownload } from "@purss/domain";
import { OFFLINE_HEADER } from "../sw/protocol.ts";
import type { BackgroundState } from "./background.ts";
import { DownloadError, DownloadManager } from "./manager.ts";
import type { DeviceFiles, KeyValue, ManagerDeps } from "./manager.ts";
import type { DownloadProgress } from "./types.ts";

const MB = 1024 * 1024;

class MemoryFiles implements DeviceFiles {
  readonly files = new Map<string, { bytes: number; text?: string; url?: string }>();
  fail: DownloadError | null = null;
  downloads: string[] = [];
  /** Declare the whole size with the first progress, as most servers do. */
  declareSize = false;
  /** Holds a transfer halfway until released. */
  halfway: Promise<void> | null = null;
  /** Bytes received when the last transfer ended. */
  received = 0;
  async download(url: string, name: string, onProgress: (n: number, total: number | null) => void, signal: AbortSignal): Promise<number> {
    this.downloads.push(url);
    if (this.fail) throw this.fail;
    const bytes = Number(new URL(url).searchParams.get("size") ?? 10 * MB);
    for (const part of [1, 2, 3, 4]) {
      this.received = (bytes * part) / 4;
      onProgress(this.received, this.declareSize ? bytes : null);
      if (part === 2 && this.halfway) await this.halfway;
      if (signal.aborted) throw new DOMException("stopped", "AbortError");
    }
    this.files.set(name, { bytes, url });
    return bytes;
  }
  async list(name: string): Promise<string[]> {
    const prefix = name ? `${name}/` : "";
    return [...new Set([...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]!))];
  }
  async writeText(name: string, text: string): Promise<number> { this.files.set(name, { bytes: text.length, text }); return text.length; }
  async readText(name: string): Promise<string | null> { return this.files.get(name)?.text ?? null; }
  async readBytes(name: string): Promise<Uint8Array | null> { const f = this.files.get(name); return f ? new TextEncoder().encode(f.text ?? `<html>page of ${f.url}</html>`) : null; }
  async remove(name: string): Promise<void> { for (const k of [...this.files.keys()]) if (!name || k === name || k.startsWith(`${name}/`)) this.files.delete(k); }
  async uri(name: string): Promise<string> { return `file:///app/downloads/${name}`; }
  names(): string[] { return [...this.files.keys()].sort(); }
}

class MemoryKv implements KeyValue {
  readonly map = new Map<string, string>();
  get(k: string) { return this.map.get(k) ?? null; }
  set(k: string, v: string) { this.map.set(k, v); }
  remove(k: string) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}

function detail(id: string, over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id, sourceId: "src_1", sourceTitle: "Slow Radio", kind: "podcast", title: `Episode ${id}`, url: `https://pub.example/${id}`, author: null, excerpt: null, imageUrl: null,
    durationSeconds: 600, readMinutes: null, doi: null, publishedAt: "2026-11-01T00:00:00Z", discoveredAt: "2026-11-01T00:00:00Z", workflow: "toread", revision: 1, stateVersion: 1, fresh: false,
    progress: 0, opened: false, basketIds: [], curatorNote: null, annotatedAt: null,
    media: { url: `https://cdn.pub.example/${id}.mp3?size=${20 * MB}`, kind: "audio", type: "audio/mpeg", length: 20 * MB },
    contentHtml: "<p>Notes</p>", contentOmitted: false, summaryOnly: false, renamable: false, changedSinceKept: false, latestHtml: null, contentRef: null, latestRef: null, captures: [], keptVersionAt: null, enclosures: [], collections: [], playback: null, partialCopy: null, keptPicture: null,
    ...over,
  };
}

function setup() {
  const files = new MemoryFiles();
  const store = new MemoryKv();
  const items = new Map<string, ItemDetail>();
  const calls: string[] = [];
  let connection: Connection = "wifi";
  let offline = false;
  /** Holds PURSS's answers until it settles. */
  let hold: Promise<void> | null = null;
  const lists: Record<string, string[]> = { toread: [], inprogress: [], new: [] };
  const get = async <T,>(path: string, query?: Record<string, string | number>, headers?: Record<string, string>): Promise<T> => {
    calls.push(`${path}${query ? `?${new URLSearchParams(query as Record<string, string>)}` : ""}${headers?.["x-purss-no-copy"] ? " (no copy)" : ""}`);
    if (offline) throw Object.assign(new Error("offline"), { status: 0, code: "offline" });
    if (hold) await hold;
    let m = /^\/api\/items\/([^/]+)$/.exec(path);
    if (m) { const it = items.get(m[1]!); if (!it) throw Object.assign(new Error("gone"), { status: 404 }); return it as T; }
    m = /^\/api\/items\/([^/]+)\/annotations$/.exec(path);
    if (m) return { itemId: m[1], annotations: [{ id: "ann_1" }] } as T;
    throw new Error(`unexpected ${path}`);
  };
  // PURSS's side of POST /api/downloads/plan, with the shared rules.
  const plans: DownloadPlanRequest[] = [];
  const plan = async (req: DownloadPlanRequest) => {
    plans.push(req);
    if (offline) throw Object.assign(new Error("offline"), { status: 0, code: "offline" });
    const candidates = Object.values(lists).flat().map((id) => downloadCandidate(items.get(id)!));
    return { items: chooseDownloads(req, candidates, new Set(req.have), req.usedBytes).map((c) => ({ id: c.id, expectedBytes: expectedBytes(c), media: { kind: c.media!.kind, ...mediaToDownload(items.get(c.id)!.media!) } })) };
  };
  const mirrored: (BackgroundState | null)[] = [];
  const pages: string[] = [];
  let readPage: ManagerDeps["readPage"] = async (bytes, url) => { pages.push(url); return { ok: true, title: "Read", html: `<p>${new TextDecoder().decode(bytes)}</p>` }; };
  const m = new DownloadManager({ files, get, plan, connection: async () => connection, readPage: (b, u) => readPage(b, u), store, now: () => Date.parse("2026-11-05T10:00:00Z"), mirror: (s) => mirrored.push(s) });
  m.setAccount("acc_1");
  return { m, files, store, items, calls, plans, lists, mirrored, pages, setHold: (p: Promise<void> | null) => { hold = p; }, setReadPage: (f: ManagerDeps["readPage"]) => { readPage = f; }, setConnection: (c: Connection) => { connection = c; }, setOffline: (v: boolean) => { offline = v; } };
}

test("a download keeps the item's text, its highlights and notes, and the publisher's file", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1", { annotatedAt: "2026-11-02T00:00:00Z" }));
  await t.m.download("itm_1");
  const r = t.m.get("itm_1")!;
  assert.equal(r.state, "done");
  assert.equal(r.origin, "manual");
  assert.deepEqual(r.media && { file: r.media.file, bytes: r.media.bytes }, { file: "acc_1/itm_1/media.mp3", bytes: 20 * MB });
  assert.ok(r.bytes > 20 * MB, "the text counts too");
  assert.equal(t.m.usage(), r.bytes);
  assert.deepEqual(t.files.names(), ["acc_1/itm_1/annotations.json", "acc_1/itm_1/item.json", "acc_1/itm_1/media.mp3"]);
  assert.equal(await t.m.playable("itm_1"), "file:///app/downloads/acc_1/itm_1/media.mp3");
  const offlineItem = await t.m.answer("/api/items/itm_1");
  assert.equal((await offlineItem!.json() as ItemDetail).title, "Episode itm_1");
  assert.equal(offlineItem!.headers.get(OFFLINE_HEADER), "2026-11-05T10:00:00.000Z", "shown as this device's copy");
  assert.deepEqual(await (await t.m.answer("/api/items/itm_1/annotations"))!.json(), { itemId: "itm_1", annotations: [{ id: "ann_1" }] });
  assert.equal(await t.m.answer("/api/items/itm_2"), null);
  assert.equal(await t.m.answer("/api/bootstrap"), null);
});

test("the file is fetched from the publisher's own address; an item without media keeps its text", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  t.items.set("itm_2", detail("itm_2", { kind: "article", media: null }));
  await t.m.download("itm_1");
  await t.m.download("itm_2");
  assert.equal(t.files.downloads[0], `https://cdn.pub.example/itm_1.mp3?size=${20 * MB}`, "straight from the publisher, never through PURSS");
  assert.equal(t.m.get("itm_2")!.media, null);
  assert.equal(await t.m.playable("itm_2"), null);
  assert.deepEqual(t.m.list().map((r) => r.itemId), ["itm_2", "itm_1"], "newest first");
});

test("an article PURSS has only a summary of: its page is fetched and its article kept on this device only", async () => {
  const t = setup();
  const url = `https://pub.example/story?size=${50_000}`;
  t.items.set("itm_1", detail("itm_1", { kind: "article", media: null, url, summaryOnly: true }));
  await t.m.download("itm_1");
  const r = t.m.get("itm_1")!;
  assert.equal(r.state, "done");
  assert.deepEqual(t.files.downloads, [url], "the publisher's page, straight from the publisher");
  assert.deepEqual(t.pages, [url]);
  assert.equal(r.page?.state, "saved");
  assert.ok(r.page?.state === "saved" && r.bytes > r.page.bytes && r.page.bytes > 0, "the article counts toward the download's size");
  assert.deepEqual(t.files.names(), ["acc_1/itm_1/article.json", "acc_1/itm_1/item.json"], "the page itself isn't kept, only its article");
  const article = await t.m.article("itm_1");
  assert.equal(article?.url, url);
  assert.match(article!.html, /^<p>/);
  assert.ok(!t.calls.some((c) => c.includes("capture")), "PURSS isn't asked for a copy");
});

test("no page is fetched when PURSS has the text, or the page isn't one a device may fetch", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1", { kind: "article", media: null, url: "https://pub.example/a?size=1000", summaryOnly: false }));
  t.items.set("itm_2", detail("itm_2", { kind: "article", media: null, url: "http://pub.example/b?size=1000", summaryOnly: true }));
  t.items.set("itm_3", detail("itm_3", { kind: "article", media: null, url: "https://192.168.1.1/c?size=1000", summaryOnly: true }));
  t.items.set("itm_4", detail("itm_4", { kind: "article", media: null, url: "https://printer.local/d?size=1000", summaryOnly: true }));
  for (const id of ["itm_1", "itm_2", "itm_3", "itm_4"]) await t.m.download(id);
  assert.deepEqual(t.files.downloads, []);
  assert.ok(t.m.list().every((r) => r.state === "done" && r.page === null));
});

test("a download whose account changes while PURSS answers fetches no page and writes nothing for either account", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1", { kind: "article", media: null, url: "https://pub.example/a?size=1000", summaryOnly: true }));
  let answer!: () => void;
  t.setHold(new Promise((r) => { answer = r; }));
  const running = t.m.download("itm_1");
  while (!t.calls.length) await new Promise((r) => setTimeout(r, 0));
  t.m.setAccount("acc_2");
  t.setHold(null);
  answer();
  await running;
  assert.deepEqual(t.files.downloads, [], "the publisher's page isn't fetched");
  assert.equal(t.m.get("itm_1"), undefined);
  assert.ok(!t.files.names().some((n) => n.startsWith("acc_2/")), "nothing in the new account's folder");
});

test("a page that can't be had leaves the download with the summary and says why", async () => {
  const t = setup();
  const article = (id: string, size = 50_000) => detail(id, { kind: "article", media: null, url: `https://pub.example/${id}?size=${size}`, summaryOnly: true });
  t.items.set("itm_1", article("itm_1"));
  t.files.fail = new DownloadError(404, "gone");
  await t.m.download("itm_1");
  t.files.fail = null;
  t.items.set("itm_2", article("itm_2", 5 * MB));
  await t.m.download("itm_2");
  t.items.set("itm_3", article("itm_3"));
  t.setReadPage(async () => ({ ok: false, message: "No readable article was found." }));
  await t.m.download("itm_3");
  const pages = ["itm_1", "itm_2", "itm_3"].map((id) => t.m.get(id)!);
  assert.ok(pages.every((r) => r.state === "done"), "still downloaded, with the summary");
  assert.deepEqual(pages.map((r) => r.page), [
    { state: "failed", error: "The publisher's page isn't there any more." },
    { state: "failed", error: "The publisher's page is too large to read." },
    { state: "failed", error: "No readable article was found." },
  ]);
  assert.ok(!t.files.names().some((n) => n.endsWith("page.html") || n.endsWith("article.json")), "nothing of the pages is left");
  assert.equal(await t.m.article("itm_1"), null);
});

test("stopping a download while its page comes in keeps nothing", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1", { kind: "article", media: null, url: `https://pub.example/a?size=${400_000}`, summaryOnly: true }));
  let release!: () => void;
  t.files.halfway = new Promise((r) => { release = r; });
  const running = t.m.download("itm_1");
  await new Promise((r) => setTimeout(r, 0));
  await t.m.cancel("itm_1");
  release();
  await running;
  assert.equal(t.m.get("itm_1"), undefined);
  assert.deepEqual(t.files.names(), []);
  assert.deepEqual(t.pages, [], "nothing was read");
});

test("failures leave nothing behind and say why in plain words", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  t.files.fail = new DownloadError(404, "nope");
  await t.m.download("itm_1");
  assert.equal(t.m.get("itm_1")!.state, "failed");
  assert.match(t.m.get("itm_1")!.error!, /isn't available there any more/);
  assert.deepEqual(t.files.names(), []);
  assert.equal(t.m.usage(), 0);
  t.files.fail = null;
  t.items.set("itm_2", detail("itm_2", { media: { ...detail("x").media!, url: "http://plain.example/a.mp3" } }));
  await t.m.download("itm_2");
  assert.match(t.m.get("itm_2")!.error!, /secure connection/, "a publisher's file only over https");
  await t.m.download("itm_1");
  assert.equal(t.m.get("itm_1")!.state, "done", "trying again works");
  await t.m.download("itm_9");
  assert.match(t.m.get("itm_9")!.error!, /isn't in your PURSS/);
});

test("a download that was running when the app stopped shows as not finished", () => {
  const t = setup();
  t.store.set("purss:downloads:account:acc_2", JSON.stringify([{ itemId: "itm_1", state: "downloading", bytes: 0 }]));
  const m2 = new DownloadManager({ files: t.files, get: async () => { throw new Error(); }, plan: async () => { throw new Error(); }, connection: async () => "wifi", readPage: async () => ({ ok: false, message: "" }), store: t.store });
  m2.setAccount("acc_2");
  assert.equal(m2.get("itm_1")!.state, "failed");
});

test("automatic downloads: To read episodes on Wi-Fi, within the limit, never on mobile data when Wi-Fi only", async () => {
  const t = setup();
  for (const id of ["itm_1", "itm_2", "itm_3"]) t.items.set(id, detail(id));
  t.lists.toread = ["itm_1", "itm_2", "itm_3"];
  t.m.updateSettings({ autoToRead: true, limitBytes: 50 * MB });
  t.setConnection("cellular");
  await t.m.sync();
  assert.equal(t.m.list().length, 0);
  assert.equal(t.plans.length, 0, "not even asked on mobile data");
  t.setConnection("wifi");
  await t.m.sync();
  assert.deepEqual(t.m.list().filter((r) => r.state === "done").map((r) => [r.itemId, r.origin]), [["itm_2", "auto"], ["itm_1", "auto"]], "two of 20 MB fit under 50 MB");
  assert.deepEqual(t.plans.at(-1), { autoToRead: true, limitBytes: 50 * MB, usedBytes: 0, have: [] });
  assert.ok(t.m.usage() <= 50 * MB);
});

test("an automatic download that turns out bigger than declared stops once it outgrows the room left; one by hand goes ahead", async () => {
  const t = setup();
  t.items.set("itm_0", detail("itm_0", { media: { ...detail("x").media!, url: `https://cdn.pub.example/b.mp3?size=${20 * MB}`, length: 20 * MB } }));
  await t.m.download("itm_0");
  t.items.set("itm_1", detail("itm_1", { media: { ...detail("x").media!, url: `https://cdn.pub.example/a.mp3?size=${80 * MB}`, length: 10 * MB } }));
  t.lists.toread = ["itm_1"];
  t.m.updateSettings({ autoToRead: true, limitBytes: 50 * MB });
  await t.m.sync();
  assert.equal(t.files.received, 40 * MB, "stopped at the first progress past the 30 MB left, not at the end");
  assert.equal(t.m.get("itm_1")!.state, "failed");
  assert.match(t.m.get("itm_1")!.error!, /bigger than the space left/);
  assert.ok(!t.files.names().some((n) => n.includes("itm_1")));
  await t.m.download("itm_1");
  assert.equal(t.m.get("itm_1")!.state, "done", "a download you ask for goes ahead");
});

test("a file declared larger than allowed isn't fetched, and one the server declares too large stops at once", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1", { media: { ...detail("x").media!, length: MAX_DOWNLOAD_BYTES + 1 } }));
  await t.m.download("itm_1");
  assert.deepEqual(t.files.downloads, []);
  assert.match(t.m.get("itm_1")!.error!, /over 4 GB/);
  t.items.set("itm_2", detail("itm_2", { media: { ...detail("x").media!, url: `https://cdn.pub.example/a.mp3?size=${80 * MB}`, length: null } }));
  t.m.updateSettings({ limitBytes: 50 * MB });
  t.files.declareSize = true;
  await t.m.download("itm_2", "auto");
  assert.equal(t.files.received, 20 * MB, "stopped at the first progress, which declared 80 MB");
  assert.equal(t.m.get("itm_2")!.state, "failed");
});

test("progress reports the whole size: the feed's declared size until the publisher's server says, and none when neither does", async () => {
  const t = setup();
  const seen: DownloadProgress[] = [];
  t.m.subscribe(() => { const p = t.m.progress("itm_1") ?? t.m.progress("itm_2") ?? t.m.progress("itm_3"); if (p) seen.push(p); });
  t.items.set("itm_1", detail("itm_1"));
  await t.m.download("itm_1");
  assert.deepEqual(seen.at(-1), { bytes: 20 * MB, total: 20 * MB }, "the feed declared 20 MB");
  assert.equal(t.m.progress("itm_1"), null, "nothing in progress once done");
  t.files.declareSize = true;
  t.items.set("itm_2", detail("itm_2", { media: { url: `https://cdn.pub.example/itm_2.mp3?size=${8 * MB}`, kind: "audio", type: "audio/mpeg", length: 5 * MB } }));
  seen.length = 0;
  await t.m.download("itm_2");
  assert.deepEqual(seen.at(-1), { bytes: 8 * MB, total: 8 * MB }, "the server's size wins over the feed's");
  t.files.declareSize = false;
  t.items.set("itm_3", detail("itm_3", { media: { url: `https://cdn.pub.example/itm_3.mp3?size=${4 * MB}`, kind: "audio", type: "audio/mpeg", length: null } }));
  seen.length = 0;
  await t.m.download("itm_3");
  assert.ok(seen.length > 0 && seen.every((p) => p.total === null), "unknown size: no total");
});

test("removing all downloads stops the one in progress, and nothing of it is kept or recorded", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  let release!: () => void;
  t.files.halfway = new Promise((r) => { release = r; });
  const running = t.m.download("itm_1");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.m.progress("itm_1"), { bytes: 10 * MB, total: 20 * MB });
  await t.m.removeAll();
  release();
  await running;
  assert.equal(t.files.received, 10 * MB, "the transfer stopped halfway");
  assert.equal(t.m.list().length, 0);
  assert.deepEqual(t.files.names(), []);
  assert.ok(![...t.store.map.keys()].some((k) => k.startsWith("purss:downloads:account:")), "no record written after removal");
});

test("files no download accounts for are removed when the account is set", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  await t.m.download("itm_1");
  await t.files.writeText("acc_1/itm_late/media.mp3", "a transfer that finished after a disconnect");
  await t.files.writeText("acc_9/itm_x/item.json", "{}");
  t.m.setAccount(null);
  t.m.setAccount("acc_1");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.files.names(), ["acc_1/itm_1/item.json", "acc_1/itm_1/media.mp3"]);
});

test("keeping in step: refreshed text, removed when the item is gone, and when finished if asked", async () => {
  const t = setup();
  for (const id of ["itm_1", "itm_2", "itm_3"]) t.items.set(id, detail(id));
  for (const id of ["itm_1", "itm_2", "itm_3"]) await t.m.download(id);
  t.items.set("itm_1", detail("itm_1", { title: "Renamed" }));
  t.items.delete("itm_2");
  t.items.set("itm_3", detail("itm_3", { playback: { positionSeconds: 595, durationSeconds: 600, updatedAt: "" } }));
  await t.m.sync();
  assert.equal(t.m.get("itm_1")!.title, "Renamed");
  assert.equal(t.m.get("itm_2"), undefined, "deleted in PURSS, so gone from the device");
  assert.equal(t.m.get("itm_3")!.state, "done", "finished, but cleanup is off");
  t.m.updateSettings({ removeFinished: true });
  await t.m.sync();
  assert.equal(t.m.get("itm_3"), undefined);
  assert.ok(!t.files.names().some((n) => n.includes("itm_3")));
  t.setOffline(true);
  await t.m.sync();
  assert.equal(t.m.get("itm_1")!.state, "done", "offline: nothing is removed");
});

test("downloads belong to one account: another account's are removed, and removing all empties the folder", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  await t.m.download("itm_1");
  t.m.setAccount(null);
  assert.equal(t.m.list().length, 0);
  t.m.setAccount("acc_1");
  assert.equal(t.m.list().length, 1, "signing back in to the same account keeps them");
  t.m.setAccount("acc_2");
  assert.equal(t.m.list().length, 0);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.files.names(), [], "the other account's files are deleted");
  assert.ok(![...t.store.map.keys()].some((k) => k.endsWith("acc_1")));
  t.items.set("itm_2", detail("itm_2"));
  await t.m.download("itm_2");
  await t.m.removeAll();
  assert.equal(t.m.usage(), 0);
  assert.deepEqual(t.files.names(), []);
});

test("the background job's state is mirrored whenever downloads or their settings change, and cleared without an account", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  t.m.updateSettings({ autoToRead: true });
  assert.deepEqual(t.mirrored.at(-1), { accountId: "acc_1", settings: { ...t.m.settings() }, have: [], usedBytes: 0 });
  assert.equal(t.mirrored.at(-1)!.settings.autoToRead, true);
  await t.m.download("itm_1");
  assert.deepEqual(t.mirrored.at(-1)!.have, ["itm_1"]);
  assert.equal(t.mirrored.at(-1)!.usedBytes, t.m.usage());
  await t.m.removeAll();
  assert.deepEqual([t.mirrored.at(-1)!.have, t.mirrored.at(-1)!.usedBytes], [[], 0]);
  t.m.setAccount(null);
  assert.equal(t.mirrored.at(-1), null);
});

const bgRecord = (itemId: string, over: Record<string, unknown> = {}) => JSON.stringify({
  itemId, title: `Episode ${itemId}`, sourceTitle: "Slow Radio", kind: "podcast", state: "done", status: null,
  media: { file: `acc_1/${itemId}/media.mp3`, bytes: 20 * MB, type: "audio/mpeg", kind: "audio" }, textBytes: 1000, savedAt: "2026-11-05T03:00:00.000Z", ...over,
});

test("what the background job downloaded while the app was closed is adopted: downloaded, counted, playable and readable", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  await t.m.download("itm_1");
  await t.files.writeText("acc_1/itm_2/item.json", JSON.stringify(detail("itm_2")));
  t.files.files.set("acc_1/itm_2/media.mp3", { bytes: 20 * MB });
  await t.files.writeText("acc_1/itm_2/record.json", bgRecord("itm_2"));
  await t.files.writeText("acc_1/itm_3/record.json", bgRecord("itm_3", { state: "failed", status: -2, media: null, textBytes: 0 }));
  await t.files.writeText("acc_1/itm_4/media.mp3", "a folder the job never finished: no record");
  await t.files.writeText("acc_1/itm_5/record.json", bgRecord("itm_5", { media: { file: "acc_1/itm_1/media.mp3", bytes: 1, type: null, kind: "audio" } }));
  t.m.setAccount(null);
  t.m.setAccount("acc_1");
  await new Promise((r) => setTimeout(r, 0));
  const r = t.m.get("itm_2")!;
  assert.deepEqual([r.state, r.origin, r.title, r.bytes], ["done", "auto", "Episode itm_2", 20 * MB + 1000]);
  assert.equal(await t.m.playable("itm_2"), "file:///app/downloads/acc_1/itm_2/media.mp3");
  assert.equal((await (await t.m.answer("/api/items/itm_2"))!.json() as ItemDetail).title, "Episode itm_2");
  assert.equal(t.m.usage(), t.m.get("itm_1")!.bytes + 20 * MB + 1000, "counts toward the device's total");
  assert.equal(t.m.get("itm_3")!.state, "failed");
  assert.match(t.m.get("itm_3")!.error!, /bigger than the space left/);
  assert.equal(t.m.get("itm_4"), undefined);
  assert.equal(t.m.get("itm_5"), undefined, "a record pointing outside its own folder is refused");
  assert.ok(!t.files.names().some((n) => n.startsWith("acc_1/itm_4/") || n.startsWith("acc_1/itm_5/")), "unfinished and damaged folders are swept");
  assert.deepEqual([...t.mirrored.at(-1)!.have].sort(), ["itm_1", "itm_2", "itm_3"], "the job won't fetch them again");
});

test("adopted downloads follow the same cleanup: removed when finished, and when gone from PURSS", async () => {
  const t = setup();
  t.items.set("itm_2", detail("itm_2", { workflow: "finished" }));
  await t.files.writeText("acc_1/itm_2/item.json", JSON.stringify(detail("itm_2")));
  await t.files.writeText("acc_1/itm_2/record.json", bgRecord("itm_2"));
  await t.files.writeText("acc_1/itm_3/record.json", bgRecord("itm_3"));
  t.m.updateSettings({ removeFinished: true });
  await t.m.sync();
  assert.equal(t.m.get("itm_2"), undefined);
  assert.equal(t.m.get("itm_3"), undefined);
  assert.deepEqual(t.files.names(), []);
});

test("stopping one download ends its transfer and keeps nothing of it; the next download goes ahead", async () => {
  const t = setup();
  t.items.set("itm_1", detail("itm_1"));
  t.items.set("itm_2", detail("itm_2"));
  let release!: () => void;
  t.files.halfway = new Promise((r) => { release = r; });
  const running = t.m.download("itm_1");
  const next = t.m.download("itm_2");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.m.get("itm_1")!.state, "downloading");
  await t.m.cancel("itm_1");
  t.files.halfway = null;
  release();
  await running;
  assert.equal(t.files.received, 10 * MB, "the transfer stopped halfway");
  assert.equal(t.m.get("itm_1"), undefined, "no record");
  assert.ok(!t.files.names().some((n) => n.includes("itm_1")), "no files");
  await next;
  assert.equal(t.m.get("itm_2")!.state, "done");
  await t.m.cancel("itm_9");
  await t.m.download("itm_1");
  assert.equal(t.m.get("itm_1")!.state, "done", "downloading it again later works");
});

test("downloads waiting their turn show as queued; one taken out of the queue never runs, and the rest go ahead in order", async () => {
  const t = setup();
  for (const id of ["itm_1", "itm_2", "itm_3"]) t.items.set(id, detail(id));
  let release!: () => void;
  t.files.halfway = new Promise((r) => { release = r; });
  let heard = 0;
  t.m.subscribe(() => { heard++; });
  const first = t.m.download("itm_1");
  assert.equal(t.m.queued("itm_1"), true, "queued until its turn comes");
  const second = t.m.download("itm_2");
  const third = t.m.download("itm_3");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.m.queued("itm_1"), false, "running, no longer queued");
  assert.equal(t.m.get("itm_1")!.state, "downloading");
  assert.deepEqual([t.m.queued("itm_2"), t.m.queued("itm_3")], [true, true]);
  assert.equal(t.m.get("itm_2"), undefined, "a queued download has no record yet");
  assert.equal(t.m.download("itm_2"), t.m.download("itm_2"), "asking again doesn't queue it twice");
  const before = heard;
  await t.m.cancel("itm_2");
  assert.equal(t.m.queued("itm_2"), false);
  assert.ok(heard > before, "taking it out of the queue is heard");
  t.files.halfway = null;
  release();
  await Promise.all([first, second, third]);
  assert.equal(t.m.get("itm_1")!.state, "done");
  assert.equal(t.m.get("itm_2"), undefined, "taken out of the queue: never downloaded");
  assert.ok(!t.files.downloads.some((u) => u.includes("itm_2")), "its file was never fetched");
  assert.equal(t.m.get("itm_3")!.state, "done");
  assert.equal(t.m.queued("itm_3"), false);
});

test("the queue empties when the account changes or everything is removed", async () => {
  const t = setup();
  for (const id of ["itm_1", "itm_2", "itm_3"]) t.items.set(id, detail(id));
  let release!: () => void;
  t.files.halfway = new Promise((r) => { release = r; });
  const first = t.m.download("itm_1");
  const second = t.m.download("itm_2");
  await new Promise((r) => setTimeout(r, 0));
  t.m.setAccount("acc_2");
  assert.equal(t.m.queued("itm_2"), false);
  const third = t.m.download("itm_3");
  await t.m.removeAll();
  assert.equal(t.m.queued("itm_3"), false);
  t.files.halfway = null;
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(t.m.list(), [], "nothing queued before ran afterwards");
  assert.ok(!t.files.downloads.some((u) => u.includes("itm_2") || u.includes("itm_3")));
});
