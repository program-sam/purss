import test from "node:test";
import assert from "node:assert/strict";
import { batch, entry, makeOwner, makeSource, makeTestApp } from "../testing.ts";
import { applySyncBatch } from "./sync.ts";
import { createBasket } from "./collections.ts";
import { getItem, listItems } from "./items.ts";
import { keepItem } from "./state.ts";
import { putAnnotation } from "./annotations.ts";
import { firstNoteLine, keptCopyOf, keptDisplays } from "./kept-display.ts";
import { searchItems, noteSnippets } from "./search.ts";
import { searchSnippets } from "./items.ts";

const at = () => new Date().toISOString();

function kept() {
  const { app, cleanup } = makeTestApp();
  const p = makeOwner(app);
  makeSource(app, p, "Workbench", "feed/w");
  applySyncBatch(app, p.engineUserId, batch(["Mains supply", "Bobbin case", "Threading", "Not kept"].map((title) => entry("feed/w", { title, summaryHtml: `<p>${title} video about tools</p>` }))));
  const basket = createBasket(app, p, { name: "Checked", captureMode: "metadata" });
  const ids = Object.fromEntries(listItems(app, p, { scope: "all", filter: "all" }).items.map((i) => [i.title, i.id]));
  for (const t of ["Mains supply", "Bobbin case", "Threading"]) keepItem(app, p, ids[t]!, basket.id);
  return { app, p, basket, ids, cleanup };
}

const capture = (app: ReturnType<typeof kept>["app"], p: ReturnType<typeof kept>["p"], itemId: string, status: string, quality: string | null) =>
  app.db.run("INSERT INTO captures (id, workspace_id, item_id, kind, status, quality, created_at) VALUES (?, ?, ?, 'fulltext', ?, ?, ?)", `cap_${itemId}_${status}_${quality}`, p.workspaceId, itemId, status, quality, at());

test("a kept item's copy is read from its captures: text, part of the page, being saved, failed, or only the summary", () => {
  assert.equal(keptCopyOf([]), "summary");
  assert.equal(keptCopyOf([{ status: "done", quality: "full" }]), "text");
  assert.equal(keptCopyOf([{ status: "done", quality: null }]), "text");
  assert.equal(keptCopyOf([{ status: "done", quality: "partial" }]), "partial");
  assert.equal(keptCopyOf([{ status: "failed", quality: null }, { status: "done", quality: "partial" }]), "partial");
  assert.equal(keptCopyOf([{ status: "failed", quality: null }, { status: "done", quality: null }]), "text", "a later success beats an earlier failure");
  assert.equal(keptCopyOf([{ status: "pending", quality: null }]), "pending");
  assert.equal(keptCopyOf([{ status: "failed", quality: null }]), "failed");
});

test("the first line of a note is what a list shows", () => {
  assert.equal(firstNoteLine("NOT CHECKED YET. Mains voltage inside.\nSecond line."), "NOT CHECKED YET. Mains voltage inside.");
  assert.equal(firstNoteLine("\n\n  Late first line  \nNext"), "Late first line");
  assert.equal(firstNoteLine("x".repeat(300))!.length, 161);
  assert.equal(firstNoteLine("   "), null);
  assert.equal(firstNoteLine(null), null);
});

test("lists carry the copy state and the first line of the note for kept items only", (t) => {
  const { app, p, ids, cleanup } = kept();
  t.after(cleanup);
  capture(app, p, ids["Mains supply"]!, "done", "full");
  capture(app, p, ids["Bobbin case"]!, "failed", null);
  putAnnotation(app, p, ids["Mains supply"]!, "ann_1", { kind: "note", body: "NOT CHECKED YET\nMains voltage inside", updatedAt: at() } as never);
  const items = Object.fromEntries(listItems(app, p, { scope: "all", filter: "all" }).items.map((i) => [i.title, i]));
  assert.deepEqual(items["Mains supply"]!.kept, { copy: "text", noteLine: "NOT CHECKED YET" });
  assert.deepEqual(items["Bobbin case"]!.kept, { copy: "failed", noteLine: null });
  assert.deepEqual(items["Threading"]!.kept, { copy: "summary", noteLine: null });
  assert.equal(items["Not kept"]!.kept, undefined, "an item that is in no basket has nothing to say");
  assert.deepEqual(getItem(app, p, ids["Mains supply"]!).kept, { copy: "text", noteLine: "NOT CHECKED YET" });
});

test("a removed note leaves no line, and another PURSS's notes are never read", (t) => {
  const { app, p, ids, cleanup } = kept();
  t.after(cleanup);
  putAnnotation(app, p, ids["Mains supply"]!, "ann_1", { kind: "note", body: "First", updatedAt: at() } as never);
  assert.equal(keptDisplays(app, p.workspaceId, [ids["Mains supply"]!]).get(ids["Mains supply"]!)!.noteLine, "First");
  assert.equal(keptDisplays(app, "wsp_other", [ids["Mains supply"]!]).get(ids["Mains supply"]!)!.noteLine, null);
  app.db.run("UPDATE annotations SET deleted_at = ? WHERE id = 'ann_1'", at());
  assert.equal(keptDisplays(app, p.workspaceId, [ids["Mains supply"]!]).get(ids["Mains supply"]!)!.noteLine, null);
});

test("a search that matched only a note gets a snippet from the note", (t) => {
  const { app, p, ids, cleanup } = kept();
  t.after(cleanup);
  putAnnotation(app, p, ids["Mains supply"]!, "ann_1", { kind: "note", body: "CHECKED against the Singer 4423 manual; tiny turns only", updatedAt: at() } as never);
  const found = searchItems(app, p, "4423");
  assert.deepEqual(found.map((i) => i.title), ["Mains supply"]);
  const own = searchSnippets(app, found.map((i) => i.id), "4423");
  assert.deepEqual(own, {}, "the item's own text does not hold it");
  const notes = noteSnippets(app, p, found.map((i) => i.id).filter((id) => !own[id]), "4423");
  assert.equal(notes[ids["Mains supply"]!], "CHECKED against the Singer \u00014423\u0002 manual; tiny turns only");
  assert.deepEqual(noteSnippets(app, p, [ids["Mains supply"]!], "voltage"), {}, "a word that is not in the note gives nothing");
});
