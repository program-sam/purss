/** A small element builder for the popup and options pages (no framework: they are a handful of elements). */
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Replace an element's contents. */
export function show(target: Element, ...children: Child[]): void {
  target.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

/** A short date in the browser's language: "5 Nov 2026". */
export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Follow the browser's light or dark appearance, as PURSS does by default. */
export function followColorScheme(): void {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.setAttribute("data-theme", dark.matches ? "dark" : "light");
  apply();
  dark.addEventListener("change", apply);
}
