import { useEffect } from "react";
import { Icon, useBreakpoint } from "@purss/ui";
import { useSession } from "../api/hooks.ts";
import { useOverlays } from "../state/overlays.tsx";
import { usePopups } from "../state/popups.tsx";
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
  const popups = usePopups();
  const session = useSession().data;
  const { signOut, busy, error } = useSignOut();
  const { toast } = useToasts();
  // Signing out can be refused (changes not sent yet, or no connection): say so, as Settings does.
  useEffect(() => { if (error) toast(error, { tone: "error" }); }, [error, toast]);
  if (session?.state !== "signed_in") return null;
  const name = session.account?.displayName;
  const accountEntries = [
    { label: "Settings", icon: "gear" as const, onSelect: () => overlays.open({ kind: "settings" }) },
    { type: "separator" as const },
    { label: busy ? "Signing out…" : "Sign out", disabled: busy, onSelect: () => { void signOut(); } },
  ];
  return (
    <>
      <button type="button" className={`${bp === "xs" ? "ibtn" : "mbtn"} bar-acct`} aria-haspopup="menu" aria-label={name ? `Account menu for ${name}` : "Account menu"}
        onClick={(e) => popups.menu(e.currentTarget, accountEntries, "Account")}>
        <Icon name="user" />{bp === "xs" ? null : <span dir="auto">{name ?? "Account"}</span>}
      </button>
      {session.account?.sharedComputer ? <button type="button" className="mbtn bar-acct" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out…" : "Sign out"}</button> : null}
    </>
  );
}
