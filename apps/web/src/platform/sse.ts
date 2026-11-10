/**
 * Server-sent events over fetch, for the apps: EventSource can't send an Authorization header, and
 * the app's token never goes in an address. Only the `data` field matters here (PURSS sends
 * nothing else but comments), so this is the part of the format that delivers it.
 */

/** Feeds text as it arrives and calls back with each message's data. Handles \n, \r\n and \r line ends split anywhere. */
export class EventStreamParser {
  private buffer = "";
  private data: string[] = [];
  private lastWasCr = false;
  private readonly onMessage: (data: string) => void;
  constructor(onMessage: (data: string) => void) { this.onMessage = onMessage; }

  push(chunk: string): void {
    let text = chunk;
    // A \r\n split across chunks: the \n belongs to the line already ended by \r.
    if (this.lastWasCr && text.startsWith("\n")) text = text.slice(1);
    this.lastWasCr = text.endsWith("\r");
    this.buffer += text;
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.onMessage(this.data.join("\n"));
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }
}

/** How long to wait before connecting again: 1 s, doubling to 60 s, with up to a fifth added at random. */
export function reconnectDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, failures));
  return Math.round(base * (1 + random() * 0.2));
}

export type StreamDeps = {
  open: (signal: AbortSignal) => Promise<Response>;
  /** Called when the server says this client isn't allowed (401): no reconnecting after that. */
  onRefused?: (response: Response) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

/** Keep an event stream open, reconnecting after drops, until the returned function is called. */
export function followEvents(deps: StreamDeps, onMessage: (data: string) => void): () => void {
  const set = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const stop = new AbortController();
  let timer: unknown = null;
  let failures = 0;

  const connect = async (): Promise<void> => {
    timer = null;
    if (stop.signal.aborted) return;
    try {
      const res = await deps.open(stop.signal);
      if (res.status === 401) { deps.onRefused?.(res); return; }
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      failures = 0;
      const parser = new EventStreamParser(onMessage);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
    } catch {
      if (stop.signal.aborted) return;
      failures++;
    }
    if (!stop.signal.aborted) timer = set(() => void connect(), reconnectDelay(failures));
  };

  void connect();
  return () => {
    stop.abort();
    if (timer !== null) clear(timer);
  };
}
