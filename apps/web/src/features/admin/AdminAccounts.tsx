import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PLAN_LABELS, PLAN_LIMITS, PLAN_NAMES, planHasSmartFilters } from "@purss/domain";
import type { AdminAccountDTO, Capacity, Plan } from "@purss/domain";
import { Button, Dialog, Field, Icon, SelectInput, TextInput } from "@purss/ui";
import { del, get, messageOf, patch, post } from "../../api/client.ts";
import { useSession } from "../../api/hooks.ts";
import { bytesLabel, formatCount, shortDate } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { adminAccountsQuery, fkeys } from "../shared/api.ts";
import { CopyButton, Loading, LoadFailed, Note } from "../shared/bits.tsx";
import { useStepUp } from "../shared/step-up.tsx";
import { inviteLink, parseAllocation, shortId, splitAllocation } from "./admin-model.ts";
import type { Unit } from "./admin-model.ts";

function AllocationDialog({ account, onClose }: { account: AdminAccountDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const start = splitAllocation(account.allocationBytes);
  const [text, setText] = useState(start.text);
  const [unit, setUnit] = useState<Unit>(start.unit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = parseAllocation(text, unit);
  const changed = text !== start.text || unit !== start.unit;

  async function save() {
    if (parsed === undefined) return;
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => patch<AdminAccountDTO>(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { allocationBytes: parsed }));
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast("Allocation saved"); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title="Change allocation" size="sm" onClose={onClose} initialFocus="#al-n"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || parsed === undefined || !changed} onClick={() => void save()}>Save</Button></>}>
        <p className="hint">For {account.displayName ?? `account ${shortId(account.id)}`}. They currently use {bytesLabel(account.usedBytes)}.</p>
        <Field label="Storage allocation" htmlFor="al-n" hint="Leave blank for no limit. Lowering it below what is used keeps their data and pauses new items; it never deletes anything.">
          <div className="fx-inline">
            <TextInput id="al-n" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 120 }} aria-invalid={parsed === undefined} />
            <SelectInput aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} style={{ width: 84 }}><option>MB</option><option>GB</option></SelectInput>
          </div>
          {parsed === undefined ? <p className="fine" role="alert" style={{ color: "var(--amber)" }}>Enter a number, for example 5 or 0.5, or leave it blank.</p> : null}
        </Field>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

const limitText = (n: number | null, what: string) => (n === null ? `unlimited ${what}` : `${formatCount(n, "en")} ${what}`);

/** "Free · 37 of 100 sources, 2 of 4 collections" */
function planLine(c: Capacity): string {
  const part = (used: number, limit: number | null, what: string) => (limit === null ? `${formatCount(used, "en")} ${what}` : `${formatCount(used, "en")} of ${formatCount(limit, "en")} ${what}`);
  return `${c.plan ? `${PLAN_LABELS[c.plan]} · ` : ""}${part(c.sources.used, c.sources.limit, "sources")}, ${part(c.collections.used, c.collections.limit, "collections")}`;
}

