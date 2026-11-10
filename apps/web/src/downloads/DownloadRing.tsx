import type { DownloadProgress } from "./types.ts";

/** How much of a download has come in, from 0 to 1; null while the file's whole size isn't known. */
export function progressFraction(p: DownloadProgress | null): number | null {
  return p && p.total && p.total > 0 ? Math.min(1, p.bytes / p.total) : null;
}

/**
 * A ring around a download's button that fills as the file comes in, and turns while its size isn't known;
 * an empty ring for a download waiting its turn.
 */
export function DownloadRing({ progress, queued = false }: { progress: DownloadProgress | null; queued?: boolean }) {
  const f = progressFraction(progress);
  return (
    <svg className={`dl-ring${!queued && f === null ? " turning" : ""}`} viewBox="0 0 36 36" aria-hidden="true">
      <circle className="track" cx="18" cy="18" r="16" pathLength="100" />
      {queued ? null : <circle className="fill" cx="18" cy="18" r="16" pathLength="100" strokeDasharray={`${f === null ? 25 : Math.max(2, f * 100)} 100`} />}
    </svg>
  );
}
