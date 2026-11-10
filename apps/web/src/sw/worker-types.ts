/**
 * The small part of the service worker API that sw.ts uses. The repository type-checks every file
 * against the browser's window types, which don't describe a worker's global scope.
 */
export type ExtendableEventLike = Event & { waitUntil(work: Promise<unknown>): void };
export type FetchEventLike = ExtendableEventLike & { readonly request: Request; respondWith(response: Response | Promise<Response>): void };
export type MessageEventLike = ExtendableEventLike & { readonly data: unknown; readonly ports: readonly MessagePort[] };

export interface WorkerScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}
