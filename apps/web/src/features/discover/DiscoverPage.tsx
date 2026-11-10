import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DiscoverSuggestion } from "@purss/domain";
import { Button, Check, Icon } from "@purss/ui";
import { messageOf, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { useOverlays } from "../../state/overlays.tsx";
import { useSavePreferences } from "../../state/prefs.ts";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { fkeys, suggestionsQuery } from "../shared/api.ts";
import { Loading, LoadFailed, Note, Page, Section } from "../shared/bits.tsx";

const KIND_LABEL: Record<DiscoverSuggestion["kind"], string> = { feed: "Feed", youtube: "YouTube", podcast: "Podcast" };

function names(titles: string[]): string {
  return titles.length <= 1 ? titles.join("") : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

function Reason({ s }: { s: DiscoverSuggestion }) {
  const ws = useWorkspace();
  if (s.reason.kind === "because") {
    const titles = s.reason.sourceIds.map((id) => ws.sourceById.get(id)?.title).filter((t): t is string => !!t);
    return <span className="fine">{titles.length ? <>Followed by readers of <span dir="auto">{names(titles)}</span></> : "Followed by readers like you"}</span>;
  }
  return <span className="fine">{s.reason.kind === "wildcard" ? "Wildcard: popular here" : "Popular here"}</span>;
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
        <Button variant="primary" onClick={() => overlays.open({ kind: "add-source", url: s.feedUrl })}><Icon name="plus" size="sm" />Follow…</Button>
        <Button onClick={() => onDismiss(s)}>Not interested</Button>
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
      toast(`${s.title} won't be suggested again`);
    } catch (err) {
      setHidden((h) => { const n = new Set(h); n.delete(s.key); return n; });
      toast(messageOf(err), { tone: "error" });
    }
  }
  const list = suggestions.filter((s) => !hidden.has(s.key));
  if (!list.length) {
    return (
      <div className="empty card-like">
        <h2>Nothing new right now</h2>
        <p>Check back later.</p>
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
      hint="Your sources count anonymously. Private sources never count. Only people who share get suggestions.">
      Share my sources
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
    return <Page title="Discovery"><Note>Discovery is only on hosted PURSSes. A PURSS you host yourself never compares what its readers follow.</Note></Page>;
  }
  const lead = "New sources, picked from what readers like you follow. Changes daily.";
  return (
    <Page title="Discovery" lead={lead}>
      {q.isPending ? <Loading /> : q.isError ? <LoadFailed error={q.error} what="suggestions" onRetry={() => void q.refetch()} /> : !q.data.ready ? (
        <div className="empty card-like">
          <h2>Coming soon</h2>
          <p>Suggestions start once enough people share their sources.</p>
        </div>
      ) : !q.data.sharing ? (
        <div className="empty card-like">
          <h2>Share to get suggestions</h2>
          <p>Turn on sharing below to see them.</p>
        </div>
      ) : (
        <Section title="Suggestions"><Suggestions suggestions={q.data.suggestions} /></Section>
      )}
      <Section title="Sharing"><SharingChoice /></Section>
    </Page>
  );
}
