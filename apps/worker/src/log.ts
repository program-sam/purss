import { redactText } from "@purss/freshrss";

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type Logger = (level: "info" | "warn" | "error", message: string, fields?: LogFields) => void;

/** One JSON object per line on stdout/stderr. Messages and string fields pass through redaction. */
export function createLogger(write: (line: string, level: "info" | "warn" | "error") => void = defaultWrite): Logger {
  return (level, message, fields = {}) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? redactText(v) : v;
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg: redactText(message), ...safe }), level);
  };
}

function defaultWrite(line: string, level: "info" | "warn" | "error"): void {
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}
