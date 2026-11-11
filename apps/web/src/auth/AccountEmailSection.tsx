import { useState } from "react";
import type { FormEvent } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountEmail } from "@purss/domain";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { get, messageOf, post, put } from "../api/client.ts";
import { useToasts } from "../state/toasts.tsx";
import { platform } from "../platform/index.ts";
import { tokenFromLink } from "../lib/email-links.ts";

const KEY = ["account-email"] as const;
/** The account's address and whether it is confirmed (Settings → Security, and the choice to get reminders by email). */
export const accountEmailQuery = queryOptions({ queryKey: KEY, queryFn: ({ signal }) => get<AccountEmail>("/api/account/email", undefined, signal) });

/**
 * Settings → Security when the installation sends email: the account's email address, whether it is
 * confirmed, and changing it (which needs a recent sign-in, through the tab's step-up).
 */
export function AccountEmailSection({ withStepUp }: { withStepUp: (run: () => Promise<void>) => Promise<void> }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const q = useQuery(accountEmailQuery);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = (e: FormEvent) => {
    e.preventDefault();
    void withStepUp(async () => {
      setBusy(true); setError("");
      try {
        const out = await put<AccountEmail>("/api/account/email", { email: value.trim() });
        qc.setQueryData(KEY, out);
        setEditing(false);
        toast(out.confirmed ? "Email address saved" : "We sent a link to confirm it");
      } catch (err) {
        if ((err as { code?: string }).code === "step_up") throw err; // the tab asks to confirm it's you, then saves again
        setError(messageOf(err));
      } finally { setBusy(false); }
    });
  };
  const [link, setLink] = useState("");
  /** In the apps the confirmation link opens a browser; pasting it here confirms the address without one. */
  async function confirmFromLink(e: FormEvent) {
    e.preventDefault();
    const token = tokenFromLink(link);
    if (!token) { setError("That isn't the link from the email. Copy the whole link and try again."); return; }
    setBusy(true); setError("");
    try {
      await post("/api/email/verify", { token });
      setLink("");
      await qc.invalidateQueries({ queryKey: KEY });
      toast("Email address confirmed");
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError("");
    try { qc.setQueryData(KEY, await post<AccountEmail>("/api/account/email/resend")); toast("We sent a new link"); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const data = q.data;
  return (
    <section className="field" aria-labelledby="sec-e">
      <div className="lbl" id="sec-e">Email address</div>
      {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
      {data && !editing ? (
        <>
          <p className="fine">{data.address ? <><b>{data.address}</b> · {data.confirmed ? "confirmed" : "not confirmed yet"}</> : "No address yet."} We email it only about your account, such as password resets, and with your digest of what's new, which you can turn off under Notifications and New. No newsletters or marketing.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button onClick={() => { setValue(data.address ?? ""); setEditing(true); setError(""); }}>{data.address ? "Change address" : "Add an address"}</Button>
            {data.address && !data.confirmed ? <Button disabled={busy} onClick={() => void resend()}>Send the link again</Button> : null}
          </div>
          {data.address && !data.confirmed && platform.connection ? (
            <form onSubmit={confirmFromLink} style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <Field label="Confirm with the link from the email" htmlFor="sec-link" hint="Copy the link in the email and paste it here.">
                <TextInput id="sec-link" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" inputMode="url" />
              </Field>
              <div><Button type="submit" disabled={busy || !link.trim()}>Confirm</Button></div>
            </form>
          ) : null}
        </>
      ) : null}
      {editing ? (
        <form onSubmit={save} style={{ display: "grid", gap: 10 }}>
          <Field label="New email address" htmlFor="sec-email" hint="We'll send a link to confirm it. Until then, password-reset links go nowhere.">
            <TextInput id="sec-email" type="email" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="email" spellCheck={false} autoCapitalize="none" autoFocus maxLength={254} />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" type="submit" disabled={busy || !value.trim()}>Save</Button>
            <Button onClick={() => { setEditing(false); setError(""); }}>Cancel</Button>
          </div>
        </form>
      ) : null}
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
    </section>
  );
}
