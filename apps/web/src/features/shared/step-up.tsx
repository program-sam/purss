import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Dialog, Icon, TextInput } from "@purss/ui";
import { ApiError, messageOf, post } from "../../api/client.ts";
import { assertPasskey } from "../../auth/SignIn.tsx";
import { passkeysAvailable } from "../../auth/PasswordForm.tsx";
import { useSession } from "../../api/hooks.ts";

/** True when the server wants a fresh passkey or password confirmation before it will do this. */
export const needsStepUp = (err: unknown): boolean => err instanceof ApiError && err.code === "step_up";

/** The ways to confirm it's you: your password, or a passkey where the browser allows it. */
export function StepUpOptions({ busy, confirm }: { busy: boolean; confirm: (run: () => Promise<unknown>) => void }) {
  const account = useSession().data?.account;
  const [secret, setSecret] = useState("");
  const passkey = passkeysAvailable() && !!account?.hasPasskey;
  return (
    <>
      {account?.hasPassword ? (
        <form onSubmit={(e) => { e.preventDefault(); confirm(() => post("/api/auth/step-up/password", { password: secret }).finally(() => setSecret(""))); }} style={{ display: "grid", gap: 8 }}>
          <label className="lbl" htmlFor="su-pw" style={{ fontWeight: 800, fontSize: 13 }}>Your password</label>
          <TextInput id="su-pw" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" />
          <div><Button type="submit" variant="primary" disabled={busy || !secret}>Confirm with password</Button></div>
        </form>
      ) : null}
      {passkey ? <div style={{ display: "grid", gap: 4 }}><Button id="su-first" disabled={busy} onClick={() => confirm(() => assertPasskey("/api/auth/step-up/passkey"))}><Icon name="key" />Confirm with fingerprint, face or screen lock</Button></div> : null}
    </>
  );
}

/** The app's own step-up popup. */
export function StepUpDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm(run: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await run(); onDone(); } catch (err) { setError(messageOf(err)); setBusy(false); }
  }
  return (
    <Dialog title="Confirm it's you" size="sm" onClose={onCancel} initialFocus="#su-pw, #su-first"
      footer={<Button onClick={onCancel}>Cancel</Button>}>
      <p className="hint">For your safety, confirm it's you before this change. Nothing has been changed yet.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <StepUpOptions busy={busy} confirm={(run) => void confirm(run)} />
    </Dialog>
  );
}

/**
 * Run an action that may need a recent sign-in. When the server answers "step_up" the confirmation popup opens;
 * once confirmed the action runs again. Resolves to `undefined` if the person cancels (nothing was changed).
 * Render `dialog` somewhere in the page.
 */
export function useStepUp(): { run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const waiter = useRef<{ done: () => void; cancel: () => void } | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (err) {
      if (!needsStepUp(err)) throw err;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      waiter.current = { done: () => resolve(true), cancel: () => resolve(false) };
      setOpen(true);
    });
    if (!confirmed) return undefined;
    return fn();
  }, []);
  const finish = (ok: boolean) => { setOpen(false); const w = waiter.current; waiter.current = null; if (ok) w?.done(); else w?.cancel(); };
  const dialog = open ? <StepUpDialog onDone={() => finish(true)} onCancel={() => finish(false)} /> : null;
  return { run, dialog };
}