function PlanDialog({ account, onClose }: { account: AdminAccountDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const [plan, setPlan] = useState<Plan>(account.plan ?? "free");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const limits = PLAN_LIMITS[plan];
  const over = !account.isAdmin && ((limits.sources !== null && account.capacity.sources.used > limits.sources) || (limits.collections !== null && account.capacity.collections.used > limits.collections));

  async function save() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => patch<AdminAccountDTO>(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { plan }));
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast("Plan saved"); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title="Change plan" size="sm" onClose={onClose} initialFocus="#pl-s"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || plan === account.plan} onClick={() => void save()}>Save</Button></>}>
        <p className="hint">For {account.displayName ?? `account ${shortId(account.id)}`}. {planLine(account.capacity)}.</p>
        <Field label="Plan" htmlFor="pl-s" hint={`${PLAN_LABELS[plan]}: ${limitText(limits.sources, "sources")} and ${limitText(limits.collections, "collections")}${planHasSmartFilters(plan) ? ", with Smart filters" : ""}.`}>
          <SelectInput id="pl-s" value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>{PLAN_NAMES.map((n) => <option key={n} value={n}>{PLAN_LABELS[n]}</option>)}</SelectInput>
        </Field>
        {account.isAdmin ? <p className="fine">Administrators have no limits; this plan applies if they stop being one.</p> : null}
        {over ? <p className="state note"><Icon name="info" /><span>They have more than this plan allows. Nothing is removed; they can't follow sources or add collections until they are under the limits.</span></p> : null}
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

function RoleDialog({ account, onClose }: { account: AdminAccountDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const granting = !account.isAdmin;
  async function go() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => patch<AdminAccountDTO>(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { isAdmin: granting }));
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(granting ? "Now an administrator" : "Administrator role removed"); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={granting ? "Make this person an administrator?" : "Remove their administrator role?"} size="sm" onClose={onClose} initialFocus=".dlg-f .btn:last-child"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant={granting ? "primary" : "danger"} disabled={busy} onClick={() => void go()}>{granting ? "Make administrator" : "Remove role"}</Button></>}>
        <p className="hint">{account.displayName ?? `Account ${shortId(account.id)}`}</p>
        <p className="fine">{granting
          ? "Administrators can see how the installation runs, manage jobs, and add, suspend and promote accounts. They still can't see anyone's items, reading or notes."
          : "They keep their own PURSS and data. You can't remove the last administrator's role."}</p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

function StatusDialog({ account, onClose }: { account: AdminAccountDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const suspending = account.status === "active";
  async function go() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => patch<AdminAccountDTO>(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { status: suspending ? "suspended" : "active" }));
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(suspending ? "Account suspended" : "Account reactivated"); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={suspending ? "Suspend this account?" : "Reactivate this account?"} size="sm" onClose={onClose} initialFocus=".dlg-f .btn:last-child"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant={suspending ? "danger" : "primary"} disabled={busy} onClick={() => void go()}>{suspending ? "Suspend" : "Reactivate"}</Button></>}>
        <p className="hint">{account.displayName ?? `Account ${shortId(account.id)}`}</p>
        {suspending
          ? <p className="fine">They are signed out everywhere and can't sign in. Their shared pages go offline. Copies already fetched can't be taken back. Their data is kept as it is. You can't suspend the last active administrator.</p>
          : <p className="fine">They can sign in again. Their shared pages stay switched off until they share them again.</p>}
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

/** The deletion's engine step found the engine user gone after an unconfirmed attempt: an administrator confirms. */
function EngineReviewDialog({ account, onClose }: { account: AdminAccountDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post(`/api/admin/accounts/${encodeURIComponent(account.id)}/deletion/engine-removed`));
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast("Confirmed; the deletion will finish shortly"); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title="Confirm the engine user's data was removed" size="sm" onClose={onClose} initialFocus=".dlg-f .btn:last-child"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => void go()}>Confirm and finish</Button></>}>
        <p className="hint">{account.displayName ?? `Account ${shortId(account.id)}`}</p>
        <p className="fine">The engine user is gone, but we couldn't confirm its data was removed. Check that its folder under <code>data/users</code> is gone, then confirm to finish deleting the account.</p>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

