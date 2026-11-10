import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Avatar, Icon, IconButton } from "@purss/ui";
import { nameFace } from "../components/item-bits.tsx";
import { useNav } from "../nav.ts";
import { usePopups } from "../state/popups.tsx";
import { RATES, SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS, SLEEP_MINUTES, clock, rateLabel, seekKeyStep, sleepMinutesLeft, sourceLabel } from "./logic.ts";
import { usePlayer } from "./PlayerProvider.tsx";
import { hasKeyboard } from "../lib/returning.ts";

/** Move focus to the player's Play/Pause button (the shortcut and the skip link). */
export function focusPlayer(): boolean {
  const b = document.querySelector<HTMLElement>(".player .player-main");
  b?.focus();
  return !!b;
}

/**
 * The position slider. While it is being moved it shows where it was moved to, not the position the player last
 * reported: that is still the old one for a moment, and a slider that snaps back undoes the seek it has just made.
 */
function Seek({ position, duration, max, onSeek }: { position: number; duration: number | null; max: number; onSeek: (seconds: number) => void }) {
  const [moved, setMoved] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = Math.min(moved ?? position, max);
  const moveTo = (seconds: number) => {
    const to = Math.max(0, Math.min(seconds, max));
    setMoved(to);
    onSeek(to);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoved(null), 600);
  };
  const pct = max > 0 ? (shown / max) * 100 : 0;
  return (
    <div className="player-seek">
      <span className="player-time" aria-hidden="true">{clock(shown)}</span>
      <input type="range" min={0} max={max} step={1} value={shown} aria-label="Position" aria-valuetext={`${clock(shown)} of ${clock(duration)}`}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        onChange={(e) => moveTo(Number(e.target.value))}
        onKeyDown={(e) => {
          const step = seekKeyStep(e.key);
          if (step) { e.preventDefault(); moveTo(shown + step); }
        }} />
      {/* Time left, as podcast players show it; the slider itself reads out where it is of how long. */}
      <span className="player-time" aria-hidden="true">{duration !== null ? `−${clock(Math.max(0, duration - shown))}` : clock(null)}</span>
    </div>
  );
}

const MINI_KEY = "purss-player-mini";

/** What the sleep timer shows: its time left, kept current while nothing else changes (paused). */
function useSleepLeft(sleepAt: number | null): number | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (sleepAt === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [sleepAt]);
  return sleepAt === null ? null : sleepMinutesLeft(sleepAt - Date.now());
}

/**
 * The mini-player: stays at the bottom while you move around PURSS. It tells the layout its
 * height (--player-h on the app), and the layout ends above it (extra.css), so it never covers anything.
 */
