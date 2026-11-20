import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PLAN_LABELS, PLAN_LIMITS, PLAN_NAMES, planHasSmartFilters } from "@purss/domain";
import type { AdminAccountDTO, Capacity, Plan } from "@purss/domain";
import { app } from "@purss/copy/app";
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

const t = app.admin.adminAccounts;

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
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(t.allocation.saved); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={t.allocation.title} size="sm" onClose={onClose} initialFocus="#al-n"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant="primary" disabled={busy || parsed === undefined || !changed} onClick={() => void save()}>{t.save}</Button></>}>
        <p className="hint">{t.allocation.hint(account.displayName ?? account.email ?? t.accountOfLower(shortId(account.id)), bytesLabel(account.usedBytes))}</p>
        <Field label={t.allocation.label} htmlFor="al-n" hint={t.allocation.fieldHint}>
          <div className="fx-inline">
            <TextInput id="al-n" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 120 }} aria-invalid={parsed === undefined} />
            <SelectInput aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)} style={{ width: 84 }}><option>MB</option><option>GB</option></SelectInput>
          </div>
          {parsed === undefined ? <p className="fine" role="alert" style={{ color: "var(--amber)" }}>{t.allocation.invalid}</p> : null}
        </Field>
        {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}

const limitText = (n: number | null, what: string) => (n === null ? t.plan.unlimited(what) : t.plan.counted(formatCount(n, "en"), what));