export function AdminAccountsPanel({ hosted }: { hosted: boolean }) {
  const q = useQuery(adminAccountsQuery);
  const myId = useSession().data?.account?.id;
  const [dlg, setDlg] = useState<{ kind: "plan" | "alloc" | "status" | "role" | "engine"; account: AdminAccountDTO } | null>(null);
  const list = q.data ?? [];
  return (
    <div className="fx-stack">
      <p className="fine">Details only, with no content or sign-in methods. Changes ask you to confirm it's you.</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what="accounts" onRetry={() => void q.refetch()} /> : null}
      {list.length ? (
        <ul className="fx-rows">
          {list.map((a) => (
            <li key={a.id} className="fx-row wrap fx-acct">
              <div className="fx-grow">
                <b>{a.displayName ?? `Account ${shortId(a.id)}`}{a.isAdmin ? <span className="tag" style={{ marginLeft: 8 }}>Administrator</span> : null}</b>
                <span className="fine">Joined {shortDate(a.createdAt)}. {planLine(a.capacity)}. Uses {bytesLabel(a.usedBytes)}{hosted ? ` of ${a.allocationBytes === null ? "no limit" : bytesLabel(a.allocationBytes)}` : ""}.{a.smartFilterTokens ? ` Smart filters this week: ${a.smartFilterTokens.toLocaleString("en")} tokens.` : ""}</span>
              </div>
              {a.deletion ? (
                <div className="fx-end">
                  <span className="tag fx-status failed">{a.deletion.state === "pending" ? `Deleting on ${shortDate(a.deletion.dueAt)}` : "Being deleted"}</span>
                  {a.deletion.engineReview ? <Button onClick={() => setDlg({ kind: "engine", account: a })} aria-label={`Confirm the engine data of ${a.displayName ?? shortId(a.id)} was removed`}>Confirm engine removal…</Button> : null}
                </div>
              ) : <div className="fx-end">
                <span className={`tag fx-status ${a.status === "active" ? "ok" : "failed"}`}>{a.status === "active" ? "Active" : "Suspended"}</span>
                {hosted ? <Button onClick={() => setDlg({ kind: "plan", account: a })} aria-label={`Change plan for ${a.displayName ?? shortId(a.id)}`}>Plan…</Button> : null}
                {hosted ? <Button onClick={() => setDlg({ kind: "alloc", account: a })} aria-label={`Change allocation for ${a.displayName ?? shortId(a.id)}`}>Allocation…</Button> : null}
                {a.id === myId ? <span className="fine">You</span> : <>
                  <Button onClick={() => setDlg({ kind: "role", account: a })} aria-label={`${a.isAdmin ? "Remove administrator role from" : "Make administrator:"} ${a.displayName ?? shortId(a.id)}`}>{a.isAdmin ? "Remove admin…" : "Make admin…"}</Button>
                  <Button onClick={() => setDlg({ kind: "status", account: a })} aria-label={`${a.status === "active" ? "Suspend" : "Reactivate"} ${a.displayName ?? shortId(a.id)}`}>{a.status === "active" ? "Suspend…" : "Reactivate…"}</Button>
                </>}
              </div>}
            </li>
          ))}
        </ul>
      ) : null}
      {dlg?.kind === "plan" ? <PlanDialog account={dlg.account} onClose={() => setDlg(null)} /> : null}
      {dlg?.kind === "alloc" ? <AllocationDialog account={dlg.account} onClose={() => setDlg(null)} /> : null}
      {dlg?.kind === "status" ? <StatusDialog account={dlg.account} onClose={() => setDlg(null)} /> : null}
      {dlg?.kind === "role" ? <RoleDialog account={dlg.account} onClose={() => setDlg(null)} /> : null}
      {dlg?.kind === "engine" ? <EngineReviewDialog account={dlg.account} onClose={() => setDlg(null)} /> : null}
    </div>
  );
}

