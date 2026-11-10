import { useQuery } from "@tanstack/react-query";
import { Icon } from "@purss/ui";
import { comingUpQuery } from "../api/reminder-queries.ts";
import { dayLabel } from "../lib/reminder-days.ts";
import { useNav } from "../nav.ts";
import "./reminders.css";

/** Home's "Coming up": the reminders set on kept items for today and the next six days. Renders nothing when there are none. */
export function ComingUp() {
  const nav = useNav();
  const q = useQuery(comingUpQuery);
  const list = q.data?.reminders ?? [];
  if (!q.data || !list.length) return null;
  return (
    <section className="mod wb coming" aria-labelledby="wb-coming">
      <header className="mod-h"><h2 className="mod-t" id="wb-coming"><span className="t">Coming up</span></h2></header>
      <ul className="mod-b">
        {list.map((r) => (
          <li key={r.id}>
            <button type="button" className="coming-row" onClick={() => nav.openItem(r.itemId)}>
              <span className="when">{dayLabel(r.remindOn, q.data.today)}</span>
              <span className="what">
                <span className="title" dir="auto">{r.title}</span>
                <span className="fine" dir="auto">{r.note ? r.note : r.sourceTitle}</span>
              </span>
              <Icon name="chev" size="sm" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
