import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Dialog, Icon, TextInput } from "@purss/ui";
import { ApiError, messageOf, post } from "../../api/client.ts";
import { assertPasskey } from "../../auth/SignIn.tsx";
import { passkeysAvailable } from "../../auth/PasswordForm.tsx";
import { useSession } from "../../api/hooks.ts";

/** True when the server wants a fresh passkey or recovery-code confirmation before it will do this. */
export const needsStepUp = (err: unknown): boolean => err instanceof ApiError && err.code === "step_up";

export type StepUpMethod = "passkey" | "password" | "recovery";

/** The ways to confirm it's you: a passkey where the browser allows it, the password if one is set, or a recovery code. */
export function StepUpOptions({ busy, confirm }: { busy: boolean; confirm: (run: () => Promise<unknown>, method: StepUpMethod) => void }) {
  const account = useSession().data?.account;
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const passkey = passkeysAvailable() && !!account?.hasPasskey;
  return (
    <>
      {passkey ? <div style={{ display: "grid", gap: 4 }}><Button id="su-first" variant="primary" disabled={busy} onClick={() => confirm(() => assertPasskey("/api/auth/step-up/passkey"), "passkey")}><Icon name="key" />Confirm with fingerprint, face or screen lock</Button></div> : null}
      {account?.hasPassword ? (
        <form onSubmit={(e) => { e.preventDefault(); confirm(() => post("/api/auth/step-up/password", { password: secret }).finally(() => setSecret("")), "password"); }} style={{ display: "grid", gap: 8 }}>
          <label className="lbl" htmlFor="su-pw" style={{ fontWeight: 800, fontSize: 13 }}>{passkey ? "Or use your password" : "Your password"}</label>
          <TextInput id="su-pw" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" />
          <div><Button type="submit" variant={passkey ? undefined : "primary"} disabled={busy || !secret}>Confirm with password</Button></div>
        </form>
      ) : null}
      <form onSubmit={(e) => { e.preventDefault(); confirm(() => post("/api/auth/step-up/recovery", { code: code.trim() }), "recovery"); }} style={{ display: "grid", gap: 8 }}>
        <label className="lbl" htmlFor="su-code" style={{ fontWeight: 800, fontSize: 13 }}>{passkey || account?.hasPassword ? "Or use a recovery code" : "A recovery code"}</label>
        <TextInput id="su-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
        {account?.needsSetup && account.recoveryCodesLeft > 0 ? <p className="fine">This uses one of your recovery codes; you'll have {Math.max(0, account.recoveryCodesLeft - 1)} left. You can make new codes afterwards.</p> : null}
        <div><Button type="submit" disabled={busy || code.trim().length < 8}>Confirm with this code</Button></div>
      </form>
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
    <Dialog title="Confirm it's you" size="sm" onClose={onCancel} initialFocus="#su-first, #su-pw, #su-code"
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
