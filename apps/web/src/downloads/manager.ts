import type { AnnotationList, DeviceConnection, DownloadPlan, DownloadPlanRequest, DownloadSettings, ItemDetail } from "@purss/domain";
import { connectionAllows, fitsAfterDownload, MAX_DOWNLOAD_BYTES, mediaToDownload, pageToDownload, parseDownloadSettings, publisherFileAllowed, removeWhenFinished } from "@purss/domain";
import { OFFLINE_HEADER } from "../sw/protocol.ts";
import { BACKGROUND_RECORD, parseBackgroundRecord } from "./background.ts";
import type { BackgroundState } from "./background.ts";
import { PAGE_MAX_BYTES } from "./readable-page.ts";
import type { ReadableArticle } from "./readable-page.ts";
import type { DeviceArticle, DeviceDownloads, DownloadOrigin, DownloadProgress, DownloadRecord } from "./types.ts";

/**
 * Downloads on this device (plan/31): one item at a time, kept per account in the app's own storage.
 * The media file always comes from the publisher; the server keeps none. Everything that touches the
 * device or the network is passed in, so the rules and their order can be tested without a phone.
 * While the app is closed, the native background job (plan/38) downloads by the same plan and leaves
 * records this manager adopts.
 */

/** Files under the app's downloads folder; names are relative to it. */
export interface DeviceFiles {
  /**
   * Fetch an address into a file; resolves with its size. Rejects with a DownloadError, or at once when
   * `signal` aborts (the partial file is removed). `onProgress` hears the bytes so far and, when the
   * server declared it, the file's whole size.
   */
  download(url: string, name: string, onProgress: (bytes: number, total: number | null) => void, signal: AbortSignal): Promise<number>;
  /** The names in a folder (files and folders); none when it isn't there. */
  list(name: string): Promise<string[]>;
  /** Write text; resolves with its size in bytes. */
  writeText(name: string, text: string): Promise<number>;
  readText(name: string): Promise<string | null>;
  /** A file's bytes, or null when it isn't there. */
  readBytes(name: string): Promise<Uint8Array | null>;
  /** Remove a file or a folder with everything in it; nothing there is fine. */
  remove(name: string): Promise<void>;
  /** An address the native player can open for a file. */
  uri(name: string): Promise<string>;
}

/** A failed fetch: `status` is the server's answer, 0 when the connection failed. */
export class DownloadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "DownloadError"; this.status = status; }
}

export type KeyValue = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void; keys(): string[] };

export type ManagerDeps = {
  files: DeviceFiles;
  /** GET an API path (the app's API client, which adds the device token). */
  get: <T>(path: string, query?: Record<string, string | number>, headers?: Record<string, string>) => Promise<T>;
  /** Ask PURSS what to download automatically (POST /api/downloads/plan). */
  plan: (request: DownloadPlanRequest) => Promise<DownloadPlan>;
  connection: () => Promise<DeviceConnection>;
  /** The readable article of a publisher's page (its bytes, and the address it came from); see readable-page.ts. */
  readPage: (page: Uint8Array, url: string) => Promise<ReadableArticle>;
  store: KeyValue;
  /** Tell the native background job what it needs (null: nothing to do, no account). */
  mirror?: (state: BackgroundState | null) => void;
  now?: () => number;
};

const SETTINGS_KEY = "purss:downloads:settings";
const RECORDS_PREFIX = "purss:downloads:account:";
const ITEM_PATH = /^\/api\/items\/([^/?]+)(\/annotations)?$/;

const TOO_LARGE_AUTO = "The file is bigger than the space left in this device's automatic download limit.";

/** Plain words for a failed download. */
export function failureText(err: unknown): string {
  if (err instanceof DownloadError) {
    if (err.status === -1) return "The publisher doesn't offer this file over a secure connection, so it can't be downloaded.";
    if (err.status === -2) return TOO_LARGE_AUTO;
    if (err.status === 0) return "The download stopped before it finished. Check your connection and try again.";
    if (err.status === 404 || err.status === 410) return "The file isn't available there any more.";
    if (err.status === 401 || err.status === 403) return "The file's address refused the download.";
    return "The download didn't finish. Try again later.";
  }
  const status = (err as { status?: unknown })?.status;
  if (status === 404) return "This item isn't in your PURSS any more.";
  if ((err as { code?: unknown })?.code === "offline") return "Can't reach PURSS right now. Check your connection and try again.";
  return "The download didn't finish. Try again later.";
}

