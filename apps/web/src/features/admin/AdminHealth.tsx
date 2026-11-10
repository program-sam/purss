import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AdminBridgeHealth, AdminHealth, DiscoveryMissDTO } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import type { IconName } from "@purss/ui";
import { dateTime, formatCount, plural, timeAgo } from "../../lib/format.ts";
import { platform } from "../../platform/index.ts";
import { adminHealthQuery } from "../shared/api.ts";
import { Facts, Loading, LoadFailed } from "../shared/bits.tsx";
import { bridgeFailureText, bytesOrUnknown, durationLabel, engineLabel, missLabel } from "./admin-model.ts";

function Area({ title, state, children }: { title: string; state?: { ok: boolean; text: string }; children: ReactNode }) {
  const icon: IconName = state ? (state.ok ? "check" : "alert") : "info";
  return (
    <section className="fx-area" aria-label={title}>
      <header><h3>{title}</h3>{state ? <span className={`fx-state ${state.ok ? "ok" : "bad"}`}><Icon name={icon} size="sm" />{state.text}</span> : null}</header>
      {children}
    </section>
  );
}

/** A time as "3 days ago", with the exact time on hover. */
function When({ iso }: { iso: string }) {
  return <time dateTime={iso} title={dateTime(iso)}>{timeAgo(iso) || "just now"}</time>;
}

