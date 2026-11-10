import { OfflineWorker } from "./offline-worker.ts";
import { classifyRequest } from "./policy.ts";
import { isPageMessage } from "./protocol.ts";
import type { WorkerScope } from "./worker-types.ts";

/**
 * The service worker: wires the browser's events to OfflineWorker. The build (vite.config.ts) injects
 * the build's name and the list of files to save with the app.
 */
declare const __PURSS_BUILD__: string;
declare const __PURSS_PRECACHE__: readonly string[];

const scope = self as unknown as WorkerScope;
const precache = __PURSS_PRECACHE__;
const precached = new Set(precache);
const worker = new OfflineWorker({
  caches,
  fetch: (request) => fetch(request),
  now: () => Date.now(),
  origin: scope.location.origin,
  build: __PURSS_BUILD__,
});

// A new build waits until the page asks for it (see the "skip-waiting" message), so a page is never
// left running against files that have been replaced under it.
scope.addEventListener("install", (event) => { event.waitUntil(worker.install(precache)); });
scope.addEventListener("activate", (event) => { event.waitUntil(Promise.all([worker.activate(), scope.clients.claim()])); });

scope.addEventListener("fetch", (event) => {
  const { request } = event;
  const kind = classifyRequest({ method: request.method, url: request.url, mode: request.mode, headers: request.headers }, scope.location.origin, precached);
  if (kind === "bypass") return;
  event.respondWith(worker.handle(kind, request, (work) => event.waitUntil(work)));
});

scope.addEventListener("message", (event) => {
  const msg = event.data;
  if (!isPageMessage(msg)) return;
  if (msg.type === "skip-waiting") { event.waitUntil(scope.skipWaiting()); return; }
  const reply = event.ports[0];
  event.waitUntil(worker.message(msg).then(() => reply?.postMessage({ ok: true })));
});
