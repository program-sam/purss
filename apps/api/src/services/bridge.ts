import http from "node:http";
import { bridgeRoutePath } from "@purss/connectors";
import type { BridgeClient } from "@purss/connectors";
import type { App } from "../app.ts";
import { readSecret } from "../secrets.ts";

/*
 * The API's way to the bridge router (plan/41), used to preview a bridged source before it is
 * followed. It asks the router's internal listener directly with a signed address, the same one the
 * worker gives the engine; ordinary discovery fetching (safeFetch) never reaches internal addresses.
 */

const TIMEOUT_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;

/** The router client, or undefined when this installation runs no bridge (or its key is missing). */
export function bridgeClient(app: App): BridgeClient | undefined {
  const base = app.config.bridgeUrl;
  if (!base) return undefined;
  return (target, signal) => {
    const secret = readSecret(app.config.secretsDir, "bridge-key");
    if (!secret) return Promise.resolve({ failed: true as const });
    const url = `${base}${bridgeRoutePath(secret, target.service.id, target.key)}`;
    return new Promise((resolve) => {
      // The discovery's own deadline or cancellation ends the request too.
      const req = http.get(url, { timeout: TIMEOUT_MS, signal }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            resolve({ failed: true });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", () => resolve({ failed: true }));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ failed: true }));
    });
  };
}
