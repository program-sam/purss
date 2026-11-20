export default {
  status: { queued: "Waiting", leased: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" },
  summary: (attempts: number, updated: string, account: string | null) => `${attempts} ${attempts === 1 ? "attempt" : "attempts"} · updated ${updated} · ${account !== null ? `account ${account}` : "system"}`,
  justNow: "just now",
  retry: "Retry",
  cancel: "Cancel",
  queuedAgain: "Job queued to run again",
  cancelled: "Job cancelled",
  filters: { failed: "Failed", queued: "Waiting", leased: "Running", all: "Recent" },
  redacted: "Error text is redacted: no addresses with secrets, no tokens, no article content.",
  jobsName: "jobs",
  noFailed: "No failed jobs.",
  nothingHere: "Nothing here.",
};
