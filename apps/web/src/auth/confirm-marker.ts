/** Set before a browser leaves for the provider's page, read when it comes back (Shell then says whether it was confirmed). */
export const CONFIRMED_KEY = "purss:confirmed-with";

export function rememberConfirming(label: string, store: Pick<Storage, "setItem"> = sessionStorage, now = Date.now()): void {
  try { store.setItem(CONFIRMED_KEY, JSON.stringify({ label, at: now })); } catch { /* private mode: no notice afterwards */ }
}

/** The provider a browser just left for "Confirm it's you" with (and clears the marker); null when it didn't just come from one. */
export function takeConfirmingProvider(store: Pick<Storage, "getItem" | "removeItem"> = sessionStorage, now = Date.now()): string | null {
  try {
    const raw = store.getItem(CONFIRMED_KEY);
    if (raw === null) return null;
    store.removeItem(CONFIRMED_KEY);
    const v = JSON.parse(raw) as { label?: unknown; at?: unknown };
    return typeof v.label === "string" && typeof v.at === "number" && now - v.at < 15 * 60_000 ? v.label : null;
  } catch { return null; }
}
