import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { itemListQuery } from "../api/queries.ts";
import type { ListParams } from "../api/queries.ts";
import type { ItemDTO, WorkflowState } from "@purss/domain";
import { Avatar, Icon, useBreakpoint } from "@purss/ui";
import { BOARD_COLUMNS, WORKFLOW_LABELS } from "../lib/constants.ts";
import { excludesWorkflow } from "../lib/query-builder.ts";
import { useCurrentPlace } from "../shell/place.ts";
import { useWorkspace } from "../state/workspace.tsx";
import { plural, timeAgo } from "../lib/format.ts";
import { itemDate } from "../lib/items.ts";
import { FreshDot, KeptTag, PendingMark, useFace, useItemLabel } from "../components/item-bits.tsx";
import { useRowCtx, useRowMarks } from "../components/row-context.tsx";
import { setHints, useHints } from "../state/ui-store.ts";

const BoardCard = memo(function BoardCard({ item, onDragStart, onDragEnd }: { item: ItemDTO; onDragStart: (id: string) => void; onDragEnd: () => void }) {
  const c = useRowCtx();
  const face = useFace(item);
  const { active, picked } = useRowMarks(item.id);
  const label = useItemLabel(item, { source: face.name, when: timeAgo(itemDate(item), c.now, c.timeZone), showKept: !c.basket });
  return (
    <li className={`bcard irow${active ? " sel-row" : ""}${picked ? " picked" : ""}${item.workflow === "ignored" ? " dim" : ""}`} data-item={item.id}
      draggable={!c.selecting}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", item.id); e.dataTransfer.effectAllowed = "move"; onDragStart(item.id); }}
      onDragEnd={onDragEnd}>
      <button type="button" className="bcard-main" data-act="open" onClick={() => c.onOpen(item)} aria-label={label}
        aria-pressed={c.selecting ? picked : undefined} aria-current={!c.selecting && active ? "true" : undefined}>
        {c.selecting ? <span className="cbx lead" aria-hidden="true"><Icon name="check" /></span> : null}
        <span className="m"><FreshDot fresh={item.fresh} /><Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} size={18} /><span className="sn" dir="auto">{face.name}</span>
          <time dateTime={itemDate(item)}>{timeAgo(itemDate(item), c.now, c.timeZone)}</time></span>
        <span className="title" dir="auto">{item.title}</span>
        {(item.basketIds.length && !c.basket) ? <span className="bkept"><KeptTag item={item} /><PendingMark id={item.id} /></span> : <PendingMark id={item.id} />}
      </button>
      {c.selecting ? null : (
        <button type="button" className="rmore" aria-haspopup="menu" aria-label={`Actions for ${item.title}`} onClick={(e) => c.onBoardMore(item, e.currentTarget)}><Icon name="more" /></button>
      )}
    </li>
  );
});

type ColumnKey = WorkflowState;

export type BoardParams = Pick<ListParams, "scope" | "sort" | "source" | "without" | "type" | "length" | "muted">;

/** One column's query, paged from the server, with the server's total for the count. */
function useColumn(params: BoardParams, k: ColumnKey) {
  return useInfiniteQuery(itemListQuery({ ...params, filter: k }));
}

