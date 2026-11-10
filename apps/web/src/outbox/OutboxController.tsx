import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setSignOutGate } from "../api/client.ts";
import { putItem, refreshWorkspace } from "../api/queries.ts";
import { onResume } from "../offline/status.ts";
import { useToasts } from "../state/toasts.tsx";
import { outbox } from "./instance.ts";
import { droppedLine, sentLine } from "./messages.ts";
import { SignOutDialog } from "./SignOutDialog.tsx";
import { signOutGate } from "./sign-out.ts";
import type { SignOutChoice } from "./sign-out.ts";

/**
 * Sends again when the connection returns or the tab is shown, says so when changes that were waiting went through
 * (or were refused), asks before the page is left with changes that have not been confirmed, and asks what to do with
 * them when the person signs out. (The outbox learns who is signed in from the session query.)
 */
export function OutboxController() {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const [asking, setAsking] = useState<{ count: number; failed: boolean; busy: boolean; answer: (c: SignOutChoice) => void } | null>(null);

  useEffect(() => {
    setSignOutGate(async () => {
      try {
        return await signOutGate(outbox, (info) => new Promise<SignOutChoice>((resolve) => {
          setAsking({ ...info, busy: false, answer: (c) => { setAsking((a) => (a ? { ...a, busy: c === "send" } : a)); resolve(c); } });
        }));
      } finally { setAsking(null); }
    });
    return () => setSignOutGate(null);
  }, []);

  useEffect(() => onResume(() => outbox.resume()), []);

  // Changes that had been kept for later: one message for the batch, then the lists show PURSS's truth.
  const batch = useRef({ sent: 0, dropped: [] as { reason: "conflict" | "rejected"; message: string }[], timer: null as ReturnType<typeof setTimeout> | null });
  useEffect(() => outbox.onOutcome((o) => {
    if (o.status === "deferred" || !o.late) return;
    const b = batch.current;
    if (o.status === "sent") {
      const r = o.result;
      if (!(r.kind === "undoWorkflow" && !r.item)) b.sent += 1; // an Undo with nothing left to undo says nothing
      if ((r.kind === "workflow" || r.kind === "undoWorkflow") && r.item) putItem(qc, r.item);
      if (r.kind === "keep") putItem(qc, r.item);
    } else b.dropped.push({ reason: o.reason, message: o.message });
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      b.timer = null;
      const { sent, dropped } = b;
      b.sent = 0; b.dropped = [];
      refreshWorkspace(qc);
      if (dropped.length) toast(droppedLine(dropped), { tone: "error" });
      else if (sent) toast(sentLine(sent), { tone: "none" });
    }, 800);
  }), [qc, toast]);

  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => {
      if (outbox.pendingCount() === 0) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, []);

  return asking ? <SignOutDialog count={asking.count} failed={asking.failed} busy={asking.busy} onChoose={asking.answer} /> : null;
}
