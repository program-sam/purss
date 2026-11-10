import type { ItemDTO } from "@purss/domain";
import { Icon } from "@purss/ui";
import { groupByDay } from "../lib/format.ts";
import { itemDate } from "../lib/items.ts";
import { ItemRow } from "../components/ItemRow.tsx";
import { useRowCtx } from "../components/row-context.tsx";

/** Items grouped by calendar day of their publication date (arrival date when a feed gave none). */
export function TimelineView({ items }: { items: ItemDTO[] }) {
  const c = useRowCtx();
  const groups = groupByDay(items, itemDate, c.now, c.timeZone);
  return (
    <>
      <p className="fine tl-note"><Icon name="cal" size="sm" />Grouped by publication date. Items without one use the day they arrived.</p>
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