export function PlayerBar() {
  const { player, snap } = usePlayer();
  const nav = useNav();
  const popups = usePopups();
  const videoBox = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const [showVideo, setShowVideo] = useState(true);
  // Smaller or full size is a choice for this device, kept across visits.
  const [mini, setMini] = useState(() => { try { return localStorage.getItem(MINI_KEY) === "1"; } catch { return false; } });
  const toggleMini = () => setMini((m) => {
    try { localStorage.setItem(MINI_KEY, m ? "0" : "1"); } catch { /* private mode */ }
    return !m;
  });
  const now = snap.now;
  // Closing the player gives focus back to what had it when the player opened (the Listen or Play button).
  const opener = useRef<HTMLElement | null>(null);
  const open = !!now;
  useEffect(() => {
    if (!open) return;
    const a = document.activeElement as HTMLElement | null;
    opener.current = a && a !== document.body && !a.closest(".player") ? a : null;
  }, [open]);
  const closePlayer = () => {
    void player.close();
    const back = opener.current?.isConnected ? opener.current : document.getElementById("main");
    back?.focus({ preventScroll: true });
  };
  const isVideo = now?.kind === "video" && player.backend.supportsVideo;

  // The backend owns the element that draws video; place it here while a video plays.
  useEffect(() => {
    const box = videoBox.current;
    const view = player.backend.view();
    if (!box || !view || !isVideo || !showVideo || mini) return;
    box.appendChild(view);
    return () => { if (view.parentElement === box) box.removeChild(view); };
  }, [player, isVideo, showVideo, mini, now?.itemId]);

  const shown = !!now;
  useEffect(() => {
    const el = bar.current;
    const app = el?.parentElement;
    if (!el || !app) return;
    const measure = () => app.style.setProperty("--player-h", `${el.offsetHeight}px`);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => { watch.disconnect(); app.style.removeProperty("--player-h"); };
  }, [shown]);

  // An always-present status line says when the player opens and what to do next; nothing is read while it stays closed.
  const status = <div className="sr" role="status">{now ? `Player opened: ${now.title}.${hasKeyboard((q) => window.matchMedia(q).matches) ? " Press P to go to its controls." : ""}` : ""}</div>;
  const sleep = useSleepLeft(snap.sleepAt);
  if (!now) return status;
  const { position, duration, playing, buffering } = snap.state;
  const max = duration ?? Math.max(position, 1);
  const face = nameFace(now.sourceTitle);
  const art = now.imageUrl && /^https:\/\//.test(now.imageUrl) ? now.imageUrl : null;
  return (
    <>
    {status}
    <section className="player" id="player" aria-label="Player" ref={bar} data-mini={mini ? "" : undefined}>
      {isVideo && showVideo && !mini ? <div className="player-screen" ref={videoBox} /> : null}
      <div className="player-body">
        <button type="button" className="player-title" onClick={() => nav.openItem(now.itemId)} title="Open this item">
          <Avatar hue={face.hue} initials={face.initials} src={art} size={44} />
          <span className="player-meta">
            <b>{now.title}</b>
            <span><bdi>{now.sourceTitle}</bdi> · {sourceLabel(now.from)}</span>
          </span>
        </button>
        <div className="player-controls">
          <IconButton label={`Back ${SKIP_BACK_SECONDS} seconds`} className="player-skip" onClick={() => player.back()}>
            <Icon name="skipback" /><span aria-hidden="true">{SKIP_BACK_SECONDS}</span>
          </IconButton>
          <IconButton label={playing ? "Pause" : "Play"} className="player-main" data-busy={buffering && !snap.error ? "" : undefined} onClick={() => player.toggle()}>
            <Icon name={playing ? "pause" : "play"} />
          </IconButton>
          <IconButton label={`Forward ${SKIP_FORWARD_SECONDS} seconds`} className="player-skip" onClick={() => player.forward()}>
            <Icon name="skipfwd" /><span aria-hidden="true">{SKIP_FORWARD_SECONDS}</span>
          </IconButton>
        </div>
        <Seek position={position} duration={duration} max={max} onSeek={(s) => player.seek(s)} />
        <div className="player-tools">
          <button type="button" className="player-pill player-rate" aria-haspopup="menu" aria-label={`Speed ${rateLabel(snap.rate)}`}
            onClick={(e) => popups.menu(e.currentTarget, RATES.map((r) => ({ type: "radio" as const, label: rateLabel(r), on: snap.rate === r, onSelect: () => player.setRate(r) })), "Playback speed")}>
            {rateLabel(snap.rate)}
          </button>
          <button type="button" className="player-pill player-sleep" data-on={sleep ? "" : undefined} aria-haspopup="menu"
            aria-label={sleep ? `Sleep timer: pauses in ${sleep} min` : "Sleep timer"} title="Sleep timer"
            onClick={(e) => popups.menu(e.currentTarget, [
              { type: "radio" as const, label: "Off", on: snap.sleepAt === null, onSelect: () => player.setSleepTimer(null) },
              ...SLEEP_MINUTES.map((m) => ({ type: "radio" as const, label: `In ${m} minutes`, on: false, onSelect: () => player.setSleepTimer(m) })),
            ], "Pause playback")}>
            <Icon name="moon" size="sm" />{sleep ? <span aria-hidden="true">{sleep}<span className="player-unit"> min</span></span> : null}
          </button>
          <div className="player-end">
            <IconButton label={mini ? "Show the full player" : "Make the player smaller"} aria-expanded={!mini} className="player-size" onClick={toggleMini}>
              <Icon name="chev" />
            </IconButton>
            {now.kind === "video" && player.backend.supportsVideo && !mini ? (
              <IconButton label={showVideo ? "Hide the video" : "Show the video"} onClick={() => setShowVideo((v) => !v)}><Icon name={showVideo ? "fold" : "unfold"} /></IconButton>
            ) : null}
            <IconButton label="Close the player" onClick={closePlayer}><Icon name="x" /></IconButton>
          </div>
        </div>
      </div>
      {mini ? <div className="player-progress" aria-hidden="true"><i style={{ width: `${Math.min(100, (position / max) * 100)}%` }} /></div> : null}
      <span className="sr" role="status">{buffering && !snap.error ? "Loading…" : ""}</span>
      {snap.error ? <p className="player-note" role="alert"><Icon name="alert" size="sm" />{snap.error}</p> : null}
    </section>
    </>
  );
}
