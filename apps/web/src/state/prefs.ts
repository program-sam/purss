import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Bootstrap, Preferences } from "@purss/domain";
import { messageOf, patch } from "../api/client.ts";
import { keys } from "../api/queries.ts";
import { useToasts } from "./toasts.tsx";
import { writeVisualHint } from "./ui-store.ts";
import { useDisplayMode } from "../lib/display.ts";

/** The page background in each theme (packages/ui tokens), for the browser's title bar. Keep in step with index.html and the manifest. */
const THEME_COLOR = { light: "#fcfcfd", dark: "#181c21", eink: "#ffffff" };

export type PreferencePatch = Partial<Omit<Preferences, "notifications">> & { notifications?: Preferences["notifications"] };

/** Save preferences on the account. The screen updates immediately and snaps back with a message if the save fails. */
export function useSavePreferences() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  return useCallback(async (change: PreferencePatch) => {
    const before = qc.getQueryData<Bootstrap>(keys.bootstrap);
    if (before) qc.setQueryData<Bootstrap>(keys.bootstrap, { ...before, preferences: { ...before.preferences, ...change } });
    try {
      const saved = await patch<Preferences>("/api/preferences", change);
      // Take the server's answer only for what was changed here, so a second change made while this one was in flight keeps showing.
      qc.setQueryData<Bootstrap>(keys.bootstrap, (cur) => {
        if (!cur) return cur;
        const merged: Record<string, unknown> = { ...cur.preferences };
        for (const k of Object.keys(change)) merged[k] = (saved as Record<string, unknown>)[k];
        return { ...cur, preferences: merged as Preferences };
      });
    } catch (err) {
      if (before) qc.setQueryData<Bootstrap>(keys.bootstrap, (cur) => (cur ? { ...cur, preferences: before.preferences } : cur));
      toast(messageOf(err), { tone: "error" });
    }
  }, [qc, toast]);
}

/** Reflect theme, skin, density and the fresh/count switches on the document. An e-ink display is always light. */
export function useApplyAppearance(prefs: Preferences): void {
  const eink = useDisplayMode() === "eink";
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = !eink && (prefs.theme === "dark" || (prefs.theme === "system" && mq.matches));
      root.dataset.theme = dark ? "dark" : "light";
      // The browser's or the installed app's title bar follows the chosen theme, not just the device's.
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = eink ? THEME_COLOR.eink : dark ? THEME_COLOR.dark : THEME_COLOR.light;
    };
    apply();
    root.dataset.skin = prefs.skin;
    root.dataset.density = prefs.density;
    root.dataset.fresh = prefs.freshMarkers ? "on" : "off";
    root.dataset.counts = prefs.showCounts ? "on" : "off";
    writeVisualHint({ theme: prefs.theme, skin: prefs.skin, density: prefs.density });
    if (prefs.theme !== "system" || eink) return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [prefs.theme, prefs.skin, prefs.density, prefs.freshMarkers, prefs.showCounts, eink]);
}
