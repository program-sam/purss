import { plural } from "./format.ts";

export type AddSourcePhase = "paste" | "looking" | "found" | "failed" | "shows" | "single";

/**
 * The one short line a screen reader gets while Add source looks something up: that it is looking, then what it found.
 * The results themselves are not read out; they are there to be moved through.
 */
export function addSourceStatus(o: { phase: AddSourcePhase; searching: boolean; shows: number; candidates: number; failure: string | null; keeping: boolean }): string {
  if (o.phase === "looking") return "Looking…";
  if (o.phase === "shows") return o.searching ? "Searching for shows…" : o.shows ? `${plural(o.shows, "show")} found.` : "No shows found.";
  if (o.phase === "failed") return o.failure ? `Couldn't follow that: ${o.failure}` : "Couldn't follow that.";
  if (o.phase === "found") {
    if (o.keeping) return "Found a page you can keep.";
    return o.candidates === 1 ? "Found 1 feed to follow." : o.candidates ? `Found ${o.candidates} feeds. Choose one to follow.` : "Found nothing to follow.";
  }
  return "";
}
