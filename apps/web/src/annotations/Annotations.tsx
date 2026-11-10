import type { RefObject } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TextRef } from "@purss/domain";
import { Button, Dialog, Icon } from "@purss/ui";
import { shortDate } from "../lib/format.ts";
import { isTypingTarget } from "../lib/keys.ts";
import { useToasts } from "../state/toasts.tsx";
import { renderHighlights, selectedPassage } from "./highlight-dom.ts";
import type { SelectedPassage } from "./highlight-dom.ts";
import { newAnnotationId } from "./ids.ts";
import { BODY_MAX, QUOTE_MAX } from "./limits.ts";
import type { ViewAnnotation } from "./outbox.ts";
import type { useAnnotations } from "./use-annotations.ts";

/*
 * Highlights and notes in the reader (plan/26). Select text in the article to highlight it or comment
 * on it; press a highlight (or Enter on it) to change its comment or remove it; the item panel lists
 * every highlight and note, including ones whose passage is no longer in the text. Works with touch
 * selection, the keyboard (h and c act on the selected text) and screen readers; the mobile app
 * uses this same UI.
 */

type Annotations = ReturnType<typeof useAnnotations>;

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function highlightLabel(a: ViewAnnotation): string {
  return `Your highlight: ${short(a.quote?.exact ?? "", 80)}${a.body ? ". Has a comment" : ""}. Press to change or remove it.`;
}

/** The article HTML with the highlights drawn in, and which highlights couldn't be found in it. */
export function useHighlightedHtml(html: string | null, annotations: readonly ViewAnnotation[]) {
  return useMemo(() => {
    if (!html) return { html, detached: new Set<string>() };
    const highlights = annotations.flatMap((a) => (a.kind === "highlight" && a.quote ? [{ id: a.id, quote: a.quote, position: a.position, label: highlightLabel(a) }] : []));
    const r = renderHighlights(html, highlights);
    return { html: r.html, detached: r.detached };
  }, [html, annotations]);
}

type Editing = { mode: "new"; passage: SelectedPassage } | { mode: "edit"; id: string };

/**
 * Everything that happens on the article itself: the bar offered for a selection, and the dialog for a
 * highlight's comment. `textRef` names the text being shown, so a new highlight records what it was made on.
 */
export function ReaderHighlights({ proseRef, ann, textRef }: { proseRef: RefObject<HTMLDivElement | null>; ann: Annotations; textRef: TextRef | null }) {
  const { toast } = useToasts();
  const [passage, setPassage] = useState<SelectedPassage | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const held = useRef<SelectedPassage | null>(null);

  // Follow the selection (mouse, touch handles or keyboard) inside the article.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const el = proseRef.current;
        const p = el ? selectedPassage(el) : null;
        setPassage(p);
        if (p) held.current = p;
      }, 120);
    };
    // Scrolling moves the selection on screen, so the bar follows it.
    document.addEventListener("selectionchange", update);
    document.addEventListener("scroll", update, true);
    return () => { clearTimeout(timer); document.removeEventListener("selectionchange", update); document.removeEventListener("scroll", update, true); };
  }, [proseRef]);

  const highlight = useCallback(async (withComment: boolean) => {
    const p = held.current;
    if (!p) return;
    if (p.quote.exact.length > QUOTE_MAX) { toast(`That passage is too long to highlight. Select up to ${QUOTE_MAX.toLocaleString()} characters.`, { tone: "error" }); return; }
    if (withComment) { setEditing({ mode: "new", passage: p }); return; }
    document.getSelection()?.removeAllRanges();
    setPassage(null);
    await ann.save(newAnnotationId(), { kind: "highlight", quote: p.quote, position: p.position, target: textRef, body: null });
    toast("Highlighted");
  }, [ann, textRef, toast]);

  // h highlights and c comments on the selected text, for keyboard selection (caret browsing, screen
  // readers). The selection is read at the key press, so a quick press after selecting still acts on it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.key !== "h" && e.key !== "c") || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || editing) return;
      const el = proseRef.current;
      const p = el ? selectedPassage(el) : null;
      if (!p) return;
      held.current = p;
      e.preventDefault();
      e.stopPropagation();
      void highlight(e.key === "c");
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [proseRef, highlight, editing]);

  // Pressing a highlight opens it; links inside a highlight still work, and finishing a selection isn't a press.
  useEffect(() => {
    const el = proseRef.current;
    if (!el) return;
    const open = (target: EventTarget | null, startOnly: boolean) => {
      const t = target as HTMLElement | null;
      if (!t || t.closest("a")) return false;
      const mark = t.closest<HTMLElement>(startOnly ? "mark[data-anno-start]" : "mark[data-anno]");
      if (!mark) return false;
      const id = startOnly ? mark.dataset.annoStart : mark.dataset.anno?.split(" ").pop();
      if (!id) return false;
      setEditing({ mode: "edit", id });
      return true;
    };
    const click = (e: MouseEvent) => {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
      open(e.target, false);
    };
    const key = (e: KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && open(e.target, true)) e.preventDefault(); };
    el.addEventListener("click", click);
    el.addEventListener("keydown", key);
    return () => { el.removeEventListener("click", click); el.removeEventListener("keydown", key); };
  });

  const current = editing?.mode === "edit" ? ann.annotations.find((a) => a.id === editing.id) ?? null : null;
  return (
    <>
      {passage && !editing ? <SelectionBar rect={passage.rect} onHighlight={() => void highlight(false)} onComment={() => void highlight(true)} /> : null}
      {editing?.mode === "new" ? (
        <HighlightDialog quote={editing.passage.quote.exact} initial="" isNew onClose={() => setEditing(null)}
          onSave={async (body) => {
            const p = editing.passage;
            setEditing(null);
            document.getSelection()?.removeAllRanges();
            setPassage(null);
            await ann.save(newAnnotationId(), { kind: "highlight", quote: p.quote, position: p.position, target: textRef, body: body || null });
            toast("Highlighted with your comment");
          }} />
      ) : null}
      {current && current.quote ? (
        <HighlightDialog quote={current.quote.exact} initial={current.body ?? ""} onClose={() => setEditing(null)}
          onSave={async (body) => {
            setEditing(null);
            await ann.save(current.id, { kind: "highlight", quote: current.quote!, position: current.position, target: current.target, body: body || null });
            toast("Comment saved");
          }}
          onRemove={async () => {
            setEditing(null);
            await removeWithUndo(ann, current, toast);
          }} />
      ) : null}
    </>
  );
}

