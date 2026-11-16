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

/**
 * Where focus goes when a step takes away the control that had it (a show chosen from the results, Find disabled while it
 * looks, Follow disabled while it works), in the order tried: the message about what went wrong, else the step's first control.
 */
export function focusTargets(phase: AddSourcePhase, o: { searching: boolean; hasError: boolean }): string[] {
  const error = o.hasError ? ["#as-error"] : [];
  switch (phase) {
    case "paste": return [...error, "#as-url"];
    case "looking": return ["#as-looking"];
    case "shows": return [...error, o.searching ? "#as-searching" : "#as-shows .cand", "#as-url"];
    case "found": return [...error, ".cands input:checked", ".cands input", "#fnd"];
    case "failed": return [...error, "#as-failed"];
    case "single": return [...error, "#kl-b", "#kl-t"];
  }
}
