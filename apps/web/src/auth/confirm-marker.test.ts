import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMED_KEY, takeConfirmingProvider } from "./confirm-marker.ts";

const store = (value: string | null) => {
  const items = new Map<string, string>(value === null ? [] : [[CONFIRMED_KEY, value]]);
  return { getItem: (k: string) => items.get(k) ?? null, removeItem: (k: string) => { items.delete(k); }, items };
};

test("coming back from a provider's page names it once, and only for a short while", () => {
  const now = 1_000_000;
  const fresh = store(JSON.stringify({ label: "Google", at: now - 60_000 }));
  assert.equal(takeConfirmingProvider(fresh, now), "Google");
  assert.equal(fresh.items.size, 0, "cleared, so a later page load says nothing");
  assert.equal(takeConfirmingProvider(fresh, now), null);
  assert.equal(takeConfirmingProvider(store(JSON.stringify({ label: "Google", at: now - 16 * 60_000 })), now), null, "stale");
  assert.equal(takeConfirmingProvider(store("not json"), now), null);
  assert.equal(takeConfirmingProvider(store(JSON.stringify({ label: 5, at: now })), now), null);
  assert.equal(takeConfirmingProvider(store(null), now), null);
});
