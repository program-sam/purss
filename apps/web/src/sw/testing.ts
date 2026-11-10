import type { Env } from "./offline-worker.ts";

/** An in-memory stand-in for the browser's Cache Storage, for tests. Keys are absolute URLs. */
type Entry = { status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer };

export class FakeCache {
  readonly entries = new Map<string, Entry>();
  private key(input: RequestInfo | URL): string { return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url; }
  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(input), { status: response.status, statusText: response.statusText, headers: [...response.headers], body: await response.arrayBuffer() });
  }
  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const e = this.entries.get(this.key(input));
    return e ? new Response(e.body.slice(0), { status: e.status, statusText: e.statusText, headers: e.headers }) : undefined;
  }
  async keys(): Promise<Request[]> { return [...this.entries.keys()].map((u) => new Request(u)); }
  async delete(input: RequestInfo | URL): Promise<boolean> { return this.entries.delete(this.key(input)); }
}

export class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.stores.get(name);
    if (!c) { c = new FakeCache(); this.stores.set(name, c); }
    return c;
  }
  async has(name: string): Promise<boolean> { return this.stores.has(name); }
  async keys(): Promise<string[]> { return [...this.stores.keys()]; }
  async delete(name: string): Promise<boolean> { return this.stores.delete(name); }
  names(): string[] { return [...this.stores.keys()].sort(); }
}

export const ORIGIN = "http://workspace.test";

export type Network = {
  /** Answers by path (and query); a function can decide per request. */
  routes: Map<string, () => Response | Promise<Response>>;
  requests: string[];
  offline: boolean;
};

/** A scripted network: unknown paths are 404, `offline` makes every fetch fail like a lost connection. */
export function fakeNetwork(): Network & { fetch: Env["fetch"] } {
  const net: Network = { routes: new Map(), requests: [], offline: false };
  return Object.assign(net, {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      net.requests.push(url.pathname + url.search);
      if (net.offline) throw new TypeError("Failed to fetch");
      const route = net.routes.get(url.pathname + url.search) ?? net.routes.get(url.pathname);
      return route ? route() : new Response("missing", { status: 404 });
    },
  });
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

export function makeEnv(over: Partial<Env> = {}) {
  const caches = new FakeCaches();
  const network = fakeNetwork();
  let clock = Date.parse("2026-11-04T10:00:00.000Z");
  const env: Env = {
    caches: caches as unknown as Env["caches"],
    fetch: network.fetch,
    now: () => clock,
    origin: ORIGIN,
    build: "b1",
    networkTimeoutMs: 40,
    ...over,
  };
  return { env, caches, network, tick: (ms: number) => { clock += ms; }, get clock() { return clock; } };
}

/** Collects the work a handler hands to waitUntil, so a test can wait for background saves. */
export function waiter() {
  const pending: Promise<unknown>[] = [];
  return { wait: (p: Promise<unknown>) => { pending.push(p); }, settle: async () => { while (pending.length) await pending.shift(); } };
}

export const req = (path: string, init?: RequestInit): Request => new Request(new URL(path, ORIGIN).href, init);
