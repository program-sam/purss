/*
 * The WebExtension APIs the extension uses, typed by hand. Firefox and Safari provide `browser` with
 * promises; Chrome and Edge provide `chrome`, whose Manifest V3 methods return promises too. Optional
 * members are missing in some browsers (Safari has no `identity`; iOS has no context menus; `tabs`
 * events need the optional "tabs" permission to carry addresses).
 */

export type Tab = { id?: number; url?: string; title?: string; incognito: boolean; windowId?: number };
type Listener<A extends unknown[]> = { addListener(fn: (...args: A) => void): void };
export type MenuClick = { menuItemId: string | number; pageUrl?: string; linkUrl?: string; linkText?: string };
export type MenuItem = { id: string; title: string; contexts: string[]; parentId?: string; enabled?: boolean };
export type StorageChange = { oldValue?: unknown; newValue?: unknown };

export type Browser = {
  runtime: {
    id: string;
    getURL(path: string): string;
    openOptionsPage(): Promise<void>;
    onInstalled: Listener<[]>;
    onStartup: Listener<[]>;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: Listener<[unknown]>;
  };
  storage: {
    local: { get(keys: string | string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string | string[]): Promise<void> };
    onChanged: Listener<[Record<string, StorageChange>, string]>;
  };
  tabs: {
    query(q: { active: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    get(id: number): Promise<Tab>;
    create(p: { url: string; active?: boolean }): Promise<Tab>;
    update(p: { url: string }): Promise<Tab>;
    onUpdated: Listener<[number, { status?: string; url?: string }, Tab]>;
    onActivated: Listener<[{ tabId: number }]>;
  };
  scripting: {
    executeScript<A extends unknown[]>(p: { target: { tabId: number }; files?: string[]; func?: (...args: A) => unknown; args?: A }): Promise<{ result?: unknown }[]>;
  };
  action: {
    setBadgeText(p: { tabId?: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(p: { color: string }): Promise<void>;
    setTitle(p: { tabId?: number; title: string }): Promise<void>;
  };
  permissions: {
    contains(p: { permissions: string[] }): Promise<boolean>;
    request(p: { permissions: string[] }): Promise<boolean>;
    remove(p: { permissions: string[] }): Promise<boolean>;
  };
  identity?: {
    getRedirectURL(path?: string): string;
    launchWebAuthFlow(p: { url: string; interactive: boolean }): Promise<string | undefined>;
  };
  contextMenus?: {
    create(item: MenuItem): unknown;
    removeAll(): Promise<void>;
    onClicked: Listener<[MenuClick, Tab | undefined]>;
  };
  omnibox?: {
    setDefaultSuggestion(s: { description: string }): void;
    onInputEntered: Listener<[string, string]>;
  };
};

const g = globalThis as unknown as { browser?: Browser; chrome?: Browser };

/** The browser's extension API: `browser` where it exists (Firefox, Safari), else `chrome`. */
export function ext(): Browser {
  const api = g.browser ?? g.chrome;
  if (!api?.runtime?.id) throw new Error("Not running as a browser extension.");
  return api;
}
