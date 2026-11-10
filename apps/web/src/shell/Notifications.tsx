import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationDTO } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { messageOf, post } from "../api/client.ts";
import { keys, notificationsQuery } from "../api/queries.ts";
import { timeAgo } from "../lib/format.ts";
import { useNav } from "../nav.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { useWorkspace } from "../state/workspace.tsx";
import { notificationPlace } from "./notification-target.ts";
import { PhoneNotificationsOffer } from "./PhoneNotifications.tsx";

/** The quiet bell's list. Real notifications only; nothing is invented to create urgency. */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const nav = useNav();
  const overlays = useOverlays();
  const { toast } = useToasts();
  const q = useQuery(notificationsQuery);
  const off = ws.prefs.notifications.frequency === "off";
  const list = q.data ?? [];
  const unread = list.filter((n) => !n.read).length;

  async function markRead(ids: string[] | "all") {
    try {
      await post("/api/notifications/read", { ids });
      void qc.invalidateQueries({ queryKey: keys.notifications });
      void qc.invalidateQueries({ queryKey: keys.bootstrap });
    } catch (err) { toast(messageOf(err), { tone: "error" }); }
  }

  function open(n: NotificationDTO) {
    if (!n.read) void markRead([n.id]);
    onClose();
    const src = n.sourceId && ws.sourceById.get(n.sourceId) ? n.sourceId : null;
    if (src && n.listFilter === "capture-failed") nav.go({ t: "s", id: src }, { capture: "failed" });
    else if (n.basketId && ws.basketById.has(n.basketId) && n.listFilter === "capture-failed") nav.go({ t: "b", id: n.basketId }, { capture: "failed" });
    else {
      const to = notificationPlace(n, (id) => ws.sourceById.has(id));
      if (to) nav.go(to.place, to.search);
    }
  }

  return (
    <div className="notif">
      <div className="notif-h">
        <strong>Notifications</strong>
        {unread ? <button type="button" className="link" onClick={() => void markRead("all")}>Mark all as read</button> : null}
      </div>
      {off ? (
        <p className="fine" style={{ padding: "8px 12px 4px" }}>Notifications are off. <button type="button" className="link" onClick={() => { onClose(); overlays.open({ kind: "settings", tab: "notifications" }); }}>Change this in Settings</button></p>
      ) : null}
      {off ? null : <PhoneNotificationsOffer />}
      {q.isPending ? <p className="fine" style={{ padding: 12 }}>Loading…</p> : null}
      {q.isError ? <p className="fine" style={{ padding: 12 }}>{messageOf(q.error)} <Button onClick={() => void q.refetch()}>Try again</Button></p> : null}
      {q.data && !list.length ? <p className="fine" style={{ padding: "10px 12px 14px" }}>Nothing yet. New items from sources with notifications on will show here.</p> : null}
      <ul className="notif-list">
        {list.map((n) => (
          <li key={n.id}>
            <button type="button" className="notif-i" onClick={() => open(n)}>
              <span className="notif-dot" aria-hidden="true">{n.read ? null : <i className="dot" />}</span>
              <span className="tx">
                <span className="t">{n.read ? null : <span className="sr">Unread. </span>}<bdi>{n.title}</bdi></span>
                {n.body ? <span className="b">{n.body}</span> : null}
                <span className="when">{timeAgo(n.createdAt, Date.now(), ws.prefs.timezone)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="notif-f">
        <button type="button" className="link" onClick={() => { onClose(); overlays.open({ kind: "settings", tab: "notifications" }); }}><Icon name="gear" size="sm" /> Notification settings</button>
      </div>
    </div>
  );
}
