import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectClientKind, DeviceDTO } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Icon } from "@purss/ui";
import { del, get, messageOf } from "../../api/client.ts";
import { shortDate, timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { AppsAndExtensions } from "./AppsAndExtensions.tsx";
import { Bookmarklets } from "./Bookmarklets.tsx";
import { FollowButton } from "./FollowButton.tsx";

const t = app.connect.connectedApps;

const devicesKey = ["connected-apps"] as const;
export const KIND_LABEL: Record<ConnectClientKind, string> = { mobile: t.mobile, extension: app.words.browserExtension };

/**
 * Settings → Connected apps: where to get the apps and extensions, the ones connected to this account
 * (and disconnecting them), and the bookmarklets. `onOpen` switches to another Settings tab.
 */
export function ConnectedApps({ onOpen }: { onOpen: (tab: "general" | "assistants") => void }) {
  const qc = useQueryClient();
  const { toast } = useToasts();
  const tz = useWorkspace().prefs.timezone;
  const q = useQuery({ queryKey: devicesKey, queryFn: () => get<DeviceDTO[]>("/api/connect/devices"), staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function disconnect(d: DeviceDTO) {
    if (!window.confirm(t.confirmDisconnect(d.name))) return;
    setBusy(true); setError("");
    try {
      await del(`/api/connect/devices/${encodeURIComponent(d.id)}`);
      await qc.invalidateQueries({ queryKey: devicesKey });
      toast(t.disconnected(d.name));
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <>
      <AppsAndExtensions onOpen={onOpen} />
      <p className="hint">{t.hint}</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <section className="field" aria-labelledby="ca-l">
        <div className="lbl" id="ca-l">{app.words.connected}</div>
        {q.isPending ? <p className="state"><span className="spin" aria-hidden="true" />{app.words.loading}</p>
          : q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : (
            <ul className="seclist">
              {q.data.map((d) => (
                <li key={d.id}>
                  <Icon name={d.kind === "extension" ? "ext" : "link"} />
                  <span className="tx">
                    <b>{d.name}</b>
                    <small>{t.summary(KIND_LABEL[d.kind], shortDate(d.createdAt, Date.now(), tz), timeAgo(d.lastUsedAt) || app.words.justNow)}</small>
                  </span>
                  <Button disabled={busy} onClick={() => void disconnect(d)} aria-label={`Disconnect ${d.name}`}>{app.words.disconnect}</Button>
                </li>
              ))}
              {!q.data.length ? <li><span className="tx"><small>{t.nothing}</small></span></li> : null}
            </ul>
          )}
      </section>
      <Bookmarklets />
      <FollowButton />
    </>
  );
}
