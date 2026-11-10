/** Names (of sources, collections, baskets) in a running line: each kept whole in its own direction, so an Arabic name next to a Latin one, or next to a comma, does not reorder. */
export function Names({ names, separator = ", " }: { names: readonly string[]; separator?: string }) {
  return <>{names.map((n, i) => <span key={i}>{i ? separator : ""}<bdi>{n}</bdi></span>)}</>;
}