async function removeWithUndo(ann: Annotations, a: ViewAnnotation, toast: ReturnType<typeof useToasts>["toast"]): Promise<void> {
  await ann.remove(a.id);
  const restore = a.kind === "highlight" && a.quote
    ? () => ann.save(a.id, { kind: "highlight", quote: a.quote!, position: a.position, target: a.target, body: a.body })
    : () => ann.save(a.id, { kind: "note", body: a.body ?? "" });
  toast(a.kind === "highlight" ? "Highlight removed" : "Note removed", { undo: restore });
}

/** The small bar offered under a selection: below it, so a phone's own selection menu above it stays clear. */
function SelectionBar({ rect, onHighlight, onComment }: { rect: DOMRect; onHighlight: () => void; onComment: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 10);
    setPos({ left, top });
  }, [rect]);
  // Pressing the bar must not clear the selection it acts on.
  const keep = (e: { preventDefault: () => void }) => e.preventDefault();
  return createPortal(
    <div ref={ref} className="sel-bar" role="toolbar" aria-label="Selected text" onPointerDown={keep} onMouseDown={keep}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      <button type="button" className="btn" aria-keyshortcuts="h" onClick={onHighlight}><Icon name="check" size="sm" />Highlight</button>
      <button type="button" className="btn" aria-keyshortcuts="c" onClick={onComment}>Add comment</button>
    </div>,
    document.body,
  );
}