/** Workflow board. Drag a card to a column, or use its menu's "Move to" (the keyboard and touch way). */
export function BoardView({ params, onMove }: { params: BoardParams; onMove: (ids: string[], to: WorkflowState) => Promise<void> }) {
  const c = useRowCtx();
  const bp = useBreakpoint();
  const xs = bp === "xs";
  const hints = useHints();
  const [ignOpen, setIgnOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<ColumnKey | null>(null);
  const endDrag = useCallback(() => { setDragId(null); setOver(null); }, []);
  const [note, setNote] = useState<string | null>(null);
  const ws = useWorkspace();
  const place = useCurrentPlace();
  const collection = place?.t === "c" ? ws.collectionById.get(place.id) : undefined;
  const boardRef = useRef<HTMLDivElement>(null);
  const columns: ColumnKey[] = [...BOARD_COLUMNS, "ignored"];
  // A fixed set of columns, so the hooks are always called in the same order.
  const cols = { new: useColumn(params, "new"), toread: useColumn(params, "toread"), inprogress: useColumn(params, "inprogress"), finished: useColumn(params, "finished"), ignored: useColumn(params, "ignored") };
  // Every loaded card goes in the column of its current state, so a moved card shows in its new
  // column straight away instead of vanishing until that column reloads.
  const buckets = useMemo(() => {
    const latest = new Map<string, ItemDTO>();
    for (const k of columns) for (const page of cols[k].data?.pages ?? []) for (const it of page.items) {
      const had = latest.get(it.id);
      if (!had || it.revision > had.revision) latest.set(it.id, it);
    }
    const out = { new: [], toread: [], inprogress: [], finished: [], ignored: [] } as Record<ColumnKey, ItemDTO[]>;
    for (const it of latest.values()) out[it.workflow]?.push(it);
    return out;
  }, [cols.new.data, cols.toread.data, cols.inprogress.data, cols.finished.data, cols.ignored.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const by = (k: ColumnKey) => buckets[k];
  const count = (k: ColumnKey) => cols[k].data?.pages[0]?.total ?? buckets[k].length;

  const scrollTo = (k: string) => {
    const b = boardRef.current, col = b?.querySelector<HTMLElement>(`[data-col="${k}"]`);
    if (b && col) b.scrollTo({ left: col.offsetLeft - b.offsetLeft, behavior: "auto" });
  };
  useEffect(() => { if (xs) scrollTo(hints.boardColumn); }, [xs]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    if (!xs || !boardRef.current) return;
    const b = boardRef.current;
    let best: string | null = null, d = Infinity;
    b.querySelectorAll<HTMLElement>(".bcol").forEach((col) => {
      const dd = Math.abs(col.offsetLeft - b.offsetLeft - b.scrollLeft);
      if (dd < d) { d = dd; best = col.dataset.col ?? null; }
    });
    if (best && best !== hints.boardColumn) setHints({ boardColumn: best });
  };

  function drop(to: ColumnKey) {
    const id = dragId;
    setDragId(null); setOver(null);
    if (!id) return;
    const selected = c.marks.selected();
    const ids = c.selecting && selected.has(id) ? [...selected] : [id];
    // A collection whose own filter leaves this state out would otherwise just lose the card without a word.
    const why = collection ? excludesWorkflow(collection, to) : null;
    setNote(why ? `${ids.length === 1 ? "The card moved" : `${ids.length} cards moved`} to ${WORKFLOW_LABELS[to]} and left this board, because ${why}.` : null);
    // Reload the columns afterwards so counts and order match the server.
    void onMove(ids, to).then(() => { for (const k of columns) void cols[k].refetch(); });
  }

  return (
    <>
      {xs ? (
        <div className="pager-tabs" role="group" aria-label="Board column">
          {columns.map((k) => (
            <button key={k} type="button" aria-pressed={hints.boardColumn === k} onClick={() => { setHints({ boardColumn: k }); scrollTo(k); }}>
              {WORKFLOW_LABELS[k]}<span className="n">{count(k)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {note ? <p className="state note board-note" role="status"><Icon name="info" /><span>{note}</span><button type="button" className="link" onClick={() => setNote(null)}>Dismiss</button></p> : null}
      <div className="board" ref={boardRef} role="group" aria-label="Workflow board" onScroll={onScroll}>
        {columns.map((k) => {
          const list = by(k);
          const label = WORKFLOW_LABELS[k];
          const collapsed = k === "ignored" && !xs && !ignOpen;
          if (collapsed) {
            return (
              <section key={k} className={`bcol ign${over === k ? " drop" : ""}${count(k) === 0 ? " is-empty" : ""}`} data-col={k} aria-label={`${label}, ${count(k)}`}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setOver(k); } }} onDrop={(e) => { e.preventDefault(); drop(k); }}>
                <button type="button" className="bcol-h" aria-expanded="false" onClick={() => setIgnOpen(true)}><span>{label}</span><span className="n" aria-label={plural(count(k), "item")}>{count(k)}</span></button>
                {count(k) ? <button type="button" className="ign-show" onClick={() => setIgnOpen(true)}>Show ignored items<Icon name="chev" size="sm" /></button> : <p className="bcol-empty">Nothing here</p>}
              </section>
            );
          }
          return (
            <section key={k} className={`bcol${k === "ignored" ? " ign open" : ""}${over === k ? " drop" : ""}${count(k) === 0 && !list.length ? " is-empty" : ""}`} data-col={k} aria-label={`${label}, ${count(k)}`}
              style={{ "--lane": laneWeight(count(k)) } as CSSProperties}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(k); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === k ? null : o)); }}
              onDrop={(e) => { e.preventDefault(); drop(k); }}>
              {k === "ignored" && !xs ? (
                <button type="button" className="bcol-h" aria-expanded="true" onClick={() => setIgnOpen(false)}><span>{label}</span><span className="n" aria-label={plural(count(k), "item")}>{count(k)}</span></button>
              ) : (
                <h3 className="bcol-h"><span>{label}</span><span className="n" aria-label={plural(count(k), "item")}>{count(k)}</span></h3>
              )}
              <ul className="bcards" aria-label={label}>
                {list.map((it) => <BoardCard key={it.id} item={it} onDragStart={setDragId} onDragEnd={endDrag} />)}
              </ul>
              {cols[k].hasNextPage ? <button type="button" className="link bcol-more" disabled={cols[k].isFetchingNextPage} onClick={() => void cols[k].fetchNextPage()}>{cols[k].isFetchingNextPage ? "Loading…" : `Show ${Math.max(0, count(k) - list.length)} more`}</button> : null}
            </section>
          );
        })}
      </div>
    </>
  );
}

/** A lane's share of the board grows with what it holds (gently, so a busy lane does not crowd out the rest). */
function laneWeight(n: number): number {
  return n ? 1 + Math.log10(n) : 0;
}
