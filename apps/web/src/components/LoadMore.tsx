import { useEffect, useRef } from "react";
import { Button } from "@purss/ui";

/** Loads the next page when scrolled into view; the button stays for keyboard and screen-reader users. */
export function LoadMore({ hasMore, loading, onMore }: { hasMore: boolean; loading: boolean; onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onMore);
  cb.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) cb.current(); }, { root: document.getElementById("main"), rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading]);
  if (!hasMore && !loading) return null;
  return (
    <div ref={ref} style={{ textAlign: "center", margin: "16px 0" }}>
      {loading ? <p className="state" style={{ justifyContent: "center" }}><span className="spin" aria-hidden="true" />Loading more…</p> : <Button onClick={onMore}>Show more</Button>}
    </div>
  );
}