function BridgedSources({ bridge }: { bridge: AdminBridgeHealth | null }) {
  if (!bridge) {
    return <Area title="Bridged sources"><p className="fine">This server doesn't run the bridge for pages that publish no feed.</p></Area>;
  }
  if (bridge.status !== "ok") {
    return (
      <Area title="Bridged sources" state={{ ok: false, text: "Not answering" }}>
        <p className="fine">The bridge's log couldn't be read just now. It comes from the egress service.</p>
      </Area>
    );
  }
  const failing = bridge.failing;
  return (
    <Area title="Bridged sources" state={{ ok: failing.length === 0, text: failing.length ? `${plural(failing.length, "source is", "sources are")} failing` : "None failing" }}>
      <p className="fine">The last {bridge.days} days. Attempts are requests to the service. Answers from cache repeat an earlier answer without asking it again. An empty feed counts as a success.</p>
      <div className="fx-scroll">
        <table className="fx-tbl" aria-label={`Bridged services over the last ${bridge.days} days`}>
          <thead>
            <tr><th scope="col">Service</th><th scope="col" className="num">Success</th><th scope="col" className="num">Attempts</th><th scope="col" className="num">OK</th><th scope="col" className="num">Empty</th><th scope="col" className="num">Failed</th><th scope="col" className="num">From cache</th></tr>
          </thead>
          <tbody>
            {bridge.services.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                <td className="num">{s.successPercent === null ? "No attempts" : `${s.successPercent}%`}</td>
                <td className="num">{formatCount(s.attempts)}</td>
                <td className="num">{formatCount(s.ok)}</td>
                <td className="num">{formatCount(s.empty)}</td>
                <td className="num">{formatCount(s.failed)}</td>
                <td className="num">{formatCount(s.cachedAnswers)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Failing now</h4>
      {failing.length ? (
        <div className="fx-scroll">
          <table className="fx-tbl" aria-label="Bridged sources that are failing">
            <thead>
              <tr><th scope="col">Service</th><th scope="col">Source</th><th scope="col">What failed</th><th scope="col">Failing since</th><th scope="col">Last worked</th></tr>
            </thead>
            <tbody>
              {failing.map((f) => (
                <tr key={`${f.service}/${f.key}`}>
                  <th scope="row">{f.serviceName}</th>
                  <td>{f.pageUrl
                    ? <a className="link" href={f.pageUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); platform.openExternal(f.pageUrl!); }}>{f.key}</a>
                    : f.key}</td>
                  <td className="wrap">{bridgeFailureText(f.outcome)}</td>
                  <td><When iso={f.failingSince} />{f.attempts ? ` · ${plural(f.attempts, "try", "tries")}` : ""}</td>
                  <td>{f.lastOkAt ? <When iso={f.lastOkAt} /> : "Not in the last 30 days"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="fine">No bridged source is failing right now.</p>}
    </Area>
  );
}

function SitesNotFollowed({ misses }: { misses: DiscoveryMissDTO[] }) {
  return (
    <Area title="Sites people couldn't follow">
      <p className="fine">The last 30 days, most often first. Only the site is counted, never the full address or who tried.</p>
      {misses.length ? (
        <div className="fx-scroll">
          <table className="fx-tbl" aria-label="Sites people couldn't follow">
            <thead>
              <tr><th scope="col">Site</th><th scope="col">Why</th><th scope="col" className="num">Times</th></tr>
            </thead>
            <tbody>
              {misses.map((m) => (
                <tr key={`${m.site}/${m.reason}`}>
                  <th scope="row">{m.site}</th>
                  <td>{missLabel(m.reason)}</td>
                  <td className="num">{formatCount(m.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="fine">Nothing to show for the last 30 days.</p>}
    </Area>
  );
}

function Body({ h }: { h: AdminHealth }) {
  const engineOk = h.engine.status === "ok";
  const egress = h.egress.status === "ok";
  return (
    <div className="fx-grid">
      <Area title="Collection engine" state={{ ok: engineOk, text: engineLabel(h.engine.status) }}>
        <Facts items={[
          { label: "Last successful sync", value: h.engine.lastSyncAt ? timeAgo(h.engine.lastSyncAt) : "Unknown" },
          { label: "Behind by", value: durationLabel(h.engine.lagSeconds) },
          { label: "Engine version", value: h.engine.version ?? "Not reported" },
        ]} />
        {h.engine.message ? <p className="fine">{h.engine.message}</p> : null}
      </Area>
      <Area title="Background jobs" state={{ ok: h.jobs.failed === 0, text: h.jobs.failed ? `${plural(h.jobs.failed, "failed")}` : "No failures" }}>
        <Facts items={[
          { label: "Waiting", value: h.jobs.queued },
          { label: "Running", value: h.jobs.leased },
          { label: "Failed", value: h.jobs.failed },
          { label: "Oldest waiting", value: h.jobs.oldestQueuedSeconds === null ? "None waiting" : durationLabel(h.jobs.oldestQueuedSeconds) },
        ]} />
      </Area>
      <Area title="Disk" state={{ ok: !h.disk.growthPaused, text: h.disk.growthPaused ? "Growth paused" : "Enough room" }}>
        <Facts items={[
          { label: "Free", value: bytesOrUnknown(h.disk.freeBytes) },
          { label: "Total", value: bytesOrUnknown(h.disk.totalBytes) },
          { label: "Safety reserve", value: bytesOrUnknown(h.disk.reserveBytes) },
        ]} />
        {h.disk.freeBytes === null ? <p className="fine">Free space couldn't be measured, so it shows as unknown.</p> : null}
      </Area>
      <Area title="Database">
        <Facts items={[
          { label: "Database file", value: bytesOrUnknown(h.database.bytes) },
          { label: "Write-ahead log", value: bytesOrUnknown(h.database.walBytes) },
        ]} />
      </Area>
      <Area title="Followed sources" state={{ ok: h.sources.failing === 0, text: h.sources.failing ? `${plural(h.sources.failing, "needs", "need")} attention` : "All collecting" }}>
        <Facts items={[
          { label: "Followed", value: h.sources.total },
          { label: "Failing or needing a login", value: h.sources.failing },
          { label: "Paused", value: h.sources.paused },
        ]} />
      </Area>
      <Area title="Egress" state={{ ok: egress, text: egress ? "Answering" : "Not answering" }}>
        <Facts items={[
          { label: "Blocked in the last hour", value: h.egress.blockedLastHour === null ? "Unknown" : h.egress.blockedLastHour },
        ]} />
        {!egress ? <p className="fine">The egress service didn't answer. Feed fetching may be blocked until it does.</p> : null}
      </Area>
      <Area title="Accounts"><Facts items={[{ label: "Accounts", value: h.accounts.total }]} /></Area>
      {h.signupWaitingForMail && !h.mail ? (
        <Area title="Outgoing email" state={{ ok: false, text: "Not set up" }}>
          <p className="fine">Open sign-up stays closed until outgoing email is set up. It's needed to confirm addresses and reset passwords. See Outgoing email in the self-hosting guide.</p>
        </Area>
      ) : null}
      {h.mail ? (
        <Area title="Outgoing email" state={{ ok: h.mail.status === "ok", text: h.mail.status === "ok" ? "Working" : h.mail.status === "failing" ? "Not working" : "Not checked yet" }}>
          <Facts items={[
            { label: "Mail server", value: h.mail.server },
            { label: "Sent in the last day", value: h.mail.sentLastDay },
            { label: "Refused in the last day", value: h.mail.failedLastDay },
          ]} />
          {h.mail.status === "failing" ? <p className="fine">The mail server didn't accept the connection or the login ({h.mail.lastError}). The server checks again every 10 minutes; open sign-up stays closed until it works.</p> : null}
        </Area>
      ) : null}
    </div>
  );
}

export function AdminHealthPanel() {
  const q = useQuery({ ...adminHealthQuery, refetchInterval: 30_000 });
  return (
    <div className="fx-stack">
      <div className="fx-acts-row">
        <Button onClick={() => void q.refetch()} disabled={q.isFetching}><Icon name="clock" size="sm" />{q.isFetching ? "Checking…" : "Check again"}</Button>
        {q.data ? <span className="fine">Checked {timeAgo(new Date(q.dataUpdatedAt).toISOString()) || "just now"}</span> : null}
      </div>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="the health check" onRetry={() => void q.refetch()} /> : null}
      {q.data ? (
        <>
          <Body h={q.data} />
          <BridgedSources bridge={q.data.bridge} />
          <SitesNotFollowed misses={q.data.discoveryMisses} />
        </>
      ) : null}
    </div>
  );
}
