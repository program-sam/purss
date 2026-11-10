import { ext } from "./browser.ts";
import type { Readable } from "./capture.ts";
import type { PageInfo } from "./page-info.ts";

/*
 * Reading the open page. The popup may do this because opening it grants access to that one tab
 * (activeTab); the extension has no standing access to any site. Each script defines one function in
 * the extension's isolated world, which is then called; nothing of the page's own scripts is involved.
 */
async function callInTab(tabId: number, file: string, name: string): Promise<unknown> {
  const api = ext();
  await api.scripting.executeScript({ target: { tabId }, files: [file] });
  const [r] = await api.scripting.executeScript({ target: { tabId }, func: (fn: string) => (globalThis as unknown as Record<string, () => unknown>)[fn]!(), args: [name] });
  return r?.result;
}

/** The feeds or channel the page advertises; null when the page can't be read (a browser or store page). */
export async function pageInfoOf(tabId: number): Promise<PageInfo | null> {
  try {
    return (await callInTab(tabId, "content/page-info.js", "__purssPageInfo")) as PageInfo;
  } catch {
    return null;
  }
}

/** The readable part of the page as it is shown now. */
export async function readableIn(tabId: number): Promise<Readable> {
  try {
    return ((await callInTab(tabId, "content/capture.js", "__purssReadable")) as Readable | undefined) ?? { ok: false, reason: "empty" };
  } catch {
    return { ok: false, reason: "empty" };
  }
}
