import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemPage } from "@purss/domain";
import { get } from "../api/client.ts";
import { keys } from "../api/queries.ts";
import { useDisplayMode } from "../lib/display.ts";
import { onItemsChanged } from "../offline/signals.ts";
import { platform } from "../platform/index.ts";
import { usePlayer } from "../player/PlayerProvider.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { buildWidgetSnapshot, sameWidget, WIDGET_TO_READ_QUERY } from "./widget.ts";
import type { WidgetSnapshot } from "./widget.ts";

/** How often the widget's To read list is read again while the app is open, besides changes to items. */
const EVERY_MS = 15 * 60_000;

/**
 * Renders nothing. In the apps (plan/38): keeps the home-screen widget's snapshot in step with the To
 * read list, the player and the look. Its taps are opened by OpenLinks.
 */
export function DeviceRunner() {
  const widget = platform.widget;
  const qc = useQueryClient();
  const { snap } = usePlayer();
  const ws = useWorkspace();
  const eink = useDisplayMode() === "eink";
  const toRead = useQuery({
    queryKey: [...keys.items, "widget-toread"],
    queryFn: () => get<ItemPage>("/api/items", WIDGET_TO_READ_QUERY),
    enabled: !!widget,
    refetchInterval: EVERY_MS,
  });
  const last = useRef<WidgetSnapshot | null>(null);
  // The stored snapshot is read first: it keeps the last played episode across starts of the app.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!widget) return;
    let live = true;
    void widget.current().then((s) => { if (live) { last.current = s; setReady(true); } });
    return () => { live = false; };
  }, [widget]);

  useEffect(() => {
    if (!widget) return;
    return onItemsChanged(() => { void qc.invalidateQueries({ queryKey: [...keys.items, "widget-toread"] }); });
  }, [widget, qc]);

  const now = snap.now && snap.now.kind === "audio"
    ? { itemId: snap.now.itemId, title: snap.now.title, sourceTitle: snap.now.sourceTitle, playing: snap.state.playing, position: snap.state.position, duration: snap.state.duration }
    : null;
  useEffect(() => {
    if (!widget || !ready) return;
    const previous = last.current;
    const next = buildWidgetSnapshot({
      theme: ws.prefs.theme, eink,
      toRead: toRead.data ? { items: toRead.data.items, total: toRead.data.total } : null,
      now, previous, at: Date.now(),
    });
    if (sameWidget(previous, next)) { last.current = previous; return; }
    last.current = next;
    widget.update(next);
  // `now` is rebuilt every render; its fields are what matter.
  }, [widget, ready, ws.prefs.theme, eink, toRead.data, now?.itemId, now?.title, now?.sourceTitle, now?.playing, now && (now.playing ? Math.floor(now.position / 60) : Math.floor(now.position)), now?.duration]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
