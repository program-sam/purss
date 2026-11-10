import { ApiError } from "../../api/client.ts";
import { platform } from "../../platform/index.ts";

export type Downloaded = { filename: string; bytes: number; headers: Headers };

/** The file name a Content-Disposition header suggests, if any. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const m = /filename="?([^";]+)"?/i.exec(disposition ?? "");
  const name = m?.[1]?.trim();
  // A name from a header never decides a path: keep only a plain file name.
  return name && /^[\w .()-]{1,120}$/.test(name) ? name : fallback;
}

async function failure(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) return new ApiError(res.status, body.error.code ?? "error", body.error.message);
  } catch { /* not JSON */ }
  return new ApiError(res.status, "error", res.status >= 500 ? "Something went wrong on our side. Nothing was changed; please try again." : "That didn't work. Please try again.");
}

/**
 * Fetch a file from the API and hand it to the person (a download, or the apps' share sheet). Reading the stream here (rather than
 * a plain link) lets a refusal show as a sentence instead of a saved error page, and gives progress.
 */
export async function downloadFile(path: string, fallbackName: string, opts: { onProgress?: (bytes: number) => void; signal?: AbortSignal } = {}): Promise<Downloaded> {
  let res: Response;
  try {
    res = await platform.transport.fetch(path, { headers: { accept: "*/*" }, signal: opts.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "offline", "Can't reach PURSS right now. Check your connection and try again.");
  }
  if (!res.ok) throw await failure(res);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        bytes += value.byteLength;
        opts.onProgress?.(bytes);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(0, "interrupted", "The download was interrupted before it finished, so nothing was saved. Please try again.");
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    bytes = buf.byteLength;
  }
  const filename = filenameFrom(res.headers.get("content-disposition"), fallbackName);
  await platform.saveFile(new Blob(chunks, { type }), filename);
  return { filename, bytes, headers: res.headers };
}
