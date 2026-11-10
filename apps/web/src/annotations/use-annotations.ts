import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { AnnotationList, AnnotationPut, AnnotationWriteResult } from "@purss/domain";
import { ApiError, del, get, put } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { keys } from "../api/queries.ts";
import { onResume } from "../offline/status.ts";
import { useToasts } from "../state/toasts.tsx";
import { mergeView, ofAccount } from "./outbox.ts";
import type { Change, OutboxEntry, SendOutcome, ViewAnnotation } from "./outbox.ts";
import { outbox } from "./outbox-store.ts";

/** An item's highlights and notes as the server has them. Read through the worker, so the device keeps a copy for offline reading. */
export const annotationsQuery = (itemId: string) => queryOptions({
  queryKey: keys.annotations(itemId),
  queryFn: ({ signal }) => get<AnnotationList>(`/api/items/${encodeURIComponent(itemId)}/annotations`, undefined, signal),
  staleTime: 30_000,
});

const annotationPath = (e: OutboxEntry) => `/api/items/${encodeURIComponent(e.itemId)}/annotations/${encodeURIComponent(e.annotationId)}`;

/** Send one outbox entry. Offline, a busy server or an ended session mean "later"; anything else the server refuses is final. */
async function send(e: OutboxEntry): Promise<SendOutcome> {
  try {
    const result = e.op === "put"
      ? await put<AnnotationWriteResult>(annotationPath(e), e.body)
      : await del<AnnotationWriteResult>(annotationPath(e), { updatedAt: e.at });
    return { kind: "done", result };
  } catch (err) {
    if (!(err instanceof ApiError)) return { kind: "later" };
    if (err.code === "offline" || err.status === 401 || err.status === 403 || err.status === 429 || (err.status >= 500 && err.status !== 507)) return { kind: "later" };
    return { kind: "refused", message: err.message };
  }
}

/** Put the server's answer into the item's cached list at once, then refresh it (which also refreshes this device's saved copy). */
function applyResult(qc: QueryClient, entry: OutboxEntry, result: AnnotationWriteResult): void {
  qc.setQueryData<AnnotationList>(keys.annotations(entry.itemId), (old) => {
    if (!old) return old;
    const a = result.annotation;
    const had = old.annotations.some((x) => x.id === entry.annotationId);
    const annotations = a
      ? (had ? old.annotations.map((x) => (x.id === a.id ? a : x)) : [...old.annotations, a])
      : old.annotations.filter((x) => x.id !== entry.annotationId);
    return { ...old, annotations };
  });
  void qc.invalidateQueries({ queryKey: keys.annotations(entry.itemId) });
}

/** Send what is waiting for this account. */
export function syncAnnotations(qc: QueryClient, accountId: string): Promise<void> {
  return outbox.flush(accountId, send, (entry, result) => applyResult(qc, entry, result));
}

function useOutboxEntries(): readonly OutboxEntry[] {
  return useSyncExternalStore((fn) => outbox.subscribe(fn), () => outbox.snapshot(), () => outbox.snapshot());
}

function useAccountId(): string | null {
  const session = useSession();
  return session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;
}

/** Changes of this account still waiting to be sent (failed ones included). */
export function useWaitingCount(): number {
  const accountId = useAccountId();
  return ofAccount(useOutboxEntries(), accountId).length;
}

/** Unsent changes on this device made with another account (only the apps keep them; see AnnotationSync). */
export function useOtherAccountsUnsent(): { entries: readonly OutboxEntry[]; discard: () => Promise<void> } {
  const accountId = useAccountId();
  const all = useOutboxEntries();
  const entries = useMemo(() => (accountId ? all.filter((e) => e.accountId !== accountId) : []), [all, accountId]);
  const discard = useCallback(() => (accountId ? outbox.clearExcept(accountId) : Promise.resolve()), [accountId]);
  return { entries, discard };
}

export type AnnotationDraft =
  | { kind: "highlight"; quote: { exact: string; prefix: string; suffix: string }; position: { start: number; end: number } | null; target: { kind: "capture" | "version"; id: string } | null; body: string | null }
  | { kind: "note"; body: string };

