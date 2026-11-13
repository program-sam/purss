import { EMBED_ORIGINS } from "../lib/embeds.ts";

/**
 * Content-Security-Policy for the bundled page (plan/31). A page enforces every policy it carries,
 * so in a browser the server's stricter header (apps/api/src/server.ts) still decides: this policy
 * allows at least everything that header allows. The apps' PURSS is chosen at run time, so the
 * page as built allows any http(s) PURSS (`PAGE_POLICY`, put in index.html by the build); once
 * the app is connected, `workspacePolicy` narrows requests and images to that PURSS and https
 * publishers and media to https publishers (PURSS serves none), and the app's transport
 * refuses any other origin. Frames come only from the video players the reader embeds (lib/embeds.ts).
 * The desktop app (plan/42) calls its own code through Tauri's IPC (`ipc:`,
 * `http://ipc.localhost` on Windows) and plays downloads from its server on 127.0.0.1.
 */
const TAURI_IPC = "ipc: http://ipc.localhost";

export const PAGE_POLICY = [
  "default-src 'self'",
  "img-src 'self' https: http: data:",
  "media-src 'self' https: http:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  `connect-src 'self' https: http: ${TAURI_IPC}`,
  `frame-src ${EMBED_ORIGINS.join(" ")}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/**
 * The policy added once the app is connected to `origin`. A policy source can't name an IPv6 address,
 * so a PURSS at one is allowed by its scheme only (the transport still refuses other origins).
 * `alsoConnect` adds origins the page itself may call besides PURSS (the push relay, plan/37).
 * `desktop` adds what the desktop app needs: its IPC, and the origin of its server for downloaded media.
 */
export function workspacePolicy(origin: string, alsoConnect: string[] = [], desktop?: { media: string }): string {
  const u = new URL(origin);
  const source = u.hostname.startsWith("[") ? u.protocol : u.origin;
  const connect = [source, ...alsoConnect.map((o) => new URL(o).origin), ...(desktop ? [TAURI_IPC] : [])].join(" ");
  const media = desktop ? ` ${new URL(desktop.media).origin}` : "";
  return [`connect-src 'self' ${connect}`, `img-src 'self' https: data: ${source}`, `media-src 'self' https:${media}`].join("; ");
}
