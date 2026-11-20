import { app } from "@purss/copy/app";
import type { ItemDTO } from "@purss/domain";
import { Icon } from "@purss/ui";
import { groupByDay } from "../lib/format.ts";
import { itemDate } from "../lib/items.ts";
import { ItemRow } from "../components/ItemRow.tsx";
import { useRowCtx } from "../components/row-context.tsx";

const t = app.views.timeline;

/** Items grouped by the calendar day of their time in lists (ItemDTO.listedAt). */
export function TimelineView({ items }: { items: ItemDTO[] }) {
  const c = useRowCtx();
  const groups = groupByDay(items, itemDate, c.now, c.timeZone);
  return (
    <>
      <p className="fine tl-note"><Icon name="cal" size="sm" />{t.note}</p>
      <div className="list">
        {groups.map((g) => (
          <section className="day" key={g.key} aria-label={g.label}>
            <h3>{g.label}</h3>
            <ul>{g.items.map((it) => <ItemRow key={it.id} item={it} />)}</ul>
          </section>
        ))}
      </div>
    </>
  );
}
