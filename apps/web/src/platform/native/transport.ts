import type { OfflineWorker } from "../../sw/offline-worker.ts";
import { classifyRequest } from "../../sw/policy.ts";
import { NO_COPY_HEADER } from "../../sw/protocol.ts";
import { followEvents } from "../sse.ts";
import type { Transport } from "../types.ts";

/**
 * How the apps reach PURSS: every API request goes to the connected server with the device
 * token, and never with cookies; a request for any other origin is refused. Reads worth keeping go through the same OfflineWorker the web's service
 * worker runs (network first, this device's copy when there is no network); when neither answers, an
 * item downloaded to the device still does.
 */
export type AppTransportDeps = {
  origin: string;
  token: string;
  worker: Pick<OfflineWorker, "handle">;
  /** A downloaded copy of an API read, or null. */
  downloaded: ((path: string) => Promise<Response | null>) | null;
  fetch: (request: Request) => Promise<Response>;
  /** The server says this device isn't connected any more. */
  onLost: () => void;
};

export function createAppTransport(deps: AppTransportDeps): Transport {
  const { origin, token } = deps;
  const resolve = (path: string) => (/^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `${origin}${path}`);
  return {
    async fetch(path, init) {
      // The token is PURSS's; an absolute address anywhere else is refused, never sent with it.
      if (new URL(resolve(path)).origin !== new URL(origin).origin) throw new TypeError("The app only sends requests to the PURSS it is connected to.");
      const headers = new Headers(init.headers);
      const noCopy = headers.has(NO_COPY_HEADER);
      // Only headers PURSS's CORS rules allow; the change token belongs to browser sessions.
      headers.delete(NO_COPY_HEADER);
      headers.delete("x-purss-csrf");
      headers.set("authorization", `Bearer ${token}`);
      const request = new Request(resolve(path), { ...init, headers, credentials: "omit", mode: "cors" });
      const kind = noCopy ? "bypass" : classifyRequest({ method: request.method, url: request.url, mode: "cors", headers: request.headers }, origin, new Set());
      try {
        return kind === "api" ? await deps.worker.handle("api", request, () => undefined) : await deps.fetch(request);
      } catch (err) {
        if (request.method === "GET" && deps.downloaded && !(err instanceof DOMException && err.name === "AbortError")) {
          const copy = await deps.downloaded(new URL(request.url).pathname);
          if (copy) return copy;
        }
        throw err;
      }
    },
    events(onMessage) {
      return followEvents({
        open: (signal) => deps.fetch(new Request(`${origin}/api/events`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal, credentials: "omit", cache: "no-store" })),
        onRefused: async (res) => {
          const code = await res.json().then((b: { error?: { code?: string } }) => b.error?.code).catch(() => null);
          if (code === "device_signed_out") deps.onLost();
        },
      }, onMessage);
    },
  };
}
