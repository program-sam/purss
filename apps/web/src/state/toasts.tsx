import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ToastView } from "@purss/ui";
import type { ToastAction } from "@purss/ui";
import { messageOf, post } from "../api/client.ts";
import { refreshWorkspace } from "../api/queries.ts";
import type { UndoResult } from "../api/types.ts";
import { isTypingTarget, isUndoKey } from "../lib/keys.ts";
import { keyboardLikely } from "../lib/keyboard.ts";
import { cue } from "../lib/sound.ts";

/** How long a message that offers Undo (or another action) stays: long enough to find it with the keyboard. */
const ACTION_TOAST_MS = 20_000;
const PLAIN_TOAST_MS = 4_000;

const onMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export type ToastOptions = {
  /** Server undo token: shows Undo and posts it to /api/undo. */
  undoToken?: string | null;
  /** Custom undo (for changes undone another way, such as unfollowing a just-added source). */
  undo?: (() => Promise<void> | void) | null;
  actions?: ToastAction[];
  sticky?: boolean;
  /** Outcome sound. Default: a subtle success for undoable changes, otherwise silent. */
  tone?: "success" | "error" | "none";
};

type Toasts = {
  toast: (message: string, opts?: ToastOptions) => void;
  /** Polite announcement for screen readers without a visible toast. */
  say: (message: string) => void;
};

const Ctx = createContext<Toasts | null>(null);

export function useToasts(): Toasts {
  const v = useContext(Ctx);
  if (!v) throw new Error("ToastProvider is missing");
  return v;
}

type Live = { id: number; message: string; undo: (() => void) | null; actions: ToastAction[]; sticky: boolean };

export function ToastProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<Live | null>(null);
  const [announce, setAnnounce] = useState("");
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef<Live | null>(null);
  live.current = current;
  /** A sticky message (such as "A new version is ready") that a passing message covers for a while; it comes back after. */
  const held = useRef<Live | null>(null);

  const clear = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  /** Close what is showing; a sticky message it covered comes back. */
  const dismiss = useCallback(() => { clear(); const back = held.current; held.current = null; live.current = back; setCurrent(back); }, [clear]);
  const arm = useCallback((shown: Live) => {
    clear();
    if (shown.sticky) return;
    timer.current = setTimeout(() => {
      if (live.current?.id !== shown.id) return;
      const back = held.current;
      held.current = null;
      live.current = back;
      setCurrent(back);
    }, shown.undo || shown.actions.length ? ACTION_TOAST_MS : PLAIN_TOAST_MS);
  }, [clear]);
  /** Show a message; one that isn't sticky covers a sticky one instead of discarding it. */
  const show = useCallback((next: Live) => {
    const now = live.current;
    if (next.sticky) held.current = null;
    else if (now?.sticky) held.current = now;
    live.current = next;
    setCurrent(next);
    arm(next);
  }, [arm]);

  const say = useCallback((message: string) => {
    setAnnounce("");
    setTimeout(() => setAnnounce(message), 30);
  }, []);

  const toast = useCallback((message: string, opts: ToastOptions = {}) => {
    const id = ++seq.current;
    const undoFn = opts.undo ?? (opts.undoToken ? async () => { await post<UndoResult>("/api/undo", { undoToken: opts.undoToken }); refreshWorkspace(qc); } : null);
    const next: Live = {
      id, message, sticky: !!opts.sticky, actions: (opts.actions ?? []).map((a) => ({ ...a, onSelect: () => { dismiss(); a.onSelect(); } })),
      undo: undoFn ? () => {
        dismiss();
        Promise.resolve(undoFn()).then(() => show({ id: ++seq.current, message: "Undone.", undo: null, actions: [], sticky: false }),
          (err) => show({ id: ++seq.current, message: messageOf(err), undo: null, actions: [], sticky: false }));
      } : null,
    };
    show(next);
    // The key is named only where a keyboard is likely; on a touch screen the Undo button is the way.
    say(!undoFn ? message : keyboardLikely() ? `${message}. Press ${onMac() ? "Command" : "Control"} Z to undo.` : `${message}. Undo is available.`);
    const tone = opts.tone ?? (undoFn ? "success" : "none");
    if (tone === "success") cue("success", { emphasis: "subtle" });
    else if (tone === "error") cue("error");
  }, [qc, show, dismiss, say]);

  useEffect(() => clear, [clear]);

  // Ctrl/Cmd+Z presses Undo on the message that is showing.
  const showing = useRef<Live | null>(null);
  showing.current = current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const undo = showing.current?.undo;
      if (!undo || !isUndoKey(e, isTypingTarget(e.target))) return;
      e.preventDefault();
      undo();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const value = useMemo(() => ({ toast, say }), [toast, say]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div id="toasts" role="status" aria-live="polite">
        {current ? (
          <ToastView key={current.id} message={current.message} undo={current.undo} actions={current.actions} onDismiss={dismiss}
            onHold={clear} onRelease={() => arm(current)} />
        ) : null}
      </div>
      <div className="sr" aria-live="polite">{announce}</div>
    </Ctx.Provider>
  );
}