/** "Free · 37 of 100 sources, 2 of 5 collections" */
function planLine(c: Capacity): string {
  const part = (used: number, limit: number | null, what: string) => (limit === null ? t.plan.counted(formatCount(used, "en"), what) : t.plan.countedOf(formatCount(used, "en"), formatCount(limit, "en"), what));
  return `${c.plan ? `${PLAN_LABELS[c.plan]} · ` : ""}${part(c.sources.used, c.sources.limit, t.plan.sources)}, ${part(c.collections.used, c.collections.limit, t.plan.collections)}`;
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
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(t.plan.saved); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={t.plan.title} size="sm" onClose={onClose} initialFocus="#pl-s"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant="primary" disabled={busy || plan === account.plan} onClick={() => void save()}>{t.save}</Button></>}>
        <p className="hint">{t.plan.hint(account.displayName ?? account.email ?? t.accountOfLower(shortId(account.id)), planLine(account.capacity))}</p>
        <Field label={t.plan.label} htmlFor="pl-s" hint={t.plan.fieldHint(PLAN_LABELS[plan], limitText(limits.sources, t.plan.sources), limitText(limits.collections, t.plan.collections), planHasSmartFilters(plan))}>
          <SelectInput id="pl-s" value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>{PLAN_NAMES.map((n) => <option key={n} value={n}>{PLAN_LABELS[n]}</option>)}</SelectInput>
        </Field>
        {account.isAdmin ? <p className="fine">{t.plan.adminsNoLimits}</p> : null}
        {over ? <p className="state note"><Icon name="info" /><span>{t.plan.over}</span></p> : null}
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
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(granting ? t.role.made : t.role.removed); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={granting ? t.role.makeTitle : t.role.removeTitle} size="sm" onClose={onClose} initialFocus=".dlg-f .btn:last-child"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant={granting ? "primary" : "danger"} disabled={busy} onClick={() => void go()}>{granting ? t.role.makeButton : t.role.removeButton}</Button></>}>
        <p className="hint">{account.displayName ?? account.email ?? t.accountOf(shortId(account.id))}</p>
        <p className="fine">{granting
          ? t.role.makeNote
          : t.role.removeNote}</p>
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
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(suspending ? t.status.suspended : t.status.reactivated); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={suspending ? t.status.suspendTitle : t.status.reactivateTitle} size="sm" onClose={onClose} initialFocus=".dlg-f .btn:last-child"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant={suspending ? "danger" : "primary"} disabled={busy} onClick={() => void go()}>{suspending ? t.status.suspendButton : t.status.reactivateButton}</Button></>}>
        <p className="hint">{account.displayName ?? account.email ?? t.accountOf(shortId(account.id))}</p>
        {suspending
          ? <p className="fine">{t.status.suspendNote}</p>
          : <p className="fine">{t.status.reactivateNote}</p>}
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
      if (out) { void qc.invalidateQueries({ queryKey: fkeys.adminAccounts }); onClose(); toast(t.engineReview.confirmed); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }
  return (
    <>
      <Dialog title={t.engineReview.title} size="sm" onClose={onClose} initialFocus=".dlg-f .btn:last-child"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant="danger" disabled={busy} onClick={() => void go()}>{t.engineReview.button}</Button></>}>
        <p className="hint">{account.displayName ?? account.email ?? t.accountOf(shortId(account.id))}</p>
        <p className="fine">{t.engineReview.noteBefore}<code>data/users</code>{t.engineReview.noteAfter}</p>
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
      <p className="fine">{t.panel.hint}</p>
      {q.isPending ? <Loading /> : null}
      {q.isError ? <LoadFailed error={q.error} what={t.panel.accountsName} onRetry={() => void q.refetch()} /> : null}
      {list.length ? (
        <ul className="fx-rows">
          {list.map((a) => (
            <li key={a.id} className="fx-row wrap fx-acct">
              <div className="fx-grow">
                <b>{a.displayName ?? a.email ?? t.accountOf(shortId(a.id))}{a.isAdmin ? <span className="tag" style={{ marginLeft: 8 }}>{t.panel.administrator}</span> : null}</b>
                <span className="fine">{t.panel.detail(a.displayName && a.email ? a.email : null, shortDate(a.createdAt), planLine(a.capacity), bytesLabel(a.usedBytes), hosted ? (a.allocationBytes === null ? t.panel.noLimit : bytesLabel(a.allocationBytes)) : null, a.smartFilterTokens ? a.smartFilterTokens.toLocaleString("en") : null)}</span>
              </div>
              {a.deletion ? (
                <div className="fx-end">
                  <span className="tag fx-status failed">{a.deletion.state === "pending" ? t.panel.deletingOn(shortDate(a.deletion.dueAt)) : t.panel.beingDeleted}</span>
                  {a.deletion.engineReview ? <Button onClick={() => setDlg({ kind: "engine", account: a })} aria-label={`Confirm the engine data of ${a.displayName ?? a.email ?? shortId(a.id)} was removed`}>{t.panel.confirmEngineRemoval}</Button> : null}
                </div>
              ) : <div className="fx-end">
                <span className={`tag fx-status ${a.status === "active" ? "ok" : "failed"}`}>{a.status === "active" ? t.panel.active : t.panel.suspended}</span>
                {hosted ? <Button onClick={() => setDlg({ kind: "plan", account: a })} aria-label={`Change plan for ${a.displayName ?? a.email ?? shortId(a.id)}`}>{t.panel.plan}</Button> : null}
                {hosted ? <Button onClick={() => setDlg({ kind: "alloc", account: a })} aria-label={`Change allocation for ${a.displayName ?? a.email ?? shortId(a.id)}`}>{t.panel.allocation}</Button> : null}
                {a.id === myId ? <span className="fine">{t.panel.you}</span> : <>
                  <Button onClick={() => setDlg({ kind: "role", account: a })} aria-label={`${a.isAdmin ? "Remove administrator role from" : "Make administrator:"} ${a.displayName ?? a.email ?? shortId(a.id)}`}>{a.isAdmin ? t.panel.removeAdmin : t.panel.makeAdmin}</Button>
                  <Button onClick={() => setDlg({ kind: "status", account: a })} aria-label={`${a.status === "active" ? "Suspend" : "Reactivate"} ${a.displayName ?? a.email ?? shortId(a.id)}`}>{a.status === "active" ? t.panel.suspend : t.panel.reactivate}</Button>
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
  // `code` is null where the server emailed it: then only that address ever gets it.
  const [made, setMade] = useState<{ code: string | null; expiresInDays: number } | null>(null);
  const address = email.trim();
  const parsed = parseAllocation(alloc, unit);
  const d = /^\d{1,2}$/.test(days.trim()) ? Number(days) : NaN;
  const validDays = d >= 1 && d <= 60;

  async function create() {
    if (parsed === undefined || !validDays || !address) return;
    setBusy(true); setError("");
    try {
      const out = await stepUp.run(() => post<{ code: string | null; expiresInDays: number }>("/api/admin/invites", { note: note.trim() || null, allocationBytes: hosted ? parsed : null, days: d, email: address }));
      if (out) { setMade(out); void qc.invalidateQueries({ queryKey: ["admin-invites"] }); }
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  const lasts = made ? t.invite.lasts(made.expiresInDays) : "";
  if (made && made.code === null) {
    return (
      <Dialog title={t.invite.sentTitle} size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t.invite.done}</Button>}>
        <p className="state"><Icon name="check" /><span>{t.invite.sentText(address, lasts)}</span></p>
      </Dialog>
    );
  }
  if (made && made.code !== null) {
    const link = inviteLink(location.origin, made.code, address);
    return (
      <Dialog title={t.invite.createdTitle} size="md" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t.invite.done}</Button>}>
        <p className="p-warn"><Icon name="alert" /><span><b>{t.invite.shownOnce}</b>{t.invite.shareIt(lasts, address)}</span></p>
        <div className="fx-link"><span className="fx-link-l">{t.invite.code}</span><code className="fx-url fx-code">{made.code}</code><CopyButton value={made.code} what={t.invite.codeWhat} /></div>
        <div className="fx-link"><span className="fx-link-l">{t.invite.link}</span><code className="fx-url">{link}</code><CopyButton value={link} what={t.invite.linkWhat} /></div>
      </Dialog>
    );
  }
  return (
    <>
      <Dialog title={t.invite.title} size="md" onClose={onClose} initialFocus="#iv-email"
        footer={<><Button onClick={onClose}>{t.cancel}</Button><Button variant="primary" disabled={busy || parsed === undefined || !validDays || !address} onClick={() => void create()}>{t.invite.createButton}</Button></>}>
        <Field label={t.invite.emailLabel} htmlFor="iv-email" hint={mail ? t.invite.emailHintMail : t.invite.emailHintLink}>
          <TextInput id="iv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" spellCheck={false} autoCapitalize="none" />
        </Field>
        <Field label={t.invite.noteLabel} htmlFor="iv-note" hint={t.invite.noteHint}>
          <TextInput id="iv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} autoComplete="off" />
        </Field>
        <Field label={t.invite.validFor} htmlFor="iv-days">
          <div className="fx-inline"><TextInput id="iv-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 84 }} aria-invalid={!validDays} /><span>{t.invite.daysRange}</span></div>
        </Field>
        {hosted ? (
          <Field label={t.invite.allocationLabel} htmlFor="iv-alloc" hint={t.invite.allocationHint}>
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

type InviteRow = { id: string; email: string | null; note: string | null; createdAt: string; expiresAt: string; usedAt: string | null; status: "pending" | "used" | "expired" };

export function AdminInvitesPanel({ hosted, openSignup, mail }: { hosted: boolean; openSignup: boolean; mail: boolean }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToasts();
  const stepUp = useStepUp();
  const q = useQuery({ queryKey: ["admin-invites"], queryFn: ({ signal }) => get<InviteRow[]>("/api/admin/invites", undefined, signal) });
  async function revoke(id: string) {
    try {
      const out = await stepUp.run(() => del(`/api/admin/invites/${encodeURIComponent(id)}`));
      if (out) { void qc.invalidateQueries({ queryKey: ["admin-invites"] }); toast(t.invites.revoked); }
    } catch (err) { toast(messageOf(err), { tone: "error" }); }
  }
  return (
    <div className="fx-stack">
      <p>{t.invites.intro}</p>
      <div className="fx-acts-row"><Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" size="sm" />{t.invites.inviteSomeone}</Button></div>
      {q.isError ? <LoadFailed error={q.error} what={t.invites.invitationsName} onRetry={() => void q.refetch()} /> : null}
      {q.data?.length ? (
        <ul className="fx-rows">
          {q.data.map((i) => (
            <li key={i.id} className="fx-row wrap">
              <div className="fx-grow"><b>{i.email ?? i.note ?? t.invites.invitation}</b><span className="fine">{t.invites.detail(i.email && i.note ? i.note : null, shortDate(i.createdAt), i.status === "pending" ? t.invites.expires(shortDate(i.expiresAt)) : i.status === "used" ? t.invites.used(shortDate(i.usedAt!)) : t.invites.expired)}</span></div>
              <div className="fx-end">
                <span className={`tag fx-status ${i.status === "used" ? "ok" : i.status === "pending" ? "" : "failed"}`}>{i.status === "pending" ? t.invites.waiting : i.status === "used" ? t.invites.usedTag : t.invites.expiredTag}</span>
                {i.status === "pending" ? <Button onClick={() => void revoke(i.id)}>{t.invites.revoke}</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <Note icon="lock">{openSignup ? t.invites.openSignup : hosted ? t.invites.invitationOnly : t.invites.selfHosted}</Note>
      {open ? <InviteDialog hosted={hosted} mail={mail} onClose={() => setOpen(false)} /> : null}
      {stepUp.dialog}
    </div>
  );
}