function HighlightDialog({ quote, initial, isNew, onClose, onSave, onRemove }: {
  quote: string; initial: string; isNew?: boolean; onClose: () => void; onSave: (body: string) => Promise<void>; onRemove?: () => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const id = useId();
  return (
    <Dialog title={isNew ? "Add a comment" : "Your highlight"} size="sm" onClose={onClose} initialFocus="textarea"
      footer={<>
        {onRemove ? <Button variant="danger" onClick={() => void onRemove()}>Remove highlight</Button> : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void onSave(text.trim())}>{isNew ? "Save highlight" : "Save"}</Button>
      </>}>
      <blockquote className="anno-quote">{short(quote, 600)}</blockquote>
      <label className="lbl" htmlFor={id}>Comment</label>
      <textarea id={id} className="in anno-text" rows={4} maxLength={BODY_MAX} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="What you think about this passage (optional)" />
    </Dialog>
  );
}

function SyncNote({ a, ann }: { a: ViewAnnotation; ann: Annotations }) {
  if (a.sync === "synced") return null;
  if (a.sync === "waiting") return <span className="anno-sync"><Icon name="clock" size="sm" />Waiting to sync</span>;
  return (
    <span className="anno-sync failed" role="alert">
      <Icon name="alert" size="sm" />Couldn't save: {a.error}
      <button type="button" className="link" onClick={() => void ann.retry(a.id)}>Try again</button>
      <button type="button" className="link" onClick={() => void ann.discard(a.id)}>Discard this change</button>
    </span>
  );
}

/**
 * The item panel's list: item notes (add, change, remove) and every highlight with its comment. A
 * highlight whose passage isn't in the text shown is listed as not found, with its quote; it is never dropped.
 */
export function NotesSection({ ann, detached, hasText, proseRef, tz }: {
  ann: Annotations; detached: ReadonlySet<string>; hasText: boolean; proseRef: RefObject<HTMLDivElement | null>; tz: string | null;
}) {
  const { toast } = useToasts();
  const [adding, setAdding] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const notes = ann.annotations.filter((a) => a.kind === "note");
  const highlights = ann.annotations.filter((a) => a.kind === "highlight");
  const waiting = ann.annotations.filter((a) => a.sync === "waiting").length;
  const headingId = useId();

  const show = (id: string) => {
    const mark = proseRef.current?.querySelector<HTMLElement>(`mark[data-anno-start="${CSS.escape(id)}"]`);
    if (!mark) return;
    mark.scrollIntoView({ block: "center", behavior: "smooth" });
    mark.focus({ preventScroll: true });
  };

  return (
    <section className="anno-notes" aria-labelledby={headingId}>
      <div className="lbl" id={headingId}>Your notes and highlights</div>
      {waiting ? <p className="fine" role="status">{waiting === 1 ? "1 change is" : `${waiting} changes are`} waiting to sync. {waiting === 1 ? "It is" : "They are"} saved on this device and sent when the connection is back.</p> : null}
      {ann.unavailable ? <p className="fine">Your notes on this item can't be shown without a connection. Anything you add now is kept and synced later.</p> : null}
      {notes.map((n) => editingNote === n.id ? (
        <NoteEditor key={n.id} initial={n.body ?? ""} onCancel={() => setEditingNote(null)}
          onSave={async (body) => { setEditingNote(null); await ann.save(n.id, { kind: "note", body }); toast("Note saved"); }} />
      ) : (
        <article key={n.id} className="anno-item">
          <p className="anno-body">{n.body}</p>
          <p className="fine anno-meta">
            <span>Note · {shortDate(n.updatedAt, Date.now(), tz ?? undefined)}</span>
            <SyncNote a={n} ann={ann} />
            <button type="button" className="link" onClick={() => setEditingNote(n.id)}>Edit<span className="sr"> note</span></button>
            <button type="button" className="link" onClick={() => void removeWithUndo(ann, n, toast)}>Remove<span className="sr"> note</span></button>
          </p>
        </article>
      ))}
      {adding ? (
        <NoteEditor initial="" onCancel={() => setAdding(false)}
          onSave={async (body) => { setAdding(false); await ann.save(newAnnotationId(), { kind: "note", body }); toast("Note added"); }} />
      ) : <div><Button onClick={() => setAdding(true)}><Icon name="plus" size="sm" />Add a note</Button></div>}
      {highlights.length ? (
        <ul className="anno-list" aria-label="Highlights">
          {highlights.map((h) => (
            <li key={h.id} className="anno-item">
              <blockquote className="anno-quote">{short(h.quote?.exact ?? "", 280)}</blockquote>
              {h.body ? <p className="anno-body">{h.body}</p> : null}
              <p className="fine anno-meta">
                {detached.has(h.id) ? <span className="anno-detached"><Icon name="info" size="sm" />Not found in the text shown. Your highlight is kept with its quote.</span> : null}
                <SyncNote a={h} ann={ann} />
                {hasText && !detached.has(h.id) ? <button type="button" className="link" onClick={() => show(h.id)}>Show in text</button> : null}
                <button type="button" className="link" onClick={() => void removeWithUndo(ann, h, toast)}>Remove<span className="sr"> highlight</span></button>
              </p>
            </li>
          ))}
        </ul>
      ) : hasText ? <p className="fine">Select text in the article to highlight it or add a comment.</p> : null}
    </section>
  );
}

function NoteEditor({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const save = () => { if (text.trim()) void onSave(text.trim()); };
  return (
    <div className="anno-editor">
      <label className="sr" htmlFor={id}>Note</label>
      <textarea ref={ref} id={id} className="in anno-text" rows={3} maxLength={BODY_MAX} value={text} placeholder="Your note about this item"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        }} />
      <div className="anno-actions">
        <Button variant="primary" disabled={!text.trim()} onClick={save}>Save note</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
