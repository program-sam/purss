import { memo } from "react";
import type { ItemDTO, Sort } from "@purss/domain";
import { Avatar, Icon } from "@purss/ui";
import { KIND_LABELS, workflowLabel } from "../lib/constants.ts";
import { plural, shortDate } from "../lib/format.ts";
import { itemDate, lengthText } from "../lib/items.ts";
import { FreshDot, PendingMark, useFace } from "../components/item-bits.tsx";
import { TriageActions } from "../components/ItemRow.tsx";
import { useRowCtx, useRowMarks } from "../components/row-context.tsx";

type Col = { key: string; label: string; sort?: [Sort, Sort | null] };
const COLS: Col[] = [
  { key: "source", label: "Source", sort: ["source", null] },
  { key: "title", label: "Title", sort: ["title", null] },
  { key: "type", label: "Type" },
  { key: "length", label: "Length" },
  { key: "added", label: "Date", sort: ["newest", "oldest"] },
  { key: "state", label: "State" },
  { key: "kept", label: "Kept", sort: ["kept", null] },
];

const Row = memo(function Row({ item }: { item: ItemDTO }) {
  const c = useRowCtx();
  const face = useFace(item);
  const { active, picked } = useRowMarks(item.id);
  const kept = item.basketIds.length;
  return (
    <tr className={`irow${active ? " sel-row" : ""}${picked ? " picked" : ""}${item.workflow === "ignored" ? " dim" : ""}`} data-item={item.id} data-wf={item.workflow} data-leaves={c.leaves(item)}>
      <td><span className="c-src"><Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} /><span dir="auto">{face.name}</span></span></td>
      <td className="ttl">
        <button type="button" className="tb" data-act="open" onClick={() => c.onOpen(item)} aria-pressed={c.selecting ? picked : undefined} aria-current={!c.selecting && active ? "true" : undefined}>
          {c.selecting ? <span className={`cbx${picked ? " on" : ""}`} aria-hidden="true"><Icon name="check" /></span> : <FreshDot fresh={item.fresh} />}
          <span className="title" dir="auto">{item.title}</span>
        </button>
      </td>
      <td>{KIND_LABELS[item.kind]}</td>
      <td>{lengthText(item) || " "}</td>
      <td><time dateTime={itemDate(item)}>{shortDate(itemDate(item), c.now, c.timeZone)}</time></td>
      <td>{workflowLabel(item.workflow, item.kind)}<PendingMark id={item.id} /></td>
      <td>
        {item.workflow === "ignored" ? (
          <button type="button" className="kbtn" onClick={() => c.onRestore(item)}>Restore</button>
        ) : c.selecting ? (kept ? plural(kept, "basket") : "") : (
          <button type="button" className={`kbtn${kept ? " on" : ""}`} aria-haspopup="menu"
            aria-label={`${kept ? `Kept in ${plural(kept, "basket")}. Change baskets for` : "Keep in a basket:"} ${item.title}`} onClick={(e) => c.onKeep(item, e.currentTarget)}>
            <Icon name="bookmark" />{kept || ""}
          </button>
        )}
      </td>
      <td>{c.selecting ? null : <span className="tacts">{item.workflow !== "ignored" ? <TriageActions item={item} tipAt="above" /> : null}<button type="button" className="rmore" aria-haspopup="menu" aria-label={`Actions for ${item.title}`} onClick={(e) => c.onMore(item, e.currentTarget)}><Icon name="more" /></button></span>}</td>
    </tr>
  );
});

/** Sortable columns map to the sorts the server supports; the others are plain headings. */
export function TableView({ items, sort, onSort }: { items: ItemDTO[]; sort: Sort; onSort: (s: Sort) => void }) {
  return (
    <div className="tblwrap">
      <table className="tbl" aria-label="Items">
        <thead>
          <tr>
            {COLS.map((col) => {
              if (!col.sort) return <th key={col.key} scope="col"><span>{col.label}</span></th>;
              const [first, second] = col.sort;
              const on = sort === first || sort === second;
              const dir = sort === first && second ? "descending" : sort === second ? "ascending" : "ascending";
              const next: Sort = second ? (sort === first ? second : first) : first;
              return (
                <th key={col.key} scope="col" aria-sort={on ? dir : undefined}>
                  <button type="button" onClick={() => onSort(next)}>{col.label}{on ? <Icon name={dir === "ascending" ? "up" : "down"} /> : null}</button>
                </th>
              );
            })}
            <th scope="col"><span className="sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>{items.map((it) => <Row key={it.id} item={it} />)}</tbody>
      </table>
    </div>
  );
}
