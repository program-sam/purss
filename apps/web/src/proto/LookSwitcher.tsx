// PROTOTYPE (VITE_PROTO_LOOK=on builds only): cycles the flat looks; the choice lives in ?look= so a reload keeps it.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./flat-look.css";

const LOOKS = [
  { id: "", name: "A · Today" },
  { id: "flat", name: "B · Flat, outlined" },
  { id: "tonal", name: "C · Flat, tonal" },
  { id: "line", name: "D · Flat, line" },
] as const;

function readLook(): number {
  const id = new URLSearchParams(location.search).get("look") ?? "";
  return Math.max(0, LOOKS.findIndex((l) => l.id === id));
}

function Switcher() {
  const [i, setI] = useState(readLook);
  useEffect(() => {
    const id = LOOKS[i].id;
    if (id) document.documentElement.dataset.look = id;
    else delete document.documentElement.dataset.look;
    const url = new URL(location.href);
    if (id) url.searchParams.set("look", id);
    else url.searchParams.delete("look");
    history.replaceState(history.state, "", url);
  }, [i]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable]")) return;
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      setI((n) => (n + (e.key === "ArrowRight" ? 1 : LOOKS.length - 1)) % LOOKS.length);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const step = (d: number) => setI((n) => (n + d + LOOKS.length) % LOOKS.length);
  return (
    <div className="proto-look" data-proto-look>
      <button type="button" onClick={() => step(-1)} aria-label="Previous look">‹</button>
      <span>{LOOKS[i].name}</span>
      <button type="button" onClick={() => step(1)} aria-label="Next look">›</button>
    </div>
  );
}

export function mountLookSwitcher() {
  const host = document.createElement("div");
  document.body.append(host);
  createRoot(host).render(<Switcher />);
}
