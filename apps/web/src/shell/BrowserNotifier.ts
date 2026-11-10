import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { notificationsQuery } from "../api/queries.ts";
import { platform } from "../platform/index.ts";
import { inQuietHours } from "@purss/domain";
import { useNav } from "../nav.ts";
import { useWorkspace } from "../state/workspace.tsx";

/**
 * Shows operating-system notifications for new arrivals while the page is open, when the person
 * chose "Browser alerts" and the browser has granted permission (in the desktop app: its own system
 * notifications, also while its window is closed, plan/42). Quiet hours hold alerts back (they
 * still appear in the bell); titles come from the server, which leaves item titles out unless
 * previews are on. Permission is never requested here.
 */
export function useBrowserNotifications(): () => void {
  const qc = useQueryClient();
  const ws = useWorkspace();
  const nav = useNav();
  const started = useRef(Date.now());
  const shown = useRef(new Set<string>());
  const latest = useRef({ ws, nav });
  latest.current = { ws, nav };

  return useCallback(() => {
    const { ws: w, nav: n } = latest.current;
    const prefs = w.prefs.notifications;
    if (prefs.mode !== "browser" || platform.notifier.permission() !== "granted") return;
    void qc.fetchQuery({ ...notificationsQuery, staleTime: 0 }).then((list) => {
      for (const note of [...list].reverse()) {
        if (note.read || shown.current.has(note.id) || Date.parse(note.createdAt) < started.current - 1000) continue;
        shown.current.add(note.id);
        if (inQuietHours(new Date(), prefs.quietStart, prefs.quietEnd, w.prefs.timezone)) continue;
        platform.notifier.show({ tag: note.id, title: note.title, body: prefs.previews ? note.body ?? undefined : undefined }, () => {
          if (note.sourceId && w.sourceById.has(note.sourceId)) n.go({ t: "s", id: note.sourceId }, note.itemId ? { item: note.itemId } : undefined);
        });
      }
    }, () => undefined);
  }, [qc]);
}
