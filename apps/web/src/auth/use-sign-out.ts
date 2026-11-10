import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { clearAnnotationOutbox } from "../annotations/use-annotations.ts";
import { messageOf, post } from "../api/client.ts";
import { clearLateWrites } from "../lib/late-writes.ts";
import { wipeOfflineCopies } from "../offline/worker-link.ts";
import { useOverlays } from "../state/overlays.tsx";
import { clearHints } from "../state/ui-store.ts";

/**
 * Signing out of this browser: ends the session, removes what this device saved for offline reading, any highlights not yet
 * sent and positions waiting to be sent, forgets this browser's hints, and goes to the sign-in page. Used by Settings and by the header on a shared computer.
 */
export function useSignOut(): { signOut: () => Promise<void>; busy: boolean; error: string } {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const overlays = useOverlays();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setBusy(true); setError("");
    try {
      await post("/api/auth/logout");
      await wipeOfflineCopies();
      await clearAnnotationOutbox();
      clearLateWrites();
      clearHints();
      qc.clear();
      overlays.close();
      void navigate({ to: "/signin" });
    } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return { signOut, busy, error };
}
