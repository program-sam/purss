import type { ImportPreview, ImportResult } from "@purss/domain";
import { app } from "@purss/translations/app";
import { plural } from "../../lib/format.ts";

const t = app.data.importSummary;

type Row = { label: string; n: number };

/** What the file holds, in the words people use for it. Zero rows are left out. */
export function inFile(counts: ImportPreview["counts"]): Row[] {
  const rows: [string, string, number | undefined][] = [
    [app.words.sources, "sources", counts.sources], [app.words.collections, "collections", counts.collections], [app.words.baskets, "baskets", counts.baskets],
    [app.words.items, "items", counts.items], [t.inFile.keptItems, "keptItems", counts.keptItems], [t.inFile.captures, "captures", counts.captures],
    [t.inFile.shares, "shares", counts.shares], [t.inFile.annotations, "annotations", counts.annotations],
    [t.inFile.itemReminders, "itemReminders", counts.itemReminders],
  ];
  return rows.flatMap(([label, , n]) => (n ? [{ label, n }] : []));
}

/** What importing would do to this PURSS, as sentences. */
export function effects(counts: ImportPreview["counts"]): string[] {
  const out: string[] = [];
  if (counts.newItems) out.push(t.willBeAdded(plural(counts.newItems, app.words.item)));
  if (counts.existingItems) out.push(t.alreadyHere(plural(counts.existingItems, app.words.item), counts.existingItems));
  if (counts.sourcesToFollow) out.push(t.willBeFollowed(plural(counts.sourcesToFollow, app.words.sourceLower)));
  if (counts.sourcesToReconnect) out.push(t.willNeedReconnecting(plural(counts.sourcesToReconnect, app.words.privateSource), counts.sourcesToReconnect));
  if (counts.shares) out.push(t.sharingSwitchedOff(plural(counts.shares, t.basketOrCollection, t.basketsAndCollections)));
  return out;
}

/** The finished import, as sentences. */
export function resultLines(r: ImportResult): string[] {
  const c = r.created;
  const out: string[] = [];
  const made: string[] = [];
  if (c.items) made.push(plural(c.items, app.words.item));
  if (c.sources) made.push(plural(c.sources, app.words.sourceLower));
  if (c.baskets) made.push(plural(c.baskets, app.words.basketLower));
  if (c.collections) made.push(plural(c.collections, app.words.collectionLower));
  if (c.shares) made.push(t.madeShares(plural(c.shares, t.basketOrCollection, t.basketsAndCollections)));
  out.push(made.length ? t.added(made.join(", ")) : t.nothingNew);
  if (c.keptPins) out.push(t.keptPins(plural(c.keptPins, app.words.keptItem)));
  if (c.captures) out.push(t.capturesRestored(plural(c.captures, t.savedTextCopy, t.savedTextCopies)));
  if (c.reminders) out.push(t.remindersRestored(plural(c.reminders, t.reminder)));
  if (c.annotations) out.push(t.annotationsRestored(plural(c.annotations, app.words.highlightOrNote, app.words.highlightsAndNotes)));
  if (r.alreadyPresent.items || r.alreadyPresent.sources) {
    out.push(t.alreadyPresent([r.alreadyPresent.items ? plural(r.alreadyPresent.items, app.words.item) : "", r.alreadyPresent.sources ? plural(r.alreadyPresent.sources, app.words.sourceLower) : ""].filter(Boolean).join(", ")));
  }
  if (r.following) out.push(t.followingAgain(plural(r.following, app.words.sourceLower)));
  if (r.reconnectRequired) out.push(t.reconnectRequired(plural(r.reconnectRequired, app.words.privateSource), r.reconnectRequired));
  return out;
}
