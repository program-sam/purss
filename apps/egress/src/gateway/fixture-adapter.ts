import type { GatewayAdapter, RefreshContext, RefreshResult, StagedEntry } from "./types.ts";

/*
 * Fixture-driven adapter used ONLY by tests to exercise the gateway contract (staging,
 * cursor, backpressure, outages, grant loss). It is never registered by main.ts: this
 * build has no approved real service adapter.
 */

export class FixtureAdapter implements GatewayAdapter {
  id: string;
  entries: StagedEntry[];
  /** Outcomes returned before falling back to cursor-paged delivery of `entries`. */
  script: RefreshResult[] = [];
  calls: RefreshContext[] = [];

  constructor(id: string, entries: StagedEntry[] = []) {
    this.id = id;
    this.entries = entries;
  }

  async refresh(context: RefreshContext): Promise<RefreshResult> {
    this.calls.push({ ...context });
    const scripted = this.script.shift();
    if (scripted) return scripted;
    const start = context.cursor ? Number(context.cursor) : 0;
    const slice = this.entries.slice(start, start + context.limit);
    return { kind: "ok", entries: slice, nextCursor: String(start + slice.length) };
  }
}

export function fixtureEntry(n: number, overrides: Partial<StagedEntry> = {}): StagedEntry {
  const day = String(1 + (n % 28)).padStart(2, "0");
  return {
    guid: `fixture-${n}`,
    title: `Fixture entry ${n}`,
    url: `https://source.example/items/${n}`,
    author: "Fixture Author",
    publishedAt: `2026-10-${day}T10:00:00.000Z`,
    summaryHtml: `<p>Summary ${n}</p>`,
    contentHtml: `<p>Full content ${n}</p>`,
    ...overrides,
  };
}
