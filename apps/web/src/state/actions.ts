import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { ApiError, messageOf, patch, post } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import type { ClearFreshResult, StateChangeResult } from "../api/types.ts";
import { homeOverviewKey } from "../api/home-queries.ts";
import { dropFromScope, findItem, keys, putItem, refreshWorkspace } from "../api/queries.ts";
import { workflowLabel } from "../lib/constants.ts";
import { newMarkerCleared } from "../lib/items.ts";
import { openItem, undoSeen } from "../lib/open-item.ts";
import type { SeenNotice } from "../lib/open-item.ts";
import { seenNotices } from "./seen-notice.ts";
import { plural } from "../lib/format.ts";
import { isolate } from "../lib/bidi.ts";
import { keepChanges, summariseBatch, workflowChanges } from "../outbox/batch.ts";
import type { Change } from "../outbox/entries.ts";
import { outbox } from "../outbox/instance.ts";
import { droppedLine } from "../outbox/messages.ts";
import type { Outcome } from "../outbox/outbox.ts";
import { serial } from "../outbox/serial.ts";
import { worthRetrying } from "../lib/late-writes.ts";
import { settleProgress } from "./late-progress.ts";
import { progressStore } from "./late-progress-sync.ts";
import { useToasts } from "./toasts.tsx";
import { useWorkspace } from "./workspace.tsx";

/** What an ignored item was before, so Restore can put it back (kept for this visit only). */
const previousWorkflow = new Map<string, WorkflowState>();

function staleLists(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: keys.bootstrap });
  void qc.invalidateQueries({ queryKey: keys.items, refetchType: "none" });
  refillSoon(qc);
}

let refillTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Home's boxes hold a few spare items, so one taken out is replaced at once. After a run of changes they are fetched
 * again to top the spares up, once the changes pause, so rows don't reorder under the pointer while sorting.
 */
function refillSoon(qc: QueryClient): void {
  clearTimeout(refillTimer);
  refillTimer = setTimeout(() => {
    void qc.invalidateQueries({ queryKey: [...keys.items, "preview"], refetchType: "active" });
    void qc.invalidateQueries({ queryKey: homeOverviewKey, refetchType: "active" });
  }, 1500);
}

/**
 * PURSS clears an item's New marker when it is opened or anything is done with it. When that happened, the sidebar's
 * counts and Home's (including "Mark all as seen") follow at once instead of at the next event.
 */
function refreshAfterNewCleared(qc: QueryClient, before: ItemDTO, after: ItemDTO): void {
  if (!newMarkerCleared(before, after)) return;
  void qc.invalidateQueries({ queryKey: keys.bootstrap });
  void qc.invalidateQueries({ queryKey: homeOverviewKey });
}

