import { Suspense, lazy } from "react";
import type { ReactNode } from "react";

/** Feature pages load when first visited, so the everyday PURSS stays small. */
function Loading() {
  return <div className="col narrow"><p className="state" role="status" style={{ padding: "40px 0" }}><span className="spin" aria-hidden="true" />Loading…</p></div>;
}
const wrap = (node: ReactNode) => <Suspense fallback={<Loading />}>{node}</Suspense>;

const Data = lazy(() => import("./data/DataPage.tsx").then((m) => ({ default: m.DataPage })));
const Sharing = lazy(() => import("./sharing/SharingPage.tsx").then((m) => ({ default: m.SharingPage })));
const Review = lazy(() => import("./review/ReviewPage.tsx").then((m) => ({ default: m.ReviewPage })));
const Discover = lazy(() => import("./discover/DiscoverPage.tsx").then((m) => ({ default: m.DiscoverPage })));
const Admin = lazy(() => import("./admin/AdminPage.tsx").then((m) => ({ default: m.AdminPage })));
const Share = lazy(() => import("./sharing/ShareDialog.tsx").then((m) => ({ default: m.ShareDialog })));
const OpmlFile = lazy(() => import("./data/OpmlDialog.tsx").then((m) => ({ default: m.OpenedOpmlFile })));

export const DataPageRoute = () => wrap(<Data />);
export const SharingPageRoute = () => wrap(<Sharing />);
export const ReviewPageRoute = () => wrap(<Review />);
export const DiscoverPageRoute = () => wrap(<Discover />);
export const AdminPageRoute = () => wrap(<Admin />);
/** The Share popup of a basket or collection, opened from its page or from Sharing. */
export const ShareRoute = (p: { kind: "basket" | "collection"; id: string; name: string; onClose: () => void }) => <Suspense fallback={null}><Share {...p} /></Suspense>;
/** An OPML file opened with the desktop app (plan/42). */
export const OpmlFileRoute = (p: { name: string; text: string; onClose: () => void }) => <Suspense fallback={null}><OpmlFile {...p} /></Suspense>;
