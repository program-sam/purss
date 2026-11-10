import type { KeptCopy, KeptDisplay } from "@purss/domain";
import type { App } from "../app.ts";

/** The longest the first line of a note is made for a list. */
const NOTE_LINE_MAX = 160;

/** The first line of a note, trimmed and cut for a list row; null for a note with nothing in it. */
export function firstNoteLine(body: string | null): string | null {
  const line = (body ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > NOTE_LINE_MAX ? `${line.slice(0, NOTE_LINE_MAX).trimEnd()}…` : line;
}

/** The state of a kept item's copy from its text captures: readable text saved, only part of the page, being saved, failed, or only the link, title and summary. */
export function keptCopyOf(captures: { status: "pending" | "done" | "failed"; quality: string | null }[]): KeptCopy {
  if (captures.some((c) => c.status === "done" && c.quality !== "partial")) return "text";
  if (captures.some((c) => c.status === "done")) return "partial";
  if (captures.some((c) => c.status === "pending")) return "pending";
  if (captures.some((c) => c.status === "failed")) return "failed";
  return "summary";
}

/**
 * What a list says about each kept item without opening it: the state of its copy and the first line of the person's
 * note (the first note, else the first comment on a highlight). One read for the whole page.
 */
export function keptDisplays(app: App, workspaceId: string, itemIds: string[]): Map<string, KeptDisplay> {
  const out = new Map<string, KeptDisplay>();
  if (!itemIds.length) return out;
  const marks = itemIds.map(() => "?").join(",");
  const captures = new Map<string, { status: "pending" | "done" | "failed"; quality: string | null }[]>();
  for (const c of app.db.all<{ item_id: string; status: "pending" | "done" | "failed"; quality: string | null }>(
    `SELECT item_id, status, quality FROM captures WHERE workspace_id = ? AND item_id IN (${marks})`, workspaceId, ...itemIds)) {
    (captures.get(c.item_id) ?? captures.set(c.item_id, []).get(c.item_id)!).push(c);
  }
  const notes = new Map<string, string>();
  for (const a of app.db.all<{ item_id: string; body: string }>(
    `SELECT item_id, body FROM annotations WHERE workspace_id = ? AND deleted_at IS NULL AND body IS NOT NULL AND item_id IN (${marks})
      ORDER BY kind = 'note' DESC, created_at, id`, workspaceId, ...itemIds)) {
    const line = notes.has(a.item_id) ? null : firstNoteLine(a.body);
    if (line) notes.set(a.item_id, line);
  }
  for (const id of itemIds) out.set(id, { copy: keptCopyOf(captures.get(id) ?? []), noteLine: notes.get(id) ?? null });
  return out;
}
