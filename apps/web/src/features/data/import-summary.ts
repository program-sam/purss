import type { ImportPreview, ImportResult } from "@purss/domain";
import { plural } from "../../lib/format.ts";

type Row = { label: string; n: number };

/** What the file holds, in the words people use for it. Zero rows are left out. */
export function inFile(counts: ImportPreview["counts"]): Row[] {
  const rows: [string, string, number | undefined][] = [
    ["Sources", "sources", counts.sources], ["Collections", "collections", counts.collections], ["Baskets", "baskets", counts.baskets],
    ["Items", "items", counts.items], ["Kept in baskets", "keptItems", counts.keptItems], ["Saved text copies", "captures", counts.captures],
    ["Shared baskets and collections", "shares", counts.shares], ["Your highlights and notes", "annotations", counts.annotations],
    ["Your reminders", "itemReminders", counts.itemReminders],
  ];
  return rows.flatMap(([label, , n]) => (n ? [{ label, n }] : []));
}

/** What importing would do to this PURSS, as sentences. */
export function effects(counts: ImportPreview["counts"]): string[] {
  const out: string[] = [];
  if (counts.newItems) out.push(`${plural(counts.newItems, "item")} will be added.`);
  if (counts.existingItems) out.push(`${plural(counts.existingItems, "item")} ${counts.existingItems === 1 ? "is" : "are"} already here and won't be added again.`);
  if (counts.sourcesToFollow) out.push(`${plural(counts.sourcesToFollow, "source")} will be followed again.`);
  if (counts.sourcesToReconnect) out.push(`${plural(counts.sourcesToReconnect, "private source")} will need reconnecting, because ${counts.sourcesToReconnect === 1 ? "its" : "their"} link wasn't in the file.`);
  if (counts.shares) out.push(`Sharing settings of ${plural(counts.shares, "basket or collection", "baskets and collections")} will come in switched off. Nothing is shared.`);
  return out;
}

/** The finished import, as sentences. */
export function resultLines(r: ImportResult): string[] {
  const c = r.created;
  const out: string[] = [];
  const made: string[] = [];
  if (c.items) made.push(plural(c.items, "item"));
  if (c.sources) made.push(plural(c.sources, "source"));
  if (c.baskets) made.push(plural(c.baskets, "basket"));
  if (c.collections) made.push(plural(c.collections, "collection"));
  if (c.shares) made.push(`sharing settings for ${plural(c.shares, "basket or collection", "baskets and collections")}, switched off`);
  out.push(made.length ? `Added ${made.join(", ")}.` : "Nothing new was added.");
  if (c.keptPins) out.push(`${plural(c.keptPins, "kept item")} put back in baskets.`);
  if (c.captures) out.push(`${plural(c.captures, "saved text copy", "saved text copies")} restored.`);
  if (c.reminders) out.push(`${plural(c.reminders, "reminder")} of yours restored.`);
  if (c.annotations) out.push(`${plural(c.annotations, "highlight or note", "highlights and notes")} of yours restored.`);
  if (r.alreadyPresent.items || r.alreadyPresent.sources) {
    out.push(`Already here and left as they were: ${[r.alreadyPresent.items ? plural(r.alreadyPresent.items, "item") : "", r.alreadyPresent.sources ? plural(r.alreadyPresent.sources, "source") : ""].filter(Boolean).join(", ")}.`);
  }
  if (r.following) out.push(`${plural(r.following, "source")} followed again. New items arrive after the next check.`);
  if (r.reconnectRequired) out.push(`${plural(r.reconnectRequired, "private source")} need${r.reconnectRequired === 1 ? "s" : ""} reconnecting.`);
  return out;
}
