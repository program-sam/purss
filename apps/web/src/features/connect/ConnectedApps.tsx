import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectClientKind, DeviceDTO } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { del, get, messageOf } from "../../api/client.ts";
import { shortDate, timeAgo } from "../../lib/format.ts";
import { useToasts } from "../../state/toasts.tsx";
import { useWorkspace } from "../../state/workspace.tsx";
import { AppsAndExtensions } from "./AppsAndExtensions.tsx";
import { Bookmarklets } from "./Bookmarklets.tsx";
import { FollowButton } from "./FollowButton.tsx";

const devicesKey = ["connected-apps"] as const;
export const KIND_LABEL: Record<ConnectClientKind, string> = { mobile: "App on a phone, tablet or computer", extension: "Browser extension" };

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
    if (!window.confirm(`Disconnect “${d.name}”? It stops working at once. You can connect it again from the app.`)) return;
    setBusy(true); setError("");
    try {
      await del(`/api/connect/devices/${encodeURIComponent(d.id)}`);
      await qc.invalidateQueries({ queryKey: devicesKey });
      toast(`Disconnected ${d.name}`);
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  }

  return (
    <>
      <AppsAndExtensions onOpen={onOpen} />
      <p className="hint">Your phone app and the browser extension connect here. Each can use your PURSS until you disconnect it, or after 90 days unused. The phone app can do everything, and asks you to confirm it's you before changing sign-in or security settings. The extension only keeps pages, looks them up and follows sites.</p>
      {error ? <p className="state note" role="alert"><Icon name="info" /><span>{error}</span></p> : null}
      <section className="field" aria-labelledby="ca-l">
        <div className="lbl" id="ca-l">Connected</div>
        {q.isPending ? <p className="state"><span className="spin" aria-hidden="true" />Loading…</p>
          : q.isError ? <p className="state note" role="alert"><Icon name="info" /><span>{messageOf(q.error)}</span></p> : (
            <ul className="seclist">
              {q.data.map((d) => (
                <li key={d.id}>
                  <Icon name={d.kind === "extension" ? "ext" : "link"} />
                  <span className="tx">
                    <b>{d.name}</b>
                    <small>{KIND_LABEL[d.kind]} · connected {shortDate(d.createdAt, Date.now(), tz)} · last used {timeAgo(d.lastUsedAt) || "just now"}</small>
                  </span>
                  <Button disabled={busy} onClick={() => void disconnect(d)} aria-label={`Disconnect ${d.name}`}>Disconnect</Button>
                </li>
              ))}
              {!q.data.length ? <li><span className="tx"><small>Nothing connected. To connect, open the app or extension and enter this PURSS's address.</small></span></li> : null}
            </ul>
          )}
      </section>
      <Bookmarklets />
      <FollowButton />
    </>
  );
}
