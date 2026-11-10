import type { ItemDTO } from "@purss/domain";
import { ItemRow } from "../components/ItemRow.tsx";

export function ListView({ items }: { items: ItemDTO[] }) {
  return <ul className="list">{items.map((it) => <ItemRow key={it.id} item={it} />)}</ul>;
}
