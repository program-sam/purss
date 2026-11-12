import { appUrl } from "@purss/domain";
import { bytesLabel } from "../../lib/format.ts";

/** "under a minute", "5 min", "3 h", "2 days": how long ago, with no false precision. */
export function durationLabel(seconds: number | null): string {
  if (seconds === null) return "Unknown";
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  const d = Math.round(seconds / 86_400);
  return d === 1 ? "1 day" : `${d} days`;
}

/** A number of bytes, or the honest word when it couldn't be measured. */
export function bytesOrUnknown(n: number | null): string {
  return n === null ? "Unknown" : bytesLabel(n);
}

export const ENGINE_LABEL: Record<string, string> = { ok: "Running", starting: "Starting", degraded: "Partly failing", unavailable: "Not available" };
export const engineLabel = (status: string): string => ENGINE_LABEL[status] ?? status;

/** What a bridged source's failure means, in a sentence: the router's word for it (`timeout`, `http_503`…) turned into plain language. */
export function bridgeFailureText(outcome: string): string {
  switch (outcome) {
    case "timeout": return "The service took too long to answer.";
    case "unreachable": return "The bridge couldn't reach the service.";
    case "too_large": return "The answer was too big to use.";
    case "parse_error": return "The answer couldn't be read.";
    case "no_ids": return "Its posts had no usable address.";
  }
  const status = /^http_(\d{3})$/.exec(outcome)?.[1];
  if (!status) return "It failed, and no more is known.";
  if (status === "404") return "The service says that page doesn't exist.";
  if (status === "401" || status === "403") return "The service refused the request.";
  if (status === "429") return "The service is limiting requests.";
  if (status.startsWith("5")) return `The bridge or the service had an error (${status}).`;
  return `The service answered with error ${status}.`;
}

/** Why a lookup of a site failed, as a short label. */
export const MISS_LABEL: Record<string, string> = {
  nofeed: "No feed found",
  unsupported: "Can't be followed",
  unreachable: "Couldn't be reached",
  timeout: "Took too long",
};
export const missLabel = (reason: string): string => MISS_LABEL[reason] ?? reason;

/** Last characters of an id: enough to tell accounts apart without printing the whole identifier. */
export function shortId(id: string | null): string {
  if (!id) return "System";
  return id.length > 10 ? `…${id.slice(-6)}` : id;
}

export type Unit = "MB" | "GB";
const UNIT_BYTES: Record<Unit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 };

/**
 * An allocation typed as a number and a unit. Blank means no limit (`null`); anything that isn't a plain,
 * non-negative number is `undefined`, never a guess.
 */
export function parseAllocation(text: string, unit: Unit): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(t)) return undefined;
  const bytes = Math.round(Number(t) * UNIT_BYTES[unit]);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** The number and unit to show for an existing allocation: whole gigabytes read as GB, everything else as MB. */
export function splitAllocation(bytes: number | null): { text: string; unit: Unit } {
  if (bytes === null) return { text: "", unit: "GB" };
  if (bytes >= UNIT_BYTES.GB && bytes % UNIT_BYTES.GB === 0) return { text: String(bytes / UNIT_BYTES.GB), unit: "GB" };
  return { text: String(Math.round((bytes / UNIT_BYTES.MB) * 1000) / 1000), unit: "MB" };
}

/** The sign-in link for an invitation code, with the address it is for filled in. */
export function inviteLink(origin: string, code: string, email: string): string {
  return `${origin}${appUrl("/invite")}?code=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}`;
}
