import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../api/queries.ts";
import { useDisplayMode } from "../lib/display.ts";
import { onItemsChanged, onReadingChanged } from "../offline/signals.ts";
import { platform } from "../platform/index.ts";
import { usePlayer } from "../player/PlayerProvider.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { buildWidgetSnapshot, sameWidget } from "./widget.ts";
import type { WidgetSnapshot } from "./widget.ts";

/** Changes to items come in bursts (a bulk action, a sync): the panels' lists are asked for once they settle. */
const SETTLE_MS = 2_000;

/**
 * Renders nothing. In the apps (plan/38): keeps the home-screen panels' look and episode in step with the app
 * and the player, and asks the native side to fetch their lists again when the app starts and whenever the app's
 * item lists go stale (the person's own changes and the server's alike). Their taps are opened by OpenLinks.
 */
export function DeviceRunner() {
  const widget = platform.widget;
  const qc = useQueryClient();
  const { snap } = usePlayer();
  const ws = useWorkspace();
  const eink = useDisplayMode() === "eink";
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
    widget.refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => { clearTimeout(timer); timer = setTimeout(() => widget.refresh(), SETTLE_MS); };
    // The server's changes and the person's own, once PURSS took them; and anything else that marks the item lists stale
    // (state/actions.ts). The cache tells only of lists that weren't stale already, so it can't be the only signal.
    const stops = [
      onItemsChanged(ask),
      onReadingChanged(ask),
      qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.action.type === "invalidate" && e.query.queryKey[0] === keys.items[0]) ask();
      }),
    ];
    return () => { clearTimeout(timer); stops.forEach((stop) => stop()); };
  }, [widget, qc]);

  const now = snap.now && snap.now.kind === "audio"
    ? { itemId: snap.now.itemId, title: snap.now.title, sourceTitle: snap.now.sourceTitle, playing: snap.state.playing, position: snap.state.position, duration: snap.state.duration }
    : null;
  useEffect(() => {
    if (!widget || !ready) return;
    const previous = last.current;
    const next = buildWidgetSnapshot({
      theme: ws.prefs.theme, eink,
      now, previous, at: Date.now(),
    });
    if (sameWidget(previous, next)) { last.current = previous; return; }
    last.current = next;
    widget.update(next);
  // `now` is rebuilt every render; its fields are what matter.
  }, [widget, ready, ws.prefs.theme, eink, now?.itemId, now?.title, now?.sourceTitle, now?.playing, now && (now.playing ? Math.floor(now.position / 60) : Math.floor(now.position)), now?.duration]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
