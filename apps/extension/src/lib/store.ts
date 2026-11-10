import type { Connection } from "./api.ts";
import { ext } from "./browser.ts";

/*
 * What the extension remembers, in the browser's extension storage (never synced): the connection
 * with its device token, the server last connected to, the basket names for the context menu, the
 * basket last kept in, and the person's choices.
 */

export type BasketRef = { id: string; name: string };
export type Settings = {
  /** Mark pages already in the PURSS on the toolbar button as they open (off unless turned on). */
  autoBadge: boolean;
  /** Keep the page's text with it, as the browser shows it. */
  keepText: boolean;
};
const DEFAULTS: Settings = { autoBadge: false, keepText: false };

export async function getConnection(): Promise<Connection | null> {
  const { connection } = await ext().storage.local.get("connection");
  const c = connection as Connection | undefined;
  return c && typeof c.origin === "string" && typeof c.token === "string" ? c : null;
}

export async function setConnection(c: Connection): Promise<void> {
  await ext().storage.local.set({ connection: c });
}

/** Forget the connection and everything learnt from that PURSS. Settings stay. */
export async function forgetConnection(): Promise<void> {
  await ext().storage.local.remove(["connection", "baskets", "lastBasketId"]);
}

/** The server the extension last connected to (kept after disconnecting, to connect there again). */
export async function getServer(): Promise<string | null> {
  const { server } = await ext().storage.local.get("server");
  return typeof server === "string" ? server : null;
}

export async function setServer(origin: string): Promise<void> {
  await ext().storage.local.set({ server: origin });
}

export async function getBaskets(): Promise<BasketRef[]> {
  const { baskets } = await ext().storage.local.get("baskets");
  return Array.isArray(baskets) ? (baskets as BasketRef[]) : [];
}

export async function setBaskets(list: { id: string; name: string }[]): Promise<void> {
  const next = list.map((b) => ({ id: b.id, name: b.name }));
  // Only write when something changed: the context menu is rebuilt on every change.
  if (JSON.stringify(next) !== JSON.stringify(await getBaskets())) await ext().storage.local.set({ baskets: next });
}

export async function getLastBasket(): Promise<string | null> {
  const { lastBasketId } = await ext().storage.local.get("lastBasketId");
  return typeof lastBasketId === "string" ? lastBasketId : null;
}

export async function setLastBasket(id: string): Promise<void> {
  await ext().storage.local.set({ lastBasketId: id });
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await ext().storage.local.get("settings");
  return { ...DEFAULTS, ...(settings && typeof settings === "object" ? settings as Partial<Settings> : {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await ext().storage.local.set({ settings: next });
  return next;
}
