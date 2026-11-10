import { useEffect } from "react";
import { Icon, useBreakpoint } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useSignOut } from "./use-sign-out.ts";
import "./header-account.css";

/**
 * Account controls in the header that the sidebar's foot can't offer everywhere: Settings on a phone, where the sidebar is a
 * drawer behind Collections, and Sign out on a shared computer, where leaving should be one press.
 */
export function HeaderAccount() {
  const bp = useBreakpoint();
  const overlays = useOverlays();
  const session = useSession().data;
  const { signOut, busy, error } = useSignOut();
  const { toast } = useToasts();
  // Signing out can be refused (changes not sent yet, or no connection): say so, as Settings does.
  useEffect(() => { if (error) toast(error, { tone: "error" }); }, [error, toast]);
  if (session?.state !== "signed_in") return null;
  return (
    <>
      {bp === "xs" ? <button type="button" className="ibtn bar-acct" aria-label="Settings" onClick={() => overlays.open({ kind: "settings" })}><Icon name="gear" /></button> : null}
      {session.account?.sharedComputer ? <button type="button" className="mbtn bar-acct" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out…" : "Sign out"}</button> : null}
    </>
  );
}
