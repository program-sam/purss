import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DiscoverSuggestion } from "@purss/domain";
import { app } from "@purss/copy/app";
import { Button, Check, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { useSavePreferences } from "../../state/prefs.ts";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { fkeys, suggestionsQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Note, Page, Section } from "../shared/bits.tsx";

const copy = app.discover.discoverPage;

const KIND_LABEL: Record<DiscoverSuggestion["kind"], string> = copy.kind;

function names(titles: string[]): string {
  return titles.length <= 1 ? titles.join("") : copy.and(titles.slice(0, -1).join(", "), titles[titles.length - 1]);
}

function Reason({ s }: { s: DiscoverSuggestion }) {
  const ws = useWorkspace();
  if (s.reason.kind === "because") {
    const titles = s.reason.sourceIds.map((id) => ws.sourceById.get(id)?.title).filter((t): t is string => !!t);
    return <span className="fine">{titles.length ? <>{copy.followedBy}<span dir="auto">{names(titles)}</span></> : copy.followedByLikeYou}</span>;
  }
  return <span className="fine">{s.reason.kind === "wildcard" ? copy.wildcard : copy.popular}</span>;
}

function Row({ s, onDismiss }: { s: DiscoverSuggestion; onDismiss: (s: DiscoverSuggestion) => void }) {
  const overlays = useOverlays();
  return (
    <div className="fx-row wrap">
      <div className="fx-grow">
        <b dir="auto">{s.title}</b>
        <span className="fine">{KIND_LABEL[s.kind]}{s.host ? ` · ${s.host}` : ""}</span>
        <Reason s={s} />
      </div>
      <div className="fx-end">
        {/* Following goes through Add source, which looks the address up again like any pasted link. */}
        <Button variant="primary" onClick={() => overlays.open({ kind: "add-source", url: s.feedUrl, entry: "suggestion" })}><Icon name="plus" size="sm" />{copy.follow}</Button>
        <Button onClick={() => onDismiss(s)}>{copy.notInterested}</Button>
      </div>
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: DiscoverSuggestion[] }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  async function dismiss(s: DiscoverSuggestion) {
    setHidden((h) => new Set(h).add(s.key));
    try {
      await post("/api/suggestions/dismiss", { key: s.key });
      void qc.invalidateQueries({ queryKey: fkeys.suggestions });
      toast(copy.wontBeSuggested(s.title));
    } catch (err) {
      setHidden((h) => { const n = new Set(h); n.delete(s.key); return n; });
      toast(messageOf(err), { tone: "error" });
    }
  }
  const list = suggestions.filter((s) => !hidden.has(s.key));
  if (!list.length) {
    return (
      <div className="empty card-like">
        <h2>{app.words.nothingNewRightNow}</h2>
        <p>{copy.checkBack}</p>
      </div>
    );
  }
  return <div className="fx-rows">{list.map((s) => <Row key={s.key} s={s} onDismiss={(x) => void dismiss(x)} />)}</div>;
}

function SharingChoice() {
  const ws = useWorkspace();
  const save = useSavePreferences();
  const qc = useQueryClient();
  return (
    <Check checked={ws.prefs.discoveryShare} onChange={(v) => { void save({ discoveryShare: v }).then(() => qc.invalidateQueries({ queryKey: fkeys.suggestions })); }}
      hint={app.words.purssCountsSourcesFollowedByPeople}>
      {app.words.shareMySources}
    </Check>
  );
}

/**
 * Discovery (hosted only): sources that readers who follow what you follow also follow. Until the graph
 * holds a source the page says it is coming soon; suggestions are only for readers who share their own.
 */
export function DiscoverPage() {
  const session = useSession().data;
  const hosted = session?.installation.mode === "hosted";
  const q = useQuery({ ...suggestionsQuery, enabled: hosted });
  if (session && !hosted) {
    return <Page title={app.words.discovery}><Note>{copy.hostedOnly}</Note></Page>;
  }
  const lead = copy.lead;
  return (
    <Page title={app.words.discovery} lead={lead}>
      {q.isPending ? <Loading /> : q.isError ? <LoadFailed error={q.error} what={copy.suggestionsName} onRetry={() => void q.refetch()} /> : !q.data.ready ? (
        <div className="empty card-like">
          <h2>{copy.comingSoon}</h2>
          <p>{copy.comingSoonText}</p>
        </div>
      ) : !q.data.sharing ? (
        <div className="empty card-like">
          <h2>{copy.shareToGet}</h2>
          <p>{copy.shareToGetText}</p>
        </div>
      ) : (
        <Section title={copy.suggestions}><Suggestions suggestions={q.data.suggestions} /></Section>
      )}
      <Section title={app.words.sharing}><SharingChoice /></Section>
    </Page>
  );
}
