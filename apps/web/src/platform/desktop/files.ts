import type { DeviceConnection } from "@purss/domain";
import { DownloadError } from "../../downloads/manager.ts";
import type { DeviceFiles } from "../../downloads/manager.ts";
import { desktop } from "./bridge.ts";

/*
 * The desktop app's downloads (plan/42): real files in `PURSS` inside the folder the person chose,
 * written and read by Rust, which keeps every path inside that folder and only ever lists or removes entries of
 * the app's own layout (`<account>/<item>/…`). Files are played from the app's server on 127.0.0.1.
 */

let nextId = 0;

/** Rust's failure codes, as the download manager words them (`failureText`): an http status, 0 for the network, -1 insecure, -2 too large. */
function failure(err: unknown): DownloadError {
  const text = String(err);
  const m = /^(http|network|too_large|insecure|io|cancelled)(?::(\d+))?/.exec(text);
  const code = m?.[1];
  return new DownloadError(code === "http" ? Number(m?.[2] ?? 0) : code === "too_large" ? -2 : code === "insecure" ? -1 : 0, text);
}

export function desktopFiles(mediaBase: string): DeviceFiles {
  return {
    async download(url, name, onProgress, signal) {
      if (signal.aborted) throw new DOMException("The download was stopped.", "AbortError");
      const id = `dl-${Date.now()}-${nextId++}`;
      const stop = () => { void desktop.cancelDownload(id).catch(() => undefined); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        return await desktop.download(id, url, name, null, (p) => { if (!signal.aborted) onProgress(p.bytes, p.total > 0 ? p.total : null); });
      } catch (err) {
        if (signal.aborted) throw new DOMException("The download was stopped.", "AbortError");
        throw failure(err);
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
    list: (name) => desktop.list(name).catch(() => []),
    writeText: (name, text) => desktop.writeText(name, text),
    readText: (name) => desktop.readText(name).catch(() => null),
    readBytes: (name) => desktop.readBytes(name),
    remove: (name) => desktop.remove(name).catch(() => undefined),
    uri: async (name) => mediaBase + name.split("/").map(encodeURIComponent).join("/"),
  };
}

/**
 * A computer's connection counts as Wi-Fi: the rule that keeps automatic downloads off a phone's mobile data
 * (on Android, Wi-Fi or Ethernet) has nothing to tell apart on a computer. Offline is still offline.
 */
export async function desktopConnection(): Promise<DeviceConnection> {
  return navigator.onLine ? "wifi" : "none";
}
