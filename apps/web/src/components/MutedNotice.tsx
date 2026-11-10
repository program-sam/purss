import { useNav } from "../nav.ts";
import { formatCount } from "../lib/format.ts";
import { hiddenByMuted, mutedNoticeShown } from "../lib/muted-words.ts";
import { useOverlays } from "../state/overlays.tsx";

/**
 * Under a list or Home when muted words leave items out: how many, and a way to see them (`?muted=show`). While they show, a way
 * to hide them again. Both name where the words are kept.
 */
export function MutedNotice({ hidden, atLeast = false, showing }: { hidden: number; atLeast?: boolean; showing: boolean }) {
  const nav = useNav();
  const overlays = useOverlays();
  if (!mutedNoticeShown(hidden, atLeast, showing)) return null;
  return (
    <p className="fine muted-notice" role="status">
      {showing ? "Showing items that match your muted words." : `${hiddenByMuted(hidden, atLeast, formatCount)}.`}{" "}
      <button type="button" className="link" onClick={() => nav.patchSearch({ muted: showing ? undefined : "show" })}>{showing ? "Hide them again" : hidden === 1 ? "Show it" : "Show them"}</button>
      {" · "}<button type="button" className="link" onClick={() => overlays.open({ kind: "settings", tab: "general" })}>Muted words</button>
    </p>
  );
}
