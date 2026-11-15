/**
 * Pictures PURSS serves to the signed-in person (a source's icon, a picture kept with a copy) for pages that are not
 * PURSS's own origin: the apps load their page from the device, so an `<img>` with PURSS's path would ask the device,
 * and one with PURSS's full address would go without the device token. Each picture is fetched once with the token
 * and shown from a `blob:` address. A picture's address changes with its bytes (icons carry their digest, kept
 * pictures never change), so a copy is good for as long as the page lives. Copies over `budgetBytes` are let go,
 * least recently asked for first; a picture that failed is asked for again next time.
 */
export type PictureCacheDeps = {
  load: (path: string) => Promise<Blob>;
  budgetBytes: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
};

type Entry = { pending: Promise<string> } | { url: string; bytes: number };

export function createPictureCache(deps: PictureCacheDeps): (path: string) => string | Promise<string> {
  const createUrl = deps.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = deps.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
  // A Map keeps insertion order: re-inserting on use makes its first entries the least recently used.
  const entries = new Map<string, Entry>();
  let total = 0;

  const trim = (keep: string) => {
    for (const [path, e] of entries) {
      if (total <= deps.budgetBytes) return;
      if (path === keep || !("url" in e)) continue;
      entries.delete(path);
      total -= e.bytes;
      revokeUrl(e.url);
    }
  };

  return (path) => {
    const hit = entries.get(path);
    if (hit) {
      entries.delete(path);
      entries.set(path, hit);
      return "url" in hit ? hit.url : hit.pending;
    }
    const pending = deps.load(path).then(
      (blob) => {
        const url = createUrl(blob);
        entries.set(path, { url, bytes: blob.size });
        total += blob.size;
        trim(path);
        return url;
      },
      (err: unknown) => {
        entries.delete(path);
        throw err;
      },
    );
    entries.set(path, { pending });
    return pending;
  };
}
