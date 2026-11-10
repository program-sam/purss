import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { homeOverviewKey } from "../api/home-queries.ts";
import { trackVisits } from "../state/visit.ts";

/** Tells PURSS the person is here, from whatever page they are on (see state/visit.ts). Draws nothing. */
export function VisitTracker() {
  const qc = useQueryClient();
  useEffect(() => trackVisits(() => void qc.invalidateQueries({ queryKey: homeOverviewKey })), [qc]);
  return null;
}
