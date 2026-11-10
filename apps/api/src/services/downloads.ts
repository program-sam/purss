import type { DownloadPlan, DownloadPlanRequest, ItemDTO } from "@purss/domain";
import { CANDIDATE_FILTERS, CANDIDATES_PER_FILTER, chooseDownloads, downloadCandidate, expectedBytes, mediaToDownload } from "@purss/domain";
import type { App, Principal } from "../app.ts";
import { listItems } from "./items.ts";

/**
 * What a phone should download automatically now (plan/38), by the rules in @purss/domain: the app asks
 * while it is open and its native background job while it is closed, so both decide the same way
 * without the rules being written again in Kotlin and Swift. The device says what it already has;
 * nothing about the device is stored.
 */
export function downloadPlan(app: App, p: Principal, req: DownloadPlanRequest): DownloadPlan {
  const items = new Map<string, ItemDTO>();
  for (const filter of CANDIDATE_FILTERS) {
    for (const it of listItems(app, p, { scope: "all", filter, sort: "newest", limit: CANDIDATES_PER_FILTER }).items) items.set(it.id, it);
  }
  const chosen = chooseDownloads(req, [...items.values()].map(downloadCandidate), new Set(req.have), req.usedBytes);
  return {
    items: chosen.map((c) => {
      const media = items.get(c.id)!.media!;
      return { id: c.id, expectedBytes: expectedBytes(c), media: { kind: media.kind, ...mediaToDownload(media) } };
    }),
  };
}
