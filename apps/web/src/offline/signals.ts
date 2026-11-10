/** Tiny event lines so the code that sees changes can tell the offline pack, without importing it. */
const listeners = new Set<() => void>();
const reading = new Set<() => void>();

/** Items arrived or changed on the server (the live-update channel). */
export function emitItemsChanged(): void {
  listeners.forEach((fn) => fn());
}

export function onItemsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The person changed what they read or keep (To read, a keep, an undo) and PURSS took it. */
export function emitReadingChanged(): void {
  reading.forEach((fn) => fn());
}

export function onReadingChanged(fn: () => void): () => void {
  reading.add(fn);
  return () => reading.delete(fn);
}
