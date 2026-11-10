import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ItemDetail, PlaybackPosition } from "@purss/domain";
import { api } from "../api/client.ts";
import { useSession } from "../api/hooks.ts";
import { keys } from "../api/queries.ts";
import { lateStore, worthRetrying } from "../lib/late-writes.ts";
import { onResume } from "../offline/status.ts";
import type { PlayerBackend } from "./backend.ts";
import { platform } from "../platform/index.ts";
import { bindMediaSession } from "./media-session.ts";
import type { MediaSessionLike } from "./media-session.ts";
import { Player } from "./player.ts";
import type { PendingPosition, PlayerSnapshot } from "./player.ts";

const RATE_KEY = "purss-player-rate";

const Ctx = createContext<Player | null>(null);

/**
 * One player for the signed-in PURSS, kept above the pages so playback carries on while you
 * move around. `backend` defaults to the platform's (the browser's media element on the web, the
 * native player in the apps).
 */
export function PlayerProvider({ children, backend }: { children: ReactNode; backend?: PlayerBackend }) {
  const qc = useQueryClient();
  const player = useMemo(() => new Player({
    backend: backend ?? platform.createPlayerBackend(),
    savePosition: async (itemId, positionSeconds, durationSeconds, { keepalive, recordedAt }) => {
      const saved = await api<PlaybackPosition>(`/api/items/${encodeURIComponent(itemId)}/playback`, { method: "PUT", body: { positionSeconds, durationSeconds, ...(recordedAt ? { recordedAt } : {}) }, keepalive });
      // Keep an open item's "Resume at" in step without refetching it. The answer is the server's newest position.
      qc.setQueryData<ItemDetail>(keys.item(itemId), (old) => (old ? { ...old, playback: saved } : old));
    },
    worthRetrying,
    ...(platform.downloads ? { deviceCopy: platform.downloads.playable.bind(platform.downloads) } : {}),
    rateStore: {
      get: () => { try { const v = Number(localStorage.getItem(RATE_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } },
      set: (rate) => { try { localStorage.setItem(RATE_KEY, String(rate)); } catch { /* private mode */ } },
    },
  }), [backend, qc]);

  // Positions played without a connection are kept on this device for the signed-in account and sent when
  // the connection is back: at start, when it returns, when the app is shown again, and every ten seconds
  // while any wait (the "online" event can come before the network works).
  const session = useSession();
  const accountId = session.data?.state === "signed_in" ? session.data.account?.id ?? null : null;
  useEffect(() => {
    if (!accountId) return;
    player.setPendingStore(lateStore<PendingPosition>("playback", accountId));
    const send = () => void player.sendPending();
    const stop = onResume(send);
    const timer = setInterval(() => { if (player.hasPending() && navigator.onLine !== false) send(); }, 10_000);
    return () => { stop(); clearInterval(timer); player.setPendingStore(null); };
  }, [player, accountId]);

  useEffect(() => {
    const session = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: MediaSessionLike }).mediaSession : undefined;
    const Metadata = (globalThis as { MediaMetadata?: new (init: { title: string; artist: string }) => unknown }).MediaMetadata;
    const unbind = session && Metadata ? bindMediaSession(player, session, Metadata) : () => {};
    // Leaving or hiding the page keeps the position, even if the request has to outlive the page.
    const away = () => void player.flush({ keepalive: true });
    const hidden = () => { if (document.visibilityState === "hidden") away(); };
    window.addEventListener("pagehide", away);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      unbind();
      window.removeEventListener("pagehide", away);
      document.removeEventListener("visibilitychange", hidden);
      void player.close();
    };
  }, [player]);

  return <Ctx.Provider value={player}>{children}</Ctx.Provider>;
}

export function usePlayer(): { player: Player; snap: PlayerSnapshot } {
  const player = useContext(Ctx);
  if (!player) throw new Error("PlayerProvider is missing");
  const snap = useSyncExternalStore(player.subscribe, player.getSnapshot);
  return { player, snap };
}
