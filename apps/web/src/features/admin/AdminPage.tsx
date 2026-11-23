import { useState } from "react";
import { app } from "@purss/translations/app";
import { Icon, Segmented } from "@purss/ui";
import { useSession } from "../../api/hooks.ts";
import { AdminAccountsPanel, AdminInvitesPanel } from "./AdminAccounts.tsx";
import { AdminAuditPanel } from "./AdminAudit.tsx";
import { AdminHealthPanel } from "./AdminHealth.tsx";
import { AdminJobsPanel } from "./AdminJobs.tsx";
import { AdminUsagePanel } from "./AdminUsage.tsx";
import { AdminAssistantPanel } from "./AdminAssistant.tsx";
import { AdminAiPanel } from "./AdminAi.tsx";
import { AdminReportsPanel } from "./AdminReports.tsx";
import { AdminNewsPanel } from "./AdminNews.tsx";

const copy = app.admin.adminPage;

type Tab = "health" | "jobs" | "audit" | "usage" | "accounts" | "invites" | "assistants" | "ai" | "reports" | "news";

/** The administrator area: how this installation is running. It never shows anyone's items or reading, only public pages someone reported and counts of who read the news. */
export function AdminPage() {
  const session = useSession().data;
  const hosted = session?.installation.mode === "hosted";
  const [tab, setTab] = useState<Tab>("health");
  const tabs: { value: Tab; label: string }[] = [
    { value: "health", label: copy.tabs.health }, { value: "jobs", label: copy.tabs.jobs }, { value: "audit", label: copy.tabs.audit }, { value: "usage", label: copy.tabs.usage },
    { value: "accounts", label: app.words.accounts }, { value: "invites", label: copy.tabs.invites }, { value: "assistants", label: app.words.assistants }, { value: "ai", label: app.words.smartFilters }, { value: "reports", label: copy.tabs.reports }, { value: "news", label: copy.tabs.news },
  ];
  if (!session?.account?.isAdmin) {
    return <div className="col narrow"><div className="empty card-like" style={{ marginTop: 40 }}><h2>{copy.adminsOnlyTitle}</h2><p>{copy.adminsOnlyText}</p></div></div>;
  }
  return (
    <div className="col narrow fx-admin">
      <div className="fx-admin-head" role="note">
        <Icon name="lock" />
        <div><h1>{app.words.administration}</h1><p>{copy.lead}</p></div>
      </div>
      <div className="fx-tabs"><Segmented<Tab> label="Administration section" value={tab} onChange={setTab} buttonStyle={{ height: 30, padding: "0 14px" }} options={tabs} /></div>
      <div className="fx-admin-body" role="region" aria-label={tabs.find((t) => t.value === tab)?.label}>
        {tab === "health" ? <AdminHealthPanel /> : tab === "jobs" ? <AdminJobsPanel /> : tab === "audit" ? <AdminAuditPanel /> : tab === "usage" ? <AdminUsagePanel /> : tab === "accounts" ? <AdminAccountsPanel hosted={hosted} /> : tab === "assistants" ? <AdminAssistantPanel /> : tab === "ai" ? <AdminAiPanel /> : tab === "reports" ? <AdminReportsPanel /> : tab === "news" ? <AdminNewsPanel /> : <AdminInvitesPanel hosted={hosted} openSignup={session?.installation.signup === "open"} mail={!!session?.installation.mail} />}
      </div>
    </div>
  );
}