/** All item-changing actions, each with an Undo toast. Conflicts refresh the item and say so. */
export function useItemActions() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const ws = useWorkspace();
  const session = useSession();
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;

  return useMemo(() => {
    const fail = (err: unknown, itemId?: string) => {
      if (err instanceof ApiError && err.code === "conflict" && itemId) {
        void qc.invalidateQueries({ queryKey: keys.item(itemId) });
        void qc.invalidateQueries({ queryKey: keys.items });
      }
      toast(messageOf(err), { tone: "error" });
    };

    const NOT_SENT = "Not sent yet: it goes as soon as PURSS can be reached.";

    /**
     * Shows the change at once, keeps it on this device and sends it. Resolves with how it ended: confirmed (Undo
     * with PURSS's token), kept for later (Undo takes it back), or refused (shown as it was, with the reason).
     */
    async function changeWorkflow(id: string, workflow: WorkflowState, how: "set" | "restore", revision?: number): Promise<void> {
      const before = findItem(qc, id);
      if (!before) return;
      const label = workflowLabel(workflow, before.kind);
      if (how === "set" && before.workflow === workflow) { toast(`Already ${label.toLowerCase()}`); return; }
      if (how === "set" && workflow === "ignored") previousWorkflow.set(id, before.workflow);
      const message = how === "restore" ? `Restored to ${label}` : workflow === "ignored" ? "Ignored" : `Marked ${label}`;
      putItem(qc, { ...before, workflow, fresh: false });
      const change: Change = { kind: "workflow", itemId: id, from: before.workflow, to: workflow, revision: revision ?? before.revision };
      let out: Outcome;
      try {
        out = await outbox.submit(change);
      } catch (err) { putItem(qc, before); fail(err, id); return; }
      if (out.status === "sent" && out.result.kind === "workflow") {
        if (out.result.item) { putItem(qc, out.result.item); refreshAfterNewCleared(qc, before, out.result.item); }
        staleLists(qc);
        toast(message, { undoToken: out.result.undoToken });
      } else if (out.status === "deferred") {
        const entryId = out.entry.id;
        toast(`${message}. ${NOT_SENT}`, { undo: () => takeBack(entryId, change, () => putItem(qc, before), (revision) => changeWorkflow(id, before.workflow, "set", revision)) });
      } else if (out.status === "dropped") {
        putItem(qc, before);
        void qc.invalidateQueries({ queryKey: keys.item(id) });
        void qc.invalidateQueries({ queryKey: keys.items });
        toast(out.message, { tone: "error" });
      }
    }

    /**
     * Undo for a change that has not been confirmed. One that never left is taken out of the outbox. One that may have
     * reached PURSS (another tab sent it, or its answer was lost) is taken out too and the opposite change is sent,
     * on the item's current revision when that could be read.
     */
    async function takeBack(entryId: string, change: Change, showAgain: () => void, inverse: (revision?: number) => Promise<void>): Promise<void> {
      const r = await outbox.cancel(entryId, change);
      if (r.status === "away") return; // another account is signed in now: nothing of this one to show or send
      if (r.status === "cancelled" || r.status === "pending") { showAgain(); staleLists(qc); return; } // pending: the Undo is kept and goes out with the connection
      await inverse(r.revision);
    }

    /**
     * Several changes at once through the outbox: shown at once, each kept on this device with the revision it was made
     * against, sent in order. One message tells how they ended; Undo reaches the ones that went through (by PURSS's
     * tokens) and the ones still waiting (by taking them back, or sending the opposite change).
     */
    async function sendMany(changes: Change[], describe: (items: number) => string, hooks: { revert: (c: Change) => void; inverse: (c: Change, revision?: number) => Change | null }): Promise<void> {
      let outs: Outcome[];
      try { outs = await outbox.submitMany(changes); } catch (err) { changes.forEach(hooks.revert); fail(err); return; }
      outs.forEach((o, i) => {
        if (o.status !== "sent") return;
        const r = o.result;
        if (r.kind === "workflow" && r.item) putItem(qc, r.item);
        else if (r.kind === "keep") putItem(qc, r.item);
      });
      const sum = summariseBatch(changes, outs);
      sum.dropped.forEach((d) => hooks.revert(d.change));
      refreshWorkspace(qc);
      const refused = sum.dropped.length ? droppedLine(sum.dropped) : "";
      if (!sum.items) { toast(refused, { tone: "error" }); return; }
      const message = [describe(sum.items) + (sum.waiting.length ? `. ${NOT_SENT}` : ""), refused].filter(Boolean).join(" ");
      if (!sum.tokens.length && !sum.waiting.length) { toast(message); return; }
      toast(message, {
        undo: async () => {
          for (const t of sum.tokens.slice().reverse()) await post("/api/undo", { undoToken: t });
          const opposite: Change[] = [];
          for (const w of sum.waiting) {
            const r = await outbox.cancel(w.entryId, w.change);
            if (r.status === "away") continue;
            if (r.status === "cancelled" || r.status === "pending") hooks.revert(w.change);
            else { const inv = hooks.inverse(w.change, r.revision); if (inv) opposite.push(inv); }
          }
          if (opposite.length) await outbox.submitMany(opposite).catch(() => undefined);
          refreshWorkspace(qc);
        },
      });
    }

    async function setWorkflow(ids: string[], workflow: WorkflowState): Promise<void> {
      if (ids.length === 1) { await changeWorkflow(ids[0]!, workflow, "set"); return; }
      const label = workflowLabel(workflow);
      const items = ids.map((id) => findItem(qc, id)).filter((x): x is ItemDTO => !!x);
      const changes = workflowChanges(items, workflow);
      if (!changes.length) { toast(`Already ${label.toLowerCase()}`); return; }
      const before = new Map(items.map((it) => [it.id, it] as const));
      for (const c of changes) {
        const it = before.get(c.itemId)!;
        if (workflow === "ignored") previousWorkflow.set(it.id, it.workflow);
        putItem(qc, { ...it, workflow, fresh: false });
      }
      const verb = workflow === "ignored" ? "Ignored" : `Marked ${label}`;
      await sendMany(changes, (n) => `${verb} for ${plural(n, "item")}`, {
        revert: (c) => { const it = c.kind === "workflow" ? before.get(c.itemId) : undefined; if (it) putItem(qc, it); },
        inverse: (c, revision) => (c.kind === "workflow" ? { kind: "workflow", itemId: c.itemId, from: c.to, to: c.from, revision: revision ?? c.revision } : null),
      });
    }

    async function restore(id: string): Promise<void> {
      const prev = previousWorkflow.get(id);
      await changeWorkflow(id, prev && prev !== "ignored" ? prev : "new", "restore");
    }

    async function keep(id: string, basketId: string, on: boolean): Promise<void> {
      const basket = ws.basketById.get(basketId);
      const before = findItem(qc, id);
      if (!before || !basket) return;
      putItem(qc, { ...before, fresh: false, basketIds: on ? [...new Set([...before.basketIds, basketId])] : before.basketIds.filter((b) => b !== basketId) });
      // A removed item leaves that basket's page at once; Undo refreshes the lists and brings it back.
      if (!on) dropFromScope(qc, `basket:${basketId}`, id);
      const message = `${on ? "Kept in" : "Removed from"} ${isolate(basket.name)}`;
      const change: Change = { kind: "keep", itemId: id, basketId, on };
      let out: Outcome;
      try {
        out = await outbox.submit(change);
      } catch (err) { putItem(qc, before); if (!on) void qc.invalidateQueries({ queryKey: keys.items }); fail(err, id); return; }
      if (out.status === "sent" && out.result.kind === "keep") {
        putItem(qc, out.result.item);
        refreshAfterNewCleared(qc, before, out.result.item);
        void qc.invalidateQueries({ queryKey: keys.item(id) });
        staleLists(qc);
        toast(on && out.result.captureNote ? `${message}. ${out.result.captureNote}` : message, { undoToken: out.result.undoToken });
      } else if (out.status === "deferred") {
        const entryId = out.entry.id;
        toast(`${message}. ${NOT_SENT}`, { undo: () => takeBack(entryId, change, () => { putItem(qc, before); if (!on) void qc.invalidateQueries({ queryKey: keys.items }); }, () => keep(id, basketId, !on)) });
      } else if (out.status === "dropped") {
        putItem(qc, before);
        void qc.invalidateQueries({ queryKey: keys.item(id) });
        void qc.invalidateQueries({ queryKey: keys.items });
        toast(out.message, { tone: "error" });
      }
    }

    async function keepMany(ids: string[], basketIds: string[]): Promise<void> {
      const items = ids.map((id) => findItem(qc, id)).filter((x): x is ItemDTO => !!x);
      const changes = keepChanges(items, ids, basketIds);
      if (!changes.length) { toast("Already kept there"); return; }
      const before = new Map(items.map((it) => [it.id, it] as const));
      for (const it of items) {
        const add = basketIds.filter((b) => !it.basketIds.includes(b));
        if (add.length) putItem(qc, { ...it, fresh: false, basketIds: [...it.basketIds, ...add] });
      }
      const names = basketIds.map((b) => ws.basketById.get(b)?.name).filter((n): n is string => !!n);
      const where = names.length === 1 ? isolate(names[0]!) : plural(names.length, "basket");
      await sendMany(changes, (n) => `Kept ${plural(n, "item")} in ${where}`, {
        revert: (c) => { const it = c.kind === "keep" ? before.get(c.itemId) : undefined; if (it) putItem(qc, it); },
        inverse: (c) => (c.kind === "keep" ? { kind: "keep", itemId: c.itemId, basketId: c.basketId, on: false } : null),
      });
    }

    /**
     * Every New marker in a scope (Mark all as seen). It stays online-only: sent later it would clear items that
     * arrived since, which the person never saw. Offline, it says so instead of failing without a word.
     */
    async function clearFresh(scope: string): Promise<void> {
      const needsConnection = () => toast("Mark all as seen needs a connection. Nothing was changed.", { tone: "error" });
      if (typeof navigator !== "undefined" && navigator.onLine === false) { needsConnection(); return; }
      try {
        const out = await post<ClearFreshResult>("/api/items/clear-fresh", { scope });
        refreshWorkspace(qc);
        if (!out.changed || !out.undoToken) { toast("Nothing new to clear"); return; }
        toast(`Cleared ${plural(out.changed, "new marker")}`, { undoToken: out.undoToken });
      } catch (err) {
        if (err instanceof ApiError && err.code === "offline") needsConnection(); else fail(err);
      }
    }

    async function clearFreshFor(ids: string[]): Promise<void> {
      const before = ids.map((id) => findItem(qc, id)).filter((x): x is ItemDTO => !!x);
      before.forEach((it) => { if (it.fresh) putItem(qc, { ...it, fresh: false }); });
      let out: Outcome;
      try {
        out = await outbox.submit({ kind: "clearFresh", itemIds: ids });
      } catch (err) { before.forEach((it) => putItem(qc, it)); fail(err); return; }
      if (out.status === "sent" && out.result.kind === "clearFresh") {
        refreshWorkspace(qc);
        if (!out.result.changed || !out.result.undoToken) { toast(`${ids.length === 1 ? "That item wasn't" : "Those items weren't"} marked New, so there was nothing to clear`); return; }
        toast(`Cleared ${plural(out.result.changed, "new marker")}`, { undoToken: out.result.undoToken });
      } else if (out.status === "deferred") {
        toast(`Cleared the New markers. ${NOT_SENT}`);
      } else if (out.status === "dropped") {
        before.forEach((it) => putItem(qc, it));
        refreshWorkspace(qc);
        toast(out.message, { tone: "error" });
      }
    }

    /** Opening an item records that it was opened and clears its New marker; the item panel then offers "Marked as seen" with Undo. */
    function markOpened(id: string): Promise<void> {
      return openItem(id, {
        find: (i) => findItem(qc, i),
        put: (item) => putItem(qc, item),
        write: () => serial(id, async () => {
          const cur = findItem(qc, id);
          if (!cur) throw new Error("The item is not loaded");
          const res = await patch<StateChangeResult>(`/api/items/${encodeURIComponent(id)}/state`, { opened: true, expectedRevision: cur.revision });
          outbox.noteOwnWrite(id, cur.revision, res.item.revision);
          return res;
        }),
        newCleared: (before, after) => refreshAfterNewCleared(qc, before, after),
        seen: seenNotices,
        conflict: (i) => void qc.invalidateQueries({ queryKey: keys.item(i) }),
      });
    }

    /** The panel's Undo for "Marked as seen". */
    function undoSeenMarker(notice: SeenNotice): Promise<void> {
      return undoSeen(notice, {
        find: (i) => findItem(qc, i),
        put: (item) => putItem(qc, item),
        undo: async (undoToken) => { await post("/api/undo", { undoToken }); },
        seen: seenNotices,
        refresh: () => refreshWorkspace(qc),
        fail: (err) => toast(messageOf(err), { tone: "error" }),
      });
    }

    /**
     * Reading progress (how far you scrolled), kept separately from workflow; it only ever grows. Silent. Without a
     * connection it is kept on this device and sent when the connection is back (late-progress.ts).
     */
    async function saveProgress(id: string, progress: number): Promise<void> {
      const before = findItem(qc, id);
      const value = Math.round(Math.min(1, Math.max(0, progress)) * 100) / 100;
      if (!before || value <= before.progress) return;
      putItem(qc, { ...before, progress: value, fresh: false });
      try {
        const out = await serial(id, async () => {
          const cur = findItem(qc, id) ?? before;
          const res = await patch<StateChangeResult>(`/api/items/${encodeURIComponent(id)}/state`, { progress: value, expectedRevision: cur.revision });
          outbox.noteOwnWrite(id, cur.revision, res.item.revision);
          return res;
        });
        putItem(qc, out.item);
        refreshAfterNewCleared(qc, before, out.item);
        if (accountId) settleProgress(progressStore(accountId), id, value);
      } catch (err) {
        if (err instanceof ApiError && err.code === "conflict") void qc.invalidateQueries({ queryKey: keys.item(id) });
        else if (accountId && worthRetrying(err)) {
          const waiting = progressStore(accountId);
          if ((waiting.all()[id] ?? -1) < value) waiting.put(id, value);
        }
      }
    }

    return { setWorkflow, restore, keep, keepMany, clearFresh, clearFreshFor, markOpened, undoSeenMarker, saveProgress };
  }, [qc, toast, ws, accountId]);
}