function InviteDialog({ onClose, hosted, mail }: { onClose: () => void; hosted: boolean; mail: boolean }) {
  const stepUp = useStepUp();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("14");
  const [alloc, setAlloc] = useState("");
  const [unit, setUnit] = useState<Unit>("GB");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState<{ code: string; expiresInDays: number; emailed: boolean | null } | null>(null);
  const parsed = parseAllocation(alloc, unit);
  const d = /^\d{1,2}$/.test(days.trim()) ? Number(days) : NaN;
  const validDays = d >= 1 && d <= 60;

  async function create() {
    if (parsed === undefined || !validDays) return;
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<{ code: string; expiresInDays: number; emailed: boolean | null }>("/api/admin/invites", { note: note.trim() || null, allocationBytes: hosted ? parsed : null, days: d, email: mail && email.trim() ? email.trim() : null }));
      if (out) { setMade(out); void qc.invalidateQueries({ queryKey: ["admin-invites"] }); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  if (made) {
    const link = inviteLink(location.origin, made.code);
    return (
      <Dialog title="Invitation created" size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        {made.emailed === true ? <p className="state"><Icon name="check" /><span>The link was emailed to {email.trim()}.</span></p> : null}
        {made.emailed === false ? <p className="state note" role="alert"><Icon name="info" /><span>The email couldn't be sent. Share the link below yourself.</span></p> : null}
        <p className="p-warn"><Icon name="alert" /><span><b>This code is shown once.</b> Copy it now and share it privately. It works for one person, for {made.expiresInDays} {made.expiresInDays === 1 ? "day" : "days"}.</span></p>
        <div className="fx-link"><span className="fx-link-l">Code</span><code className="fx-url fx-code">{made.code}</code><CopyButton value={made.code} what="Invitation code" /></div>
        <div className="fx-link"><span className="fx-link-l">Link</span><code className="fx-url">{link}</code><CopyButton value={link} what="Invitation link" /></div>
      </Dialog>
    );
  }
  return (
    <>
      <Dialog title="Create an invitation" size="md" onClose={onClose} initialFocus="#iv-note"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || parsed === undefined || !validDays} onClick={() => void create()}>Create invitation</Button></>}>
        {mail ? (
          <Field label="Email the link to (optional)" htmlFor="iv-email" hint="Sent once and not stored. Leave empty to share the link yourself.">
            <TextInput id="iv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" spellCheck={false} />
          </Field>
        ) : null}
        <Field label="Note (optional)" htmlFor="iv-note" hint="For your own reference, such as who it is for. The invited person never sees it.">
          <TextInput id="iv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Valid for" htmlFor="iv-days">
          <div className="fx-inline"><TextInput id="iv-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 84 }} aria-invalid={!validDays} /><span>days (1 to 60)</span></div>
        </Field>
        {hosted ? (
          <Field label="Storage allocation (optional)" htmlFor="iv-alloc" hint="Leave blank for no limit.">
            <div className="fx-inline">
              <TextInput id="iv-alloc" inputMode="decimal" value={alloc} onChange={(e) => setAlloc(e.target.value)} style={{ width: 120 }} aria-invalid={parsed === undefined} />
              <SelectInput aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} style={{ width: 84 }}><option>MB</option><option>GB</option></SelectInput>
            </div>
          </Field>
        ) : null}
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

type InviteRow = { id: string; note: string | null; createdAt: string; expiresAt: string; usedAt: string | null; status: "pending" | "used" | "expired" };

export function AdminInvitesPanel({ hosted, openSignup, mail }: { hosted: boolean; openSignup: boolean; mail: boolean }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const q = useQuery({ queryKey: ["admin-invites"], queryFn: ({ signal }) => get<InviteRow[]>("/api/admin/invites", undefined, signal) });
  async function revoke(id: string) {
    try {
      const out = await stepUp.run(() => del(`/api/admin/invites/${encodeURIComponent(id)}`));
      if (out) { void qc.invalidateQueries({ queryKey: ["admin-invites"] }); toast("Invitation revoked"); }
    } catch (err) { toast(messageOf(err), { tone: "error" }); }
  }
  return (
    <div className="fx-stack">
      <p>An invitation lets one person create their own account, for example someone in your household. They choose their own sign-in. You never see their sign-in or items.</p>
      <div className="fx-acts-row"><Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" size="sm" />Invite someone</Button></div>
      {q.isError ? <LoadFailed error={q.error} what="invitations" onRetry={() => void q.refetch()} /> : null}
      {q.data?.length ? (
        <ul className="fx-rows">
          {q.data.map((i) => (
            <li key={i.id} className="fx-row wrap">
              <div className="fx-grow"><b>{i.note ?? "Invitation"}</b><span className="fine">Made {shortDate(i.createdAt)}. {i.status === "pending" ? `Expires ${shortDate(i.expiresAt)}.` : i.status === "used" ? `Used ${shortDate(i.usedAt!)}.` : "Expired."}</span></div>
              <div className="fx-end">
                <span className={`tag fx-status ${i.status === "used" ? "ok" : i.status === "pending" ? "" : "failed"}`}>{i.status === "pending" ? "Waiting" : i.status === "used" ? "Used" : "Expired"}</span>
                {i.status === "pending" ? <Button onClick={() => void revoke(i.id)}>Revoke</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <Note icon="lock">{openSignup ? "Anyone can also create an account on this installation (open sign-up is on)." : hosted ? "Sign-up is by invitation only." : "This is a self-hosted installation: there is no public sign-up, only invitations."}</Note>
      {open ? <InviteDialog hosted={hosted} mail={mail} onClose={() => setOpen(false)} /> : null}
      {stepUp.dialog}
    </div>
  );
}