/**
 * One item's highlights and notes for the reader: the server's, with this device's unsent changes laid
 * over them, and the actions that change them. `annotatedAt` (from the item) tells an item that has
 * never been annotated apart from one whose list couldn't be loaded offline.
 */
export function useAnnotations(itemId: string, annotatedAt: string | null) {
  const qc = useQueryClient();
  const accountId = useAccountId();
  const q = useQuery(annotationsQuery(itemId));
  const entries = useOutboxEntries();
  const server = q.data?.annotations;
  const view: ViewAnnotation[] = useMemo(() => mergeView(server ?? [], ofAccount(entries, accountId), itemId), [server, entries, accountId, itemId]);

  const record = useCallback(async (entry: { annotationId: string; at: string } & ({ op: "put"; body: AnnotationPut } | { op: "delete" })) => {
    if (!accountId) return;
    await outbox.record({ ...entry, accountId, itemId } as Change);
    void syncAnnotations(qc, accountId);
  }, [qc, accountId, itemId]);

  const save = useCallback((annotationId: string, draft: AnnotationDraft) => {
    const at = new Date().toISOString();
    const body: AnnotationPut = { ...draft, updatedAt: at };
    return record({ annotationId, at, op: "put", body });
  }, [record]);

  const remove = useCallback((annotationId: string) => record({ annotationId, at: new Date().toISOString(), op: "delete" }), [record]);

  const retry = useCallback(async (annotationId: string) => {
    const e = ofAccount(outbox.snapshot(), accountId).find((x) => x.annotationId === annotationId);
    if (!e || !accountId) return;
    await outbox.retry(e.seq!);
    void syncAnnotations(qc, accountId);
  }, [qc, accountId]);

  const discard = useCallback(async (annotationId: string) => {
    const e = ofAccount(outbox.snapshot(), accountId).find((x) => x.annotationId === annotationId);
    if (e) await outbox.discard(e.seq!);
  }, [accountId]);

  return {
    annotations: view,
    loading: q.isPending && annotatedAt !== null,
    /** The item has annotations but they couldn't be loaded (offline, with no copy on this device). */
    unavailable: !q.data && q.isError && annotatedAt !== null,
    save, remove, retry, discard,
  };
}

/**
 * Renders nothing. Loads the outbox and sends what is waiting: at start, when the connection returns,
 * when the page is shown again, and every ten seconds while something waits (the browser's "online"
 * can come before the network works). In a browser, which several people may share, other accounts'
 * unsent changes are deleted when someone else signs in. The apps keep them (`keepOtherAccounts`):
 * they are sent when that account connects again, and Settings → This device offers to copy or
 * discard them.
 */
export function AnnotationSync({ keepOtherAccounts = false }: { keepOtherAccounts?: boolean }) {
  const qc = useQueryClient();
  const accountId = useAccountId();
  const waiting = useWaitingCount();
  useEffect(() => {
    if (!accountId) return;
    const flush = () => { void syncAnnotations(qc, accountId); };
    void (keepOtherAccounts ? outbox.load() : outbox.clearExcept(accountId)).then(flush);
    return onResume(flush);
  }, [qc, accountId, keepOtherAccounts]);
  const others = useOtherAccountsUnsent().entries.length;
  const { toast } = useToasts();
  const told = useRef(false);
  useEffect(() => {
    if (!keepOtherAccounts || !others || told.current) return;
    told.current = true;
    toast(`${others === 1 ? "1 highlight or note" : `${others} highlights or notes`} from another account ${others === 1 ? "is" : "are"} waiting on this device. Copy or discard ${others === 1 ? "it" : "them"} in Settings → This device.`);
  }, [keepOtherAccounts, others, toast]);
  useEffect(() => {
    if (!accountId || !waiting) return;
    const timer = setInterval(() => { if (navigator.onLine !== false) void syncAnnotations(qc, accountId); }, 10_000);
    return () => clearInterval(timer);
  }, [qc, accountId, waiting]);
  return null;
}

/** Sign-out: unsent changes on this device are deleted with the other offline data. */
export function clearAnnotationOutbox(): Promise<void> {
  return outbox.clearExcept(null);
}
