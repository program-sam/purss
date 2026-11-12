import { useState } from "react";
import type { FormEvent } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountEmail } from "@purss/domain";
import { Button, Field, Icon, TextInput } from "@purss/ui";
import { get, messageOf, post, put } from "../api/client.ts";
import { sessionQuery } from "../api/queries.ts";
import { useToasts } from "../state/toasts.tsx";
import { platform } from "../platform/index.ts";
import { tokenFromLink } from "../lib/email-links.ts";

const KEY = ["account-email"] as const;
/** The account's address, whether it is confirmed and any new address waiting for its link (Settings → Security, and the choice to get digests by email). */
export const accountEmailQuery = queryOptions({ queryKey: KEY, queryFn: ({ signal }) => get<AccountEmail>("/api/account/email", undefined, signal) });

/**
 * Settings → Security: the address the account signs in with. Where the server sends email it shows whether the address is confirmed,
 * and a new address takes over only once its link is used (the current one stays until then); elsewhere a change applies at once.
 * Changing it needs a recent sign-in, through the tab's step-up.
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
        void qc.invalidateQueries({ queryKey: sessionQuery.queryKey });
        setEditing(false);
        toast(out.pending ? "We sent a link to confirm it" : "Email address saved");
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
      await Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: sessionQuery.queryKey })]);
      toast("Email address confirmed");
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError("");
    try { qc.setQueryData(KEY, await post<AccountEmail>("/api/account/email/resend")); toast("We sent a new link"); } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const data = q.data;
  const waiting = data?.available ? data.pending ?? (data.address && !data.confirmed ? data.address : null) : null;
  return (
    <section className="field" aria-labelledby="sec-e">
      <div className="lbl" id="sec-e">Email address</div>
      {q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : null}
      {data && !editing ? (
        <>
          <p className="fine">
            {data.address ? <><b>{data.address}</b>{data.available ? ` · ${data.confirmed ? "confirmed" : "not confirmed yet"}` : ""}</> : "No address yet."} You sign in with it.{" "}
            {data.available
              ? "We email it only about your account, such as password resets, and with your digest of what's new, which you can turn off under Notifications and New. No newsletters or marketing."
              : "This server doesn't send email, so nothing is sent to it."}
          </p>
          {data.pending ? <p className="state" role="status"><Icon name="info" /><span>Waiting for you to confirm {data.pending}. You still sign in with {data.address} until then.</span></p> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button onClick={() => { setValue(data.address ?? ""); setEditing(true); setError(""); }}>{data.address ? "Change address" : "Add an address"}</Button>
            {waiting ? <Button disabled={busy} onClick={() => void resend()}>Send the link again</Button> : null}
          </div>
          {waiting && platform.connection ? (
            <form onSubmit={confirmFromLink} style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <Field label="Confirm with the link from the email" htmlFor="sec-link" hint="Paste it from the email">
                <TextInput id="sec-link" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" inputMode="url" />
              </Field>
              <div><Button type="submit" disabled={busy || !link.trim()}>Confirm</Button></div>
            </form>
          ) : null}
        </>
      ) : null}
      {editing && data ? (
        <form onSubmit={save} style={{ display: "grid", gap: 10 }}>
          <Field label="New email address" htmlFor="sec-email" hint={data.available ? "We'll email a link to confirm it" : undefined}>
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
