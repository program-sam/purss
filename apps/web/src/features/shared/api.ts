import { queryOptions } from "@tanstack/react-query";
import type { AdminAccountDTO, AdminHealth, AdminJob, AuditEventDTO, DiscoverResponse, ReconcileList, ShareDTO, ShareReportDTO, ShareTarget } from "@purss/domain";
import { get } from "../../api/client.ts";

/** Query keys and fetchers for the feature pages (data, sharing, review, admin). */
export const fkeys = {
  shares: ["feature", "shares"] as const,
  shareFor: (kind: ShareTarget, id: string) => ["feature", "shares", "for", kind, id] as const,
  reconcile: ["feature", "reconcile"] as const,
  reconcileBadge: ["feature", "reconcile-badge"] as const,
  adminHealth: ["feature", "admin", "health"] as const,
  adminJobs: (status: string) => ["feature", "admin", "jobs", status] as const,
  adminAudit: ["feature", "admin", "audit"] as const,
  adminAccounts: ["feature", "admin", "accounts"] as const,
  adminReports: (status: string) => ["feature", "admin", "reports", status] as const,
  suggestions: ["feature", "suggestions"] as const,
};

export const suggestionsQuery = queryOptions({ queryKey: fkeys.suggestions, queryFn: () => get<DiscoverResponse>("/api/suggestions"), staleTime: 60_000 });

export const sharesQuery = queryOptions({ queryKey: fkeys.shares, queryFn: () => get<ShareDTO[]>("/api/shares"), staleTime: 10_000 });
export const reconcileQuery = queryOptions({ queryKey: fkeys.reconcile, queryFn: () => get<ReconcileList>("/api/reconcile", { limit: 100 }), staleTime: 5_000 });
/** One entry is enough to know whether anything is waiting. */
export const reconcileBadgeQuery = queryOptions({ queryKey: fkeys.reconcileBadge, queryFn: () => get<ReconcileList>("/api/reconcile", { limit: 1 }), staleTime: 60_000, retry: false });

export const adminHealthQuery = queryOptions({ queryKey: fkeys.adminHealth, queryFn: () => get<AdminHealth>("/api/admin/health"), staleTime: 5_000 });
export type JobFilter = "all" | "failed" | "queued" | "leased";
export const adminJobsQuery = (status: JobFilter) => queryOptions({
  queryKey: fkeys.adminJobs(status),
  queryFn: () => get<AdminJob[]>("/api/admin/jobs", { status: status === "all" ? undefined : status, limit: 100 }),
  staleTime: 5_000,
});
export const adminAuditQuery = queryOptions({ queryKey: fkeys.adminAudit, queryFn: () => get<{ events: AuditEventDTO[]; nextBefore: string | null }>("/api/admin/audit", { limit: 100 }), staleTime: 5_000 });
/** A basket's or collection's sharing, and why it can't be shared when it can't. */
export const shareForQuery = (kind: ShareTarget, id: string) => queryOptions({
  queryKey: fkeys.shareFor(kind, id),
  queryFn: () => get<{ share: ShareDTO | null; blocked: string | null }>(`/api/shares/for/${kind}/${encodeURIComponent(id)}`),
  staleTime: 5_000,
});
export type ReportFilter = "open" | "taken_down" | "all";
export const adminReportsQuery = (status: ReportFilter) => queryOptions({
  queryKey: fkeys.adminReports(status),
  queryFn: () => get<ShareReportDTO[]>("/api/admin/reports", { status }),
  staleTime: 5_000,
});
export const adminAccountsQuery = queryOptions({ queryKey: fkeys.adminAccounts, queryFn: () => get<AdminAccountDTO[]>("/api/admin/accounts"), staleTime: 5_000 });