/** Plain words for a publisher's page that couldn't be fetched for its article. */
function pageFailureText(err: unknown): string {
  const status = err instanceof DownloadError ? err.status : 0;
  if (status === 404 || status === 410) return "The publisher's page isn't there any more.";
  if (status === 401 || status === 403) return "The publisher's page needs a login or turns apps away.";
  if (status === 0) return "Couldn't reach the publisher's page. Check your connection and try again.";
  return "The publisher's page couldn't be fetched.";
}

const pageBytes = (page: DownloadRecord["page"]) => (page?.state === "saved" ? page.bytes : 0);

export class DownloadManager implements DeviceDownloads {
  private readonly deps: ManagerDeps;
  private readonly now: () => number;
  private account: string | null = null;
  private records: DownloadRecord[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly running = new Map<string, DownloadProgress>();
  /** Downloads asked for that wait their turn behind the one in progress. */
  private readonly waiting = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private syncing: Promise<void> | null = null;
  /** Transfers in progress; aborted when the account changes or everything is removed. */
  private readonly transfers = new Map<string, AbortController>();
  /** Downloads asked to stop (cancel); they end without a record or files. */
  private readonly stopping = new Set<string>();
  /** Bumped by removeAll, so a download that was running then records nothing afterwards. */
  private epoch = 0;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  // ---------- state ----------

  setAccount(accountId: string | null): void {
    if (accountId === this.account) return;
    this.cancelTransfers();
    this.account = accountId;
    this.records = accountId ? this.load(accountId) : [];
    if (!accountId) { this.mirror(); this.emit(); return; }
    // One account's downloads never stay on a device another account uses.
    for (const key of this.deps.store.keys()) {
      if (key.startsWith(RECORDS_PREFIX) && key !== RECORDS_PREFIX + accountId) this.deps.store.remove(key);
    }
    this.mirror();
    void this.adopt(accountId).then(() => this.sweep(accountId)).catch(() => undefined);
    this.emit();
  }

  /**
   * Take in what the background job downloaded while the app was closed: a folder of this account
   * that no record accounts for, with the job's record.json written last. A damaged one is swept.
   */
  private async adopt(accountId: string): Promise<void> {
    let changed = false;
    for (const name of await this.deps.files.list(accountId)) {
      if (this.account !== accountId) return;
      if (this.get(name) || this.running.has(name)) continue;
      const r = parseBackgroundRecord(await this.deps.files.readText(`${accountId}/${name}/${BACKGROUND_RECORD}`), accountId, name);
      if (!r || this.account !== accountId || this.get(name)) continue;
      const error = r.state === "failed" ? failureText(new DownloadError(r.status ?? 0, "background")) : null;
      this.records = [{
        itemId: r.itemId, title: r.title, sourceTitle: r.sourceTitle, kind: r.kind, origin: "auto", state: r.state, error,
        media: r.media, page: null, bytes: r.state === "done" ? (r.media?.bytes ?? 0) + r.textBytes : 0, savedAt: r.savedAt,
      }, ...this.records];
      changed = true;
    }
    if (changed) { this.persist(); this.emit(); }
  }

  /**
   * Remove files no download record accounts for: other accounts' folders, and items of this account
   * that aren't downloaded (a transfer cut off when the app was stopped leaves its partial file, and a
   * background download the page couldn't adopt leaves its folder).
   */
  private async sweep(accountId: string): Promise<void> {
    for (const name of await this.deps.files.list("")) if (name !== accountId) await this.deps.files.remove(name);
    for (const name of await this.deps.files.list(accountId)) {
      if (this.account === accountId && this.get(name)?.state !== "done" && !this.running.has(name)) await this.deps.files.remove(`${accountId}/${name}`);
    }
  }

  private cancelTransfers(): void {
    this.waiting.clear();
    for (const t of this.transfers.values()) t.abort();
    this.transfers.clear();
  }

  private load(accountId: string): DownloadRecord[] {
    try {
      const v = JSON.parse(this.deps.store.get(RECORDS_PREFIX + accountId) ?? "[]") as DownloadRecord[];
      // A download that was running when the app stopped didn't finish.
      return Array.isArray(v) ? v.map((r) => ({ ...r, page: r.page ?? null })).map((r) => (r.state === "downloading" ? { ...r, state: "failed" as const, error: "The download stopped before it finished. Try again." } : r)) : [];
    } catch { return []; }
  }

  private persist(): void {
    if (this.account) this.deps.store.set(RECORDS_PREFIX + this.account, JSON.stringify(this.records));
    this.mirror();
  }

  private mirror(): void {
    if (!this.deps.mirror) return;
    this.deps.mirror(this.account ? { accountId: this.account, settings: this.settings(), have: this.records.map((r) => r.itemId), usedBytes: this.usage() } : null);
  }

  private emit(): void { for (const l of this.listeners) l(); }

  private put(record: DownloadRecord): void {
    this.records = [record, ...this.records.filter((r) => r.itemId !== record.itemId)];
    this.persist();
    this.emit();
  }

  list(): readonly DownloadRecord[] { return this.records; }
  get(itemId: string): DownloadRecord | undefined { return this.records.find((r) => r.itemId === itemId); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  progress(itemId: string): DownloadProgress | null { return this.running.get(itemId) ?? null; }
  queued(itemId: string): boolean { return this.waiting.has(itemId); }
  usage(): number { return this.records.reduce((n, r) => n + r.bytes, 0); }

  settings(): DownloadSettings { return parseDownloadSettings(this.deps.store.get(SETTINGS_KEY)); }
  updateSettings(patch: Partial<DownloadSettings>): void {
    this.deps.store.set(SETTINGS_KEY, JSON.stringify({ ...this.settings(), ...patch }));
    this.mirror();
    this.emit();
  }

  // ---------- downloading ----------

  /** Downloads run one at a time, in the order asked; one taken out of the queue (cancel) before its turn doesn't run. */
  download(itemId: string, origin: DownloadOrigin = "manual"): Promise<void> {
    if (this.waiting.has(itemId)) return this.queue;
    const account = this.account;
    this.waiting.add(itemId);
    this.emit();
    const run = this.queue.then(() => {
      if (!this.waiting.delete(itemId) || this.account !== account) return;
      return this.fetchItem(itemId, origin);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private folder(itemId: string): string { return `${this.account}/${itemId}`; }

  private async fetchItem(itemId: string, origin: DownloadOrigin): Promise<void> {
    const account = this.account;
    const epoch = this.epoch;
    if (!account) return;
    const current = () => this.account === account && this.epoch === epoch && !this.stopping.has(itemId);
    const existing = this.get(itemId);
    if (existing?.state === "done") return;
    const started: DownloadRecord = { itemId, title: existing?.title ?? "", sourceTitle: existing?.sourceTitle ?? "", kind: existing?.kind ?? "article", origin, state: "downloading", error: null, media: null, page: null, bytes: 0, savedAt: new Date(this.now()).toISOString() };
    this.put(started);
    this.running.set(itemId, { bytes: 0, total: null });
    const folder = this.folder(itemId);
    // An automatic download stays within the room left under the limit; none is larger than MAX_DOWNLOAD_BYTES.
    const max = Math.min(MAX_DOWNLOAD_BYTES, origin === "auto" ? Math.max(0, this.settings().limitBytes - this.usage()) : Infinity);
    let tooLarge = false;
    const transfer = new AbortController();
    try {
      const detail = await this.deps.get<ItemDetail>(`/api/items/${encodeURIComponent(itemId)}`);
      if (!current()) return;
      this.put({ ...started, title: detail.title, sourceTitle: detail.sourceTitle, kind: detail.kind });
      let media: DownloadRecord["media"] = null;
      if (detail.media) {
        const want = mediaToDownload(detail.media);
        const url = want.url;
        // The file comes straight from the publisher; only over a secure connection, as the web player does.
        if (!publisherFileAllowed(url)) throw new DownloadError(-1, "insecure");
        const type = want.type;
        const file = `${folder}/${want.file}`;
        const declared = want.declaredBytes;
        if (declared && declared > max) { tooLarge = true; throw new DownloadError(-2, "too large"); }
        // The feed's declared size stands in for the whole until the publisher's server says.
        this.running.set(itemId, { bytes: 0, total: declared });
        this.emit();
        if (!current()) return;
        this.transfers.set(itemId, transfer);
        const bytes = await this.deps.files.download(url, file, (n, total) => {
          // Stop as soon as the file is known to be, or has become, larger than allowed.
          if (n > max || (total !== null && total > max)) { tooLarge = true; transfer.abort(); return; }
          this.running.set(itemId, { bytes: n, total: total ?? declared });
          this.emit();
        }, transfer.signal);
        if (bytes > max) { tooLarge = true; throw new DownloadError(-2, "too large"); }
        if (!current()) { await this.deps.files.remove(folder); return; }
        media = { file, bytes, type, kind: detail.media.kind };
      }
      // PURSS has only the feed's summary: the article comes from the publisher's page, kept on this device only.
      const pageUrl = pageToDownload(detail);
      const page = pageUrl ? await this.fetchPage(itemId, folder, pageUrl, transfer) : null;
      if (!current()) { await this.deps.files.remove(folder); return; }
      const text = await this.writeText(itemId, detail);
      if (!current()) { await this.deps.files.remove(folder); return; }
      const done: DownloadRecord = { ...started, title: detail.title, sourceTitle: detail.sourceTitle, kind: detail.kind, state: "done", media, page, bytes: (media?.bytes ?? 0) + pageBytes(page) + text, savedAt: new Date(this.now()).toISOString() };
      this.put(done);
      // An automatic download that turned out bigger than expected doesn't stay above the limit.
      if (origin === "auto" && !fitsAfterDownload(this.settings(), this.usage())) await this.remove(itemId);
    } catch (err) {
      await this.deps.files.remove(folder).catch(() => undefined);
      if (!current()) return;
      const error = tooLarge
        ? origin === "auto"
          ? TOO_LARGE_AUTO
          : `The file is over ${Math.round(MAX_DOWNLOAD_BYTES / 1024 ** 3)} GB, the most this app downloads.`
        : failureText(err);
      this.put({ ...(this.get(itemId) ?? started), state: "failed", error, media: null, bytes: 0 });
    } finally {
      this.transfers.delete(itemId);
      this.running.delete(itemId);
      // Stopped by hand: nothing of it stays, not even a record.
      if (this.stopping.delete(itemId) && this.account === account && this.epoch === epoch) {
        this.records = this.records.filter((r) => r.itemId !== itemId);
        this.persist();
        await this.deps.files.remove(folder).catch(() => undefined);
      }
      this.emit();
    }
  }

  /**
   * Fetch the publisher's page and keep its readable article as `article.json`. A page that can't be had
   * leaves the download with the summary and says why; stopping the download stops this too (it throws).
   */
  private async fetchPage(itemId: string, folder: string, url: string, transfer: AbortController): Promise<NonNullable<DownloadRecord["page"]>> {
    const file = `${folder}/page.html`;
    let tooLarge = false;
    try {
      this.transfers.set(itemId, transfer);
      await this.deps.files.download(url, file, (n, total) => {
        if (n > PAGE_MAX_BYTES || (total !== null && total > PAGE_MAX_BYTES)) { tooLarge = true; transfer.abort(); return; }
        this.running.set(itemId, { bytes: n, total });
        this.emit();
      }, transfer.signal);
      const bytes = await this.deps.files.readBytes(file);
      await this.deps.files.remove(file);
      if (!bytes) return { state: "failed", error: "The publisher's page couldn't be fetched." };
      const article = await this.deps.readPage(bytes, url);
      if (!article.ok) return { state: "failed", error: article.message };
      const saved: DeviceArticle = { title: article.title, html: article.html, url, savedAt: new Date(this.now()).toISOString() };
      return { state: "saved", bytes: await this.deps.files.writeText(`${folder}/article.json`, JSON.stringify(saved)) };
    } catch (err) {
      await this.deps.files.remove(file).catch(() => undefined);
      if (transfer.signal.aborted && !tooLarge) throw err;
      return { state: "failed", error: tooLarge ? "The publisher's page is too large to read." : pageFailureText(err) };
    }
  }

  /**
   * Take an item out of the queue, or stop its download in progress: its transfer stops on the wire and
   * nothing of it is kept.
   */
  async cancel(itemId: string): Promise<void> {
    if (this.waiting.delete(itemId)) { this.emit(); return; }
    if (!this.running.has(itemId)) return;
    this.stopping.add(itemId);
    this.transfers.get(itemId)?.abort();
    this.emit();
  }

  /** Save the item's details and its highlights and notes; returns their size. */
  private async writeText(itemId: string, detail: ItemDetail): Promise<number> {
    const folder = this.folder(itemId);
    let bytes = await this.deps.files.writeText(`${folder}/item.json`, JSON.stringify(detail));
    if (detail.annotatedAt) {
      const list = await this.deps.get<AnnotationList>(`/api/items/${encodeURIComponent(itemId)}/annotations`);
      bytes += await this.deps.files.writeText(`${folder}/annotations.json`, JSON.stringify(list));
    } else {
      await this.deps.files.remove(`${folder}/annotations.json`);
    }
    return bytes;
  }

  async remove(itemId: string): Promise<void> {
    const r = this.get(itemId);
    if (!r || !this.account) return;
    this.records = this.records.filter((x) => x.itemId !== itemId);
    this.persist();
    this.emit();
    await this.deps.files.remove(this.folder(itemId)).catch(() => undefined);
  }

  /** Also stops a download in progress; nothing of it is kept. */
  async removeAll(): Promise<void> {
    this.epoch++;
    this.cancelTransfers();
    for (const key of this.deps.store.keys()) if (key.startsWith(RECORDS_PREFIX)) this.deps.store.remove(key);
    this.records = [];
    this.mirror();
    this.emit();
    await this.deps.files.remove("").catch(() => undefined);
  }

  // ---------- reading downloaded copies ----------

  async playable(itemId: string): Promise<string | null> {
    const r = this.get(itemId);
    if (r?.state !== "done" || !r.media) return null;
    return this.deps.files.uri(r.media.file);
  }

  async article(itemId: string): Promise<DeviceArticle | null> {
    const r = this.get(itemId);
    if (r?.state !== "done" || r.page?.state !== "saved") return null;
    const text = await this.deps.files.readText(`${this.folder(itemId)}/article.json`);
    if (text === null) return null;
    try { return JSON.parse(text) as DeviceArticle; } catch { return null; }
  }

  async answer(path: string): Promise<Response | null> {
    const m = ITEM_PATH.exec(path);
    if (!m) return null;
    const itemId = decodeURIComponent(m[1]!);
    const r = this.get(itemId);
    if (r?.state !== "done") return null;
    const text = await this.deps.files.readText(`${this.folder(itemId)}/${m[2] ? "annotations.json" : "item.json"}`);
    if (text === null) return null;
    return new Response(text, { status: 200, headers: { "content-type": "application/json", [OFFLINE_HEADER]: r.savedAt } });
  }

  // ---------- keeping in step ----------

  /** One pass at a time: refresh what is downloaded, remove what is finished or gone, then download what the settings ask for. */
  sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    const account = this.account;
    if (!account) return;
    const settings = this.settings();
    for (const r of [...this.records]) {
      if (r.state !== "done" || this.account !== account) continue;
      let detail: ItemDetail;
      try {
        detail = await this.deps.get<ItemDetail>(`/api/items/${encodeURIComponent(r.itemId)}`);
      } catch (err) {
        if ((err as { status?: unknown }).status === 404) { await this.remove(r.itemId); continue; }
        return; // offline or the server is busy: try again next time
      }
      if (removeWhenFinished(settings, r.state, detail)) { await this.remove(r.itemId); continue; }
      try {
        const text = await this.writeText(r.itemId, detail);
        if (this.account === account && this.get(r.itemId)) this.put({ ...r, title: detail.title, sourceTitle: detail.sourceTitle, bytes: (r.media?.bytes ?? 0) + pageBytes(r.page) + text, savedAt: new Date(this.now()).toISOString() });
      } catch { return; }
    }
    await this.adopt(account);
    if (!settings.autoToRead) return;
    if (!connectionAllows(settings, await this.deps.connection())) return;
    // PURSS applies the shared rules (as for the background job). Everything with a record
    // counts as had: a download that failed is tried again only by hand, so a broken file isn't
    // fetched over and over.
    let plan: DownloadPlan;
    try {
      plan = await this.deps.plan({ autoToRead: settings.autoToRead, limitBytes: settings.limitBytes, usedBytes: this.usage(), have: this.records.map((r) => r.itemId) });
    } catch { return; }
    for (const { id } of plan.items) {
      if (this.account !== account) return;
      if (this.get(id)) continue;
      await this.download(id, "auto");
    }
  }
}
