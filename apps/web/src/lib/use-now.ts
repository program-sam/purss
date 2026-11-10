import { useEffect, useState } from "react";

/** The current time, refreshed every minute so "5 min ago" labels stay honest. */
export function useNow(ms = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Width of the main scrolling area, for deciding how many Home columns fit. */
export function useMainWidth(): number {
  const [w, setW] = useState(() => document.getElementById("main")?.clientWidth ?? window.innerWidth);
  useEffect(() => {
    const el = document.getElementById("main");
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return w;
}
