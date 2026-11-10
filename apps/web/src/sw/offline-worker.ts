import { APP_PATH } from "@purss/domain/paths";
import { copiesToEvict } from "./policy.ts";
import type { Copy, RouteClass } from "./policy.ts";
import {
  EMPTY_STATE, MAX_COPIES, NETWORK_TIMEOUT_MS, OFFLINE_HEADER, SAVED_HEADER, STATE_CACHE, STATE_URL,
  dataCacheName, foreignDataCaches, isDataCache, parseWorkerState, shellCacheName, staleShellCaches,
} from "./protocol.ts";
import type { PageMessage, WorkerState } from "./protocol.ts";
import type { CacheStorageLike } from "./cache-types.ts";

/**
 * The worker's behaviour, free of the worker event API so it can be tested: what to keep, when to
 * serve a saved copy, and when to forget. `sw.ts` wires it to the browser's events.
 *
 * Personal data (answers from /api) is kept only while offline reading is on for this device and an
 * account is known, in a cache that belongs to that account. The app shell holds no personal data.
 */
export type Env = {
  caches: CacheStorageLike;
  fetch: (request: Request) => Promise<Response>;
  now: () => number;
  /** The site's origin; the worker's own files are saved under absolute addresses. */
  origin: string;
  /** The build this worker was made for; names the shell cache. */
  build: string;
  networkTimeoutMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

type Waiter = (work: Promise<unknown>) => void;

/** Answers that are needed to start the app offline; they are never trimmed to make room. */
const KEEP = (url: string): boolean => /\/api\/(?:session|bootstrap)$/.test(new URL(url).pathname);
const TRIM_EVERY = 25;

export class OfflineWorker {
  private state: WorkerState = { ...EMPTY_STATE };
  private ready: Promise<void> | null = null;
  /** Changes whenever copies are wiped or the account changes, so a slow answer never lands in the wrong place. */
  private generation = 0;
  private puts = 0;
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  private abs(path: string): string {
    return new URL(path, this.env.origin).href;
  }

  // ---------- lifecycle ----------

  /** Fetch the build's files into its own cache. Any miss fails the install, so a build is all-or-nothing. */
  async install(urls: readonly string[]): Promise<void> {
    const cache = await this.env.caches.open(shellCacheName(this.env.build));
    await Promise.all(urls.map(async (path) => {
      const url = this.abs(path);
      const res = await this.env.fetch(new Request(url, { cache: "reload" }));
      if (!res.ok) throw new Error(`Could not save ${path} (${res.status})`);
      await cache.put(url, res);
    }));
  }

  /** Drop the shell caches of older builds and apply what was remembered about the account. */
  async activate(): Promise<void> {
    const names = await this.env.caches.keys();
    await Promise.all(staleShellCaches(names, this.env.build).map((n) => this.env.caches.delete(n)));
    await this.init();
  }

  private init(): Promise<void> {
    this.ready ??= this.restore();
    return this.ready;
  }

  private async restore(): Promise<void> {
    try {
      const hit = await (await this.env.caches.open(STATE_CACHE)).match(this.abs(STATE_URL));
      this.state = hit ? parseWorkerState(await hit.json()) : { ...EMPTY_STATE };
    } catch {
      this.state = { ...EMPTY_STATE };
    }
    await this.dropForeignCopies();
  }

  private async persist(): Promise<void> {
    const cache = await this.env.caches.open(STATE_CACHE);
    await cache.put(this.abs(STATE_URL), new Response(JSON.stringify(this.state), { headers: { "content-type": "application/json" } }));
  }

  /** Nothing is kept unless offline reading is on and an account is known; other accounts' copies never stay. */
  private async dropForeignCopies(): Promise<void> {
    const { accountId, enabled } = this.state;
    const keepFor = enabled ? accountId : null;
    const names = await this.env.caches.keys();
    await Promise.all(foreignDataCaches(names, keepFor).map((n) => this.env.caches.delete(n)));
  }

  // ---------- messages from the page ----------

  async message(msg: PageMessage): Promise<void> {
    await this.init();
    if (msg.type === "wipe") { await this.wipe(); return; }
    if (msg.type !== "state") return;
    const before = this.state;
    this.state = { accountId: msg.accountId, enabled: msg.enabled };
    if (before.accountId !== this.state.accountId || before.enabled !== this.state.enabled) this.generation++;
    await this.dropForeignCopies();
    await this.persist();
  }

  /** Forget every saved answer, for every account. */
  async wipe(): Promise<void> {
    await this.init();
    this.generation++;
    const names = await this.env.caches.keys();
    await Promise.all(names.filter(isDataCache).map((n) => this.env.caches.delete(n)));
  }

  // ---------- requests ----------

  /** Answer a request of the given class. Rejects when there is nothing to answer with, like a failed fetch. */
  handle(kind: Exclude<RouteClass, "bypass">, request: Request, waitUntil: Waiter): Promise<Response> {
    if (kind === "navigation") return this.navigation(request);
    if (kind === "static") return this.staticFile(request);
    return this.api(request, waitUntil);
  }

  private async navigation(request: Request): Promise<Response> {
    const shell = await this.env.caches.open(shellCacheName(this.env.build));
    const fallback = () => shell.match(this.abs(`${APP_PATH}/index.html`));
    const raced = await this.race(this.env.fetch(request));
    if (raced.kind === "response" && raced.response.status < 500) return raced.response;
    const saved = await fallback();
    if (saved) return saved;
    if (raced.kind === "response") return raced.response;
    if (raced.kind === "late") return raced.pending;
    throw raced.error;
  }

  private async staticFile(request: Request): Promise<Response> {
    const shell = await this.env.caches.open(shellCacheName(this.env.build));
    const hit = await shell.match(request.url);
    if (hit) return hit;
    const res = await this.env.fetch(request);
    // The server answers an unknown path with the app page; never keep that under a script's name.
    if (res.ok && !(res.headers.get("content-type") ?? "").startsWith("text/html")) await shell.put(request.url, res.clone());
    return res;
  }

  private async api(request: Request, waitUntil: Waiter): Promise<Response> {
    await this.init();
    const isSession = new URL(request.url).pathname === "/api/session";
    if (!this.state.enabled) return this.env.fetch(request);
    const accountAtStart = this.state.accountId;
    if (!accountAtStart && !isSession) return this.env.fetch(request);

    const generation = this.generation;
    const raced = await this.race(this.env.fetch(request));
    const finish = (response: Response) => this.afterNetwork(request, response, generation, waitUntil);

    if (raced.kind === "response") {
      const response = await finish(raced.response);
      if (response.status < 500) return response;
      return (await this.copyFor(request.url)) ?? response;
    }
    const copy = await this.copyFor(request.url);
    if (raced.kind === "late") {
      if (!copy) return finish(await raced.pending);
      // Slow network: answer from the copy now, and keep what finally arrives for next time.
      waitUntil(raced.pending.then(finish).catch(() => undefined));
      return copy;
    }
    if (copy) return copy;
    throw raced.error;
  }

  /** Notice sign-out and account changes in what the server said, then keep a copy of good answers. */
  private async afterNetwork(request: Request, response: Response, generation: number, waitUntil: Waiter): Promise<Response> {
    const isSession = new URL(request.url).pathname === "/api/session";
    if (isSession && response.ok) await this.observeSession(response);
    else if (response.status === 401 && (await errorCode(response)) === "signed_out") await this.forgetAccount();
    if (!response.ok) return response;
    // A session answer says which account it is for; any other answer belongs to the account it was asked for.
    const account = this.state.accountId;
    if (this.state.enabled && account) {
      waitUntil(this.save(account, request.url, response.clone(), isSession ? this.generation : generation).catch(() => undefined));
    }
    return response;
  }

  private async observeSession(response: Response): Promise<void> {
    let body: { state?: unknown; account?: { id?: unknown } | null } | null = null;
    try { body = await response.clone().json(); } catch { return; }
    if (body?.state === "signed_in" && typeof body.account?.id === "string") await this.adoptAccount(body.account.id);
    else if (body?.state === "signed_out" || body?.state === "unclaimed") await this.forgetAccount();
  }

  private async adoptAccount(accountId: string): Promise<void> {
    if (this.state.accountId === accountId) return;
    this.generation++;
    this.state = { ...this.state, accountId };
    await this.dropForeignCopies();
    await this.persist();
  }

  private async forgetAccount(): Promise<void> {
    this.generation++;
    this.state = { ...this.state, accountId: null };
    const names = await this.env.caches.keys();
    await Promise.all(names.filter(isDataCache).map((n) => this.env.caches.delete(n)));
    await this.persist();
  }

  /** Keep an answer, unless the account, the setting or a wipe changed while it was on its way. */
  private async save(accountId: string, url: string, response: Response, generation: number): Promise<void> {
    const headers = new Headers(response.headers);
    headers.set(SAVED_HEADER, new Date(this.env.now()).toISOString());
    let body: ArrayBuffer | string = await response.arrayBuffer();
    if (new URL(url).pathname === "/api/session") {
      // The copy of the session keeps who is signed in but not the page's change token: nothing can be changed offline anyway.
      const text = withoutChangeToken(body);
      if (text === null) return;
      body = text;
      headers.delete("content-length");
    }
    const stamped = new Response(body, { status: response.status, statusText: response.statusText, headers });
    const current = () => this.state.enabled && this.state.accountId === accountId && this.generation === generation;
    if (!current()) return;
    const cache = await this.env.caches.open(dataCacheName(accountId));
    if (!current()) { await this.dropForeignCopies(); return; }
    await cache.put(url, stamped);
    if (++this.puts % TRIM_EVERY === 0) await this.trim(accountId);
  }

  private async trim(accountId: string): Promise<void> {
    const name = dataCacheName(accountId);
    if (!(await this.env.caches.has(name))) return;
    const cache = await this.env.caches.open(name);
    const keys = await cache.keys();
    if (keys.length <= MAX_COPIES) return;
    const copies: Copy[] = [];
    for (const key of keys) {
      const hit = await cache.match(key);
      copies.push({ url: key.url, savedAt: Date.parse(hit?.headers.get(SAVED_HEADER) ?? "") || 0 });
    }
    await Promise.all(copiesToEvict(copies, MAX_COPIES, KEEP).map((url) => cache.delete(url)));
  }

  /** The saved answer for a URL, marked with when it was saved. */
  private async copyFor(url: string): Promise<Response | null> {
    const accountId = this.state.accountId;
    if (!accountId || !this.state.enabled) return null;
    const name = dataCacheName(accountId);
    if (!(await this.env.caches.has(name))) return null;
    const hit = await (await this.env.caches.open(name)).match(url);
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set(OFFLINE_HEADER, hit.headers.get(SAVED_HEADER) ?? new Date(this.env.now()).toISOString());
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }

  // ---------- network timing ----------

  /** Give the network its time: an answer, a failure, or "still waiting" with the request left running. */
  private race(pending: Promise<Response>): Promise<
    | { kind: "response"; response: Response }
    | { kind: "error"; error: unknown }
    | { kind: "late"; pending: Promise<Response> }
  > {
    const set = this.env.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.env.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    return new Promise((resolve) => {
      const timer = set(() => resolve({ kind: "late", pending }), this.env.networkTimeoutMs ?? NETWORK_TIMEOUT_MS);
      pending.then(
        (response) => { clear(timer); resolve({ kind: "response", response }); },
        (error) => { clear(timer); resolve({ kind: "error", error }); },
      );
    });
  }
}

function withoutChangeToken(body: ArrayBuffer): string | null {
  try {
    const session = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    return JSON.stringify({ ...session, csrf: null });
  } catch { return null; }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch { return null; }
}
