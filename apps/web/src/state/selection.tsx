import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

/** Select mode for bulk actions. Reset whenever the visible list changes. */
type Selection = {
  selecting: boolean;
  selected: ReadonlySet<string>;
  setSelecting: (on: boolean) => void;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
};

const Ctx = createContext<Selection | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selecting, setSelectingState] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const setSelecting = useCallback((on: boolean) => { setSelectingState(on); setSelected(new Set()); }, []);
  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const selectAll = useCallback((ids: string[]) => setSelected(new Set(ids)), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const value = useMemo(() => ({ selecting, selected, setSelecting, toggle, selectAll, clear }), [selecting, selected, setSelecting, toggle, selectAll, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection(): Selection {
  const v = useContext(Ctx);
  if (!v) throw new Error("SelectionProvider is missing");
  return v;
}
