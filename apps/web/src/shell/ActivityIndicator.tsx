import { useQuery } from "@tanstack/react-query";
import type { ActivityDTO, ActivitySource } from "@purss/domain";
import { Icon } from "@purss/ui";
import { activityQuery } from "../api/home-queries.ts";
import { RetrySource } from "../components/RetrySource.tsx";
import { formatCount, timeAgo } from "../lib/format.ts";
import { activityLine, nextCheckLine } from "../lib/returning.ts";
import { useNow } from "../lib/use-now.ts";
import { useNav } from "../nav.ts";
import { usePopups } from "../state/popups.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import "../pages/home.css";

function SourceLine({ s, now, tz, onOpen }: { s: ActivitySource; now: number; tz: string; onOpen: (id: string) => void }) {
  const bad = s.health === "error" || s.health === "reconnect" || s.health === "login";
  const when = s.lastCheckedAt ? `checked ${timeAgo(s.lastCheckedAt, now, tz)}` : "";
  return (
    <li className={bad ? "bad" : undefined}>
      <button type="button" className="nm link" dir="auto" onClick={() => onOpen(s.id)}>{s.title}</button>
      <RetrySource id={s.id} title={s.title} health={s.health} />
      <span className="when">{[s.arrived ? `${s.arrived} new today` : "", when].filter(Boolean).join(" · ") || "—"}</span>
      {s.note ? <span className="note">{s.note}</span> : null}
    </li>
  );
}

/** Everything the engine has been doing for this PURSS, from the server's own account of it. */
export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const nav = useNav();
  const q = useQuery(activityQuery);
  const now = useNow(30_000);
  const tz = ws.prefs.timezone;
  const a: ActivityDTO | undefined = q.data;
  if (!a) return <div className="act-pop"><p className="fine">{q.isError ? "Couldn't load activity." : "Loading…"}</p></div>;
  const line = activityLine(a, { now, timeZone: tz });
  const next = nextCheckLine(a, now, tz);
  const open = (id: string) => { onClose(); nav.go({ t: "s", id }); };
  const worst = [...a.sources].sort((x, y) => Number(!!y.note) - Number(!!x.note) || x.title.localeCompare(y.title));
  return (
    <div className="act-pop">
      <h3>Background activity</h3>
      <p role="status">{line.text}{next && !line.busy ? <><br /><span className="fine">{next}. New items arrive in batches after each check.</span></> : null}</p>
      {a.problem ? <p className="state note"><Icon name="info" /><span>{a.problem}</span></p> : null}
      {a.events.length ? (
        <>
          <h3>Recently</h3>
          <ul className="act-ev">{a.events.slice(0, 8).map((e, i) => <li key={`${e.at}${i}`}><span>{e.text}</span><span className="when">{timeAgo(e.at, now, tz)}</span></li>)}</ul>
        </>
      ) : null}
      {worst.length ? (
        <>
          <h3>Your sources · {formatCount(worst.length)}</h3>
          <ul className="act-list">{worst.map((s) => <SourceLine key={s.id} s={s} now={now} tz={tz} onOpen={open} />)}</ul>
        </>
      ) : null}
    </div>
  );
}

/** The sidebar foot's one calm line about the engine; pressing it opens the list behind it. */
export function ActivityIndicator({ rail = false }: { rail?: boolean }) {
  const ws = useWorkspace();
  const popups = usePopups();
  const q = useQuery(activityQuery);
  const now = useNow(30_000);
  if (!ws.data.sources.length) return null;
  const line = q.data ? activityLine(q.data, { now, timeZone: ws.prefs.timezone }) : null;
  const text = line?.text ?? "Checking…";
  const open = (anchor: HTMLElement) => popups.panel(anchor, "Background activity", (close) => <ActivityPanel onClose={() => close()} />, { up: true, className: "act-popup" });
  if (rail) {
    return (
      <button type="button" className="rbtn act-rail" data-tip={text} aria-haspopup="dialog" aria-label={`Background activity: ${text}`} onClick={(e) => open(e.currentTarget)}>
        {line?.busy ? <span className="spin" aria-hidden="true" /> : <Icon name={line?.problem ? "alert" : "clock"} />}
      </button>
    );
  }
  return (
    <button type="button" className={`act${line?.problem ? " problem" : ""}`} aria-haspopup="dialog" aria-label={`Background activity: ${text}. Show details`} onClick={(e) => open(e.currentTarget)}>
      {line?.busy ? <span className="spin" aria-hidden="true" /> : <Icon name={line?.problem ? "alert" : "clock"} size="sm" />}
      <span className="t" role="status">{text}</span>
    </button>
  );
}
