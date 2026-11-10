import { sparklineLabel } from "../lib/stats.ts";

/**
 * One bar per week, oldest first; the tallest week fills the height, so the chart shows a shape and
 * the label spells out every number (and the average) for people who can't see it.
 */
export function Sparkline({ weekly, width = 156, height = 28 }: { weekly: readonly number[]; width?: number; height?: number }) {
  const top = Math.max(1, ...weekly);
  const gap = 1;
  const bar = (width - gap * (weekly.length - 1)) / weekly.length;
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={sparklineLabel(weekly)}>
      <line className="spark-base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      {weekly.map((count, i) => {
        if (count <= 0) return null;
        const h = Math.max(2, (count / top) * (height - 2));
        return <rect key={i} x={i * (bar + gap)} y={height - 1 - h} width={bar} height={h} rx={1} />;
      })}
    </svg>
  );
}
