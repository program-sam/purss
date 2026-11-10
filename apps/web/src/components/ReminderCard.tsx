import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReminderDTO } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { messageOf, post } from "../api/client.ts";
import { keys, remindersQuery } from "../api/queries.ts";
import { shortDate } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";

/** Path of the reminder action endpoint, built by the reminders executor alongside GET /api/reminders. */
const actionPath = (id: string) => `/api/reminders/${encodeURIComponent(id)}`;

/**
 * "A year ago you kept …": a quiet, factual note on Home. It uses the recorded keep date, never
 * infers liking, and changes nothing about the item. Rendered only when the server returns one.
 */
export function ReminderCard() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const { toast } = useToasts();
  const q = useQuery({ ...remindersQuery, enabled: ws.prefs.reminders });
  const r: ReminderDTO | undefined = ws.prefs.reminders ? q.data?.[0] : undefined;
  if (!r) return null;

  async function act(action: "hide" | "snooze") {
    if (!r) return;
    qc.setQueryData<ReminderDTO[]>(keys.reminders, (cur) => (cur ?? []).filter((x) => x.id !== r.id));
    try {
      await post(actionPath(r.id), { action });
      toast(action === "hide" ? "Hidden. It won't come back." : "Snoozed. It may come back later.");
    } catch (err) {
      void qc.invalidateQueries({ queryKey: keys.reminders });
      toast(messageOf(err), { tone: "error" });
    }
  }

  return (
    <section className="reminder" aria-label="From a year ago">
      <Icon name="cal" />
      <div className="tx">
        <p>
          A year ago you kept{" "}
          <button type="button" className="link" onClick={() => nav.patchSearch({ item: r.itemId }, false)}><bdi>{r.title}</bdi></button>
          <span className="fine"> from <bdi>{r.sourceTitle}</bdi>, in <bdi>{r.basketName}</bdi>, on {shortDate(r.keptAt, Date.now(), ws.prefs.timezone)}.</span>
        </p>
        <p className="fine">{r.captureLabel}. Nothing about it has changed.</p>
      </div>
      <div className="acts">
        <Button onClick={() => void act("snooze")}>Snooze</Button>
        <Button onClick={() => void act("hide")}>Hide</Button>
      </div>
    </section>
  );
}
