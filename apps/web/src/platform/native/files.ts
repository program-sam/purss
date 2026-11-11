import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Network } from "@capacitor/network";
import { Share } from "@capacitor/share";
import type { DeviceConnection } from "@purss/domain";
import { DownloadError } from "../../downloads/manager.ts";
import type { DeviceFiles } from "../../downloads/manager.ts";
import { PurssDevice } from "./device-plugin.ts";
import type { DownloadFailure } from "./device-plugin.ts";

/**
 * The apps' downloads folder: `downloads/` in the app's private storage that the system doesn't back up
 * (Library/NoCloud on iOS, the app's files folder on Android, where backups are turned off in the
 * manifest). Removed with the app, and by Disconnect. The app's own plugin (device-plugin.ts) fetches
 * files into it and can stop a transfer on the wire; the background job (plan/38) writes there too.
 */
const ROOT = "downloads";

const DIR = Directory.LibraryNoCloud;
const path = (name: string) => (name ? `${ROOT}/${name}` : ROOT);
let nextId = 0;

async function ensureParent(name: string): Promise<void> {
  const parent = path(name).split("/").slice(0, -1).join("/");
  try { await Filesystem.mkdir({ path: parent, directory: DIR, recursive: true }); } catch { /* already there */ }
}

export const deviceFiles: DeviceFiles = {
  /** When `signal` aborts (the file became too large, or downloads were removed) the transfer is stopped and its partial file removed. */
  async download(url, name, onProgress, signal) {
    if (signal.aborted) throw new DOMException("The download was stopped.", "AbortError");
    const id = `dl-${Date.now()}-${nextId++}`;
    const listener = await PurssDevice.addListener("progress", (p) => {
      if (p.id === id && !signal.aborted) onProgress(p.bytes, p.total > 0 ? p.total : null);
    });
    const stop = () => { void PurssDevice.cancel({ id }); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      return (await PurssDevice.download({ id, url, path: name })).bytes;
    } catch (err) {
      if (signal.aborted) throw new DOMException("The download was stopped.", "AbortError");
      const e = err as { code?: DownloadFailure["code"]; data?: { status?: number }; message?: string };
      throw new DownloadError(e.code === "http" ? e.data?.status ?? 0 : e.code === "too_large" ? -2 : e.code === "insecure" ? -1 : 0, e.message ?? "download failed");
    } finally {
      signal.removeEventListener("abort", stop);
      await listener.remove();
    }
  },

  async list(name) {
    try { return (await Filesystem.readdir({ path: path(name), directory: DIR })).files.map((f) => f.name); } catch { return []; }
  },

  async writeText(name, text) {
    await ensureParent(name);
    await Filesystem.writeFile({ path: path(name), directory: DIR, data: text, encoding: Encoding.UTF8 });
    return new TextEncoder().encode(text).byteLength;
  },

  async readText(name) {
    try {
      const out = await Filesystem.readFile({ path: path(name), directory: DIR, encoding: Encoding.UTF8 });
      return typeof out.data === "string" ? out.data : await out.data.text();
    } catch { return null; }
  },

  async readBytes(name) {
    try {
      const out = await Filesystem.readFile({ path: path(name), directory: DIR });
      if (typeof out.data !== "string") return new Uint8Array(await out.data.arrayBuffer());
      const raw = atob(out.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return bytes;
    } catch { return null; }
  },

  async remove(name) {
    try {
      const info = await Filesystem.stat({ path: path(name), directory: DIR });
      if (info.type === "directory") await Filesystem.rmdir({ path: path(name), directory: DIR, recursive: true });
      else await Filesystem.deleteFile({ path: path(name), directory: DIR });
    } catch { /* nothing there */ }
  },

  async uri(name) {
    return (await Filesystem.getUri({ path: path(name), directory: DIR })).uri;
  },
};

export async function deviceConnection(): Promise<DeviceConnection> {
  try {
    const s = await Network.getStatus();
    if (!s.connected) return "none";
    return s.connectionType === "wifi" ? "wifi" : s.connectionType === "cellular" ? "cellular" : "unknown";
  } catch { return "unknown"; }
}

/** A file for the person (an export): written to the app's cache, then offered in the share sheet. */
export async function shareFile(data: Blob, filename: string): Promise<void> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.readAsDataURL(data);
  });
  const written = await Filesystem.writeFile({ path: `exports/${filename}`, data: base64, directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: filename, files: [written.uri] });
  } catch (err) {
    // Closing the share sheet without choosing anything isn't a failure.
    if (!/cancel/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}
