/**
 * The part of Cache Storage that offline reading uses. The service worker passes the browser's own
 * `caches`; the apps pass a store of their own (platform/copies.ts), since a service worker can't run
 * for their pages on every system.
 */
export interface CacheLike {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  keys(): Promise<readonly Request[]>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
  has(name: string): Promise<boolean>;
}
