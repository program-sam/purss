/**
 * Put focus on the heading of the page just shown in `main`, so a screen reader announces it and the next Tab starts
 * inside the page. A page that is still loading gets a moment to draw its heading. Nothing moves if the person has
 * already focused something inside the page.
 */
export function focusPageHeading(main: HTMLElement | null, wait = 2000): () => void {
  if (!main) return () => {};
  const settled = () => {
    const a = document.activeElement;
    return !!a && a !== document.body && a !== main && main.contains(a);
  };
  const place = (): boolean => {
    const h = main.querySelector<HTMLElement>("h1");
    if (!h) return false;
    if (!settled()) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    return true;
  };
  // The page that was left may still be in `main` for a frame; look once it has been replaced.
  let seen = false;
  const frame = requestAnimationFrame(() => { seen = place(); });
  const observer = new MutationObserver(() => { if (!seen && place()) { seen = true; observer.disconnect(); } });
  observer.observe(main, { childList: true, subtree: true });
  const timer = setTimeout(() => observer.disconnect(), wait);
  return () => { cancelAnimationFrame(frame); observer.disconnect(); clearTimeout(timer); };
}
