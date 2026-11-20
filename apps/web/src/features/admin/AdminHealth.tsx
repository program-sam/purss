import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AdminBridgeHealth, AdminHealth, DiscoveryMissDTO } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Icon } from "@purss/ui";
import type { IconName } from "@purss/ui";
import { dateTime, formatCount, plural, timeAgo } from "../../lib/format.ts";
import { platform } from "../../platform/index.ts";
import { adminHealthQuery } from "../shared/api.ts";
import { Facts, Loading, LoadFailed } from "../shared/bits.tsx";
import { bridgeFailureText, bytesOrUnknown, durationLabel, engineLabel, missLabel } from "./admin-model.ts";

const t = app.admin.adminHealth;

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
  return <time dateTime={iso} title={dateTime(iso)}>{timeAgo(iso) || app.words.justNow}</time>;
}

function BridgedSources({ bridge }: { bridge: AdminBridgeHealth | null }) {
  if (!bridge) {
    return <Area title={t.bridged.title}><p className="fine">{t.bridged.notRun}</p></Area>;
  }
  if (bridge.status !== "ok") {
    return (
      <Area title={t.bridged.title} state={{ ok: false, text: app.words.notAnswering }}>
        <p className="fine">{t.bridged.logUnreadable}</p>
      </Area>
    );
  }
  const failing = bridge.failing;
  return (
    <Area title={t.bridged.title} state={{ ok: failing.length === 0, text: failing.length ? t.bridged.failingState(plural(failing.length, t.bridged.sourceIs, t.bridged.sourcesAre)) : t.bridged.noneFailing }}>
      <p className="fine">{t.bridged.window(bridge.days)}</p>
      <div className="fx-scroll">
        <table className="fx-tbl" aria-label={`Bridged services over the last ${bridge.days} days`}>
          <thead>
            <tr><th scope="col">{app.words.service}</th><th scope="col" className="num">{t.bridged.servicesCaption.success}</th><th scope="col" className="num">{t.bridged.servicesCaption.attempts}</th><th scope="col" className="num">{t.bridged.servicesCaption.ok}</th><th scope="col" className="num">{t.bridged.servicesCaption.empty}</th><th scope="col" className="num">{app.words.failed}</th><th scope="col" className="num">{t.bridged.servicesCaption.fromCache}</th></tr>
          </thead>
          <tbody>
            {bridge.services.map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                <td className="num">{s.successPercent === null ? t.bridged.noAttempts : `${s.successPercent}%`}</td>
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
      <h4>{t.bridged.failingNow}</h4>
      {failing.length ? (
        <div className="fx-scroll">
          <table className="fx-tbl" aria-label="Bridged sources that are failing">
            <thead>
              <tr><th scope="col">{app.words.service}</th><th scope="col">{app.words.source}</th><th scope="col">{t.bridged.failingCaption.whatFailed}</th><th scope="col">{t.bridged.failingCaption.failingSince}</th><th scope="col">{t.bridged.failingCaption.lastWorked}</th></tr>
            </thead>
            <tbody>
              {failing.map((f) => (
                <tr key={`${f.service}/${f.key}`}>
                  <th scope="row">{f.serviceName}</th>
                  <td>{f.pageUrl
                    ? <a className="link" href={f.pageUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); platform.openExternal(f.pageUrl!); }}>{f.key}</a>
                    : f.key}</td>
                  <td className="wrap">{bridgeFailureText(f.outcome)}</td>
                  <td><When iso={f.failingSince} />{f.attempts ? ` · ${plural(f.attempts, t.bridged.try, t.bridged.tries)}` : ""}</td>
                  <td>{f.lastOkAt ? <When iso={f.lastOkAt} /> : t.bridged.notInLast30Days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="fine">{t.bridged.noneRightNow}</p>}
    </Area>
  );
}

function SitesNotFollowed({ misses }: { misses: DiscoveryMissDTO[] }) {
  return (
    <Area title={t.misses.title}>
      <p className="fine">{t.misses.hint}</p>
      {misses.length ? (
        <div className="fx-scroll">
          <table className="fx-tbl" aria-label="Sites people couldn't follow">
            <thead>
              <tr><th scope="col">{t.misses.caption.site}</th><th scope="col">{t.misses.caption.why}</th><th scope="col" className="num">{t.misses.caption.times}</th></tr>
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
      ) : <p className="fine">{t.misses.none}</p>}
    </Area>
  );
}

function Body({ h }: { h: AdminHealth }) {
  const engineOk = h.engine.status === "ok";
  const egress = h.egress.status === "ok";
  return (
    <div className="fx-grid">
      <Area title={t.engine.title} state={{ ok: engineOk, text: engineLabel(h.engine.status) }}>
        <Facts items={[
          { label: t.engine.lastSync, value: h.engine.lastSyncAt ? timeAgo(h.engine.lastSyncAt) : app.words.unknown },
          { label: t.engine.behindBy, value: durationLabel(h.engine.lagSeconds) },
          { label: t.engine.version, value: h.engine.version ?? t.engine.notReported },
        ]} />
        {h.engine.message ? <p className="fine">{h.engine.message}</p> : null}
      </Area>
      <Area title={t.jobs.title} state={{ ok: h.jobs.failed === 0, text: h.jobs.failed ? `${plural(h.jobs.failed, t.jobs.failedWord)}` : t.jobs.noFailures }}>
        <Facts items={[
          { label: app.words.waiting, value: h.jobs.queued },
          { label: app.words.running, value: h.jobs.leased },
          { label: app.words.failed, value: h.jobs.failed },
          { label: t.jobs.oldestWaiting, value: h.jobs.oldestQueuedSeconds === null ? t.jobs.noneWaiting : durationLabel(h.jobs.oldestQueuedSeconds) },
        ]} />
      </Area>
      <Area title={t.disk.title} state={{ ok: !h.disk.growthPaused, text: h.disk.growthPaused ? t.disk.growthPaused : t.disk.enoughRoom }}>
        <Facts items={[
          { label: t.disk.free, value: bytesOrUnknown(h.disk.freeBytes) },
          { label: app.words.total, value: bytesOrUnknown(h.disk.totalBytes) },
          { label: t.disk.reserve, value: bytesOrUnknown(h.disk.reserveBytes) },
        ]} />
        {h.disk.freeBytes === null ? <p className="fine">{t.disk.unmeasured}</p> : null}
      </Area>
      <Area title={t.database.title}>
        <Facts items={[
          { label: t.database.file, value: bytesOrUnknown(h.database.bytes) },
          { label: t.database.wal, value: bytesOrUnknown(h.database.walBytes) },
        ]} />
      </Area>
      <Area title={t.sources.title} state={{ ok: h.sources.failing === 0, text: h.sources.failing ? t.sources.attention(plural(h.sources.failing, t.sources.needs, t.sources.need)) : t.sources.allCollecting }}>
        <Facts items={[
          { label: t.sources.followed, value: h.sources.total },
          { label: t.sources.failing, value: h.sources.failing },
          { label: app.words.paused, value: h.sources.paused },
        ]} />
      </Area>
      <Area title={t.egress.title} state={{ ok: egress, text: egress ? t.egress.answering : app.words.notAnswering }}>
        <Facts items={[
          { label: t.egress.blocked, value: h.egress.blockedLastHour === null ? app.words.unknown : h.egress.blockedLastHour },
        ]} />
        {!egress ? <p className="fine">{t.egress.noAnswer}</p> : null}
      </Area>
      <Area title={app.words.accounts}><Facts items={[{ label: app.words.accounts, value: h.accounts.total }]} /></Area>
      {h.signupWaitingForMail && !h.mail ? (
        <Area title={t.mail.title} state={{ ok: false, text: t.mail.notSetUp }}>
          <p className="fine">{t.mail.setupNeeded}</p>
        </Area>
      ) : null}
      {h.mail ? (
        <Area title={t.mail.title} state={{ ok: h.mail.status === "ok", text: h.mail.status === "ok" ? t.mail.working : h.mail.status === "failing" ? t.mail.notWorking : t.mail.notChecked }}>
          <Facts items={[
            { label: t.mail.server, value: h.mail.server },
            { label: t.mail.sentLastDay, value: h.mail.sentLastDay },
            { label: t.mail.refusedLastDay, value: h.mail.failedLastDay },
          ]} />
          {h.mail.status === "failing" ? <p className="fine">{t.mail.failing(h.mail.lastError)}</p> : null}
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
        <Button onClick={() => void q.refetch()} disabled={q.isFetching}><Icon name="clock" size="sm" />{q.isFetching ? app.words.checking : t.panel.checkAgain}</Button>
        {q.data ? <span className="fine">{t.panel.checked(timeAgo(new Date(q.dataUpdatedAt).toISOString()) || app.words.justNow)}</span> : null}
      </div>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.panel.healthCheckName} onRetry={() => void q.refetch()} /> : null}
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
