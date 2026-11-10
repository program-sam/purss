import { memo } from "react";
import type { ItemDTO } from "@purss/domain";
import { Icon } from "@purss/ui";
import { useId } from "react";
import { timeAgo } from "../lib/format.ts";
import { isTimeBased, itemDate, itemExcerpt, lengthText } from "../lib/items.ts";
import { Art, CopyTag, FreshDot, KeptTag, NoteLine, PendingMark, PlayLink, WfTag, useFace, useItemLabel, videoLink } from "../components/item-bits.tsx";
import { RowActions, actionRoom } from "../components/ItemRow.tsx";
import { useRowCtx, useRowMarks } from "../components/row-context.tsx";
import { Avatar } from "@purss/ui";

const Card = memo(function Card({ item }: { item: ItemDTO }) {
  const c = useRowCtx();
  const face = useFace(item);
  const { active, picked } = useRowMarks(item.id);
  const len = lengthText(item);
  const when = timeAgo(itemDate(item), c.now, c.timeZone);
  const label = useItemLabel(item, { source: face.name, when, showKept: !c.basket, showCopy: !!c.basket });
  const excerptId = useId();
  const excerpt = itemExcerpt(item);
  const noteId = `${excerptId}n`;
  const described = [excerpt ? excerptId : null, c.basket && item.kept?.noteLine ? noteId : null].filter(Boolean).join(" ") || undefined;
  return (
    <li className={`card irow${active ? " sel-row" : ""}${picked ? " picked" : ""}${item.workflow === "ignored" && !c.basket ? " dim" : ""}`} data-item={item.id} data-wf={item.workflow} data-leaves={c.leaves(item)} style={actionRoom(item)}>
      <button type="button" className="card-main" data-act="open" onClick={() => c.onOpen(item)} aria-label={label} aria-describedby={described}
        aria-pressed={c.selecting ? picked : undefined} aria-current={!c.selecting && active ? "true" : undefined}>
        {c.selecting ? <span className="cbx lead" aria-hidden="true"><Icon name="check" /></span> : null}
        <Art item={item} face={face} playable={!!videoLink(item)} />
        <span className="title" dir="auto">{item.title}</span>
        {excerpt ? <span className="excerpt" id={excerptId} dir="auto">{excerpt}</span> : null}
        {c.basket ? <NoteLine item={item} id={noteId} /> : null}
        <span className="meta"><FreshDot fresh={item.fresh} /><Avatar hue={face.hue} initials={face.initials} src={face.iconUrl} size={20} /><span className="sn" dir="auto">{face.name}</span><time dateTime={itemDate(item)}>{when}</time>{len ? <span className="len"><Icon name="clock" size="sm" />{isTimeBased(item.kind) ? len : `${len} read`}</span> : null}</span>
        <span className="wfrow row-s"><WfTag workflow={item.workflow} kind={item.kind} />{c.basket ? <CopyTag item={item} /> : <KeptTag item={item} />}<PendingMark id={item.id} /></span>
      </button>
      {c.selecting ? null : <PlayLink item={item} />}
      <RowActions item={item} />
    </li>
  );
});

export function CardsView({ items }: { items: ItemDTO[] }) {
  return <ul className="grid">{items.map((it) => <Card key={it.id} item={it} />)}</ul>;
}
