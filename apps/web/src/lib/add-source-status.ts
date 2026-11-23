import { app } from "@purss/translations/app";
import { plural } from "./format.ts";

export type AddSourcePhase = "paste" | "looking" | "found" | "failed" | "results" | "single";

/**
 * The one short line a screen reader gets while Add source looks something up: that it is looking, then what it found.
 * The results themselves are not read out; they are there to be moved through.
 */
export function addSourceStatus(o: { phase: AddSourcePhase; searching: boolean; results: number; candidates: number; failure: string | null; keeping: boolean }): string {
  const t = app.lib.addSourceStatus;
  if (o.phase === "looking") return app.words.looking;
  if (o.phase === "results") return o.searching ? t.searching : o.results ? t.resultsFound(plural(o.results, app.lib.nouns.result)) : t.nothingFound;
  if (o.phase === "failed") return o.failure ? t.failedWith(o.failure) : t.failed;
  if (o.phase === "found") {
    if (o.keeping) return t.keepable;
    return o.candidates === 1 ? t.oneFeed : o.candidates ? t.feeds(o.candidates) : t.nothing;
  }
  return "";
}

/**
 * Where focus goes when a step takes away the control that had it (a site or show chosen from the results, Find disabled while it
 * looks, Follow disabled while it works), in the order tried: the message about what went wrong, else the step's first control.
 */
export function focusTargets(phase: AddSourcePhase, o: { searching: boolean; hasError: boolean }): string[] {
  const error = o.hasError ? ["#as-error"] : [];
  switch (phase) {
    case "paste": return [...error, "#as-url"];
    case "looking": return ["#as-looking"];
    case "results": return [...error, o.searching ? "#as-searching" : "#as-results .cand", "#as-url"];
    case "found": return [...error, ".cands input:checked", ".cands input", "#fnd"];
    case "failed": return [...error, "#as-failed"];
    case "single": return [...error, "#kl-b", "#kl-t"];
  }
}
