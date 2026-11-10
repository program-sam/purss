import { useEffect } from "react";
import { Button, Dialog } from "@purss/ui";
import { platform } from "../platform/index.ts";
import { useOverlays } from "../state/overlays.tsx";
import { useToasts } from "../state/toasts.tsx";
import { linkFromShare } from "./link.ts";

/**
 * Renders nothing. In the apps, a link shared from another app (Android's share sheet, the iOS share
 * extension) opens the choice below. Nothing is kept or looked up until the person chooses. In the desktop
 * app (plan/42), a feed link opens Add source with it filled in, and an OPML file the choice of its feeds.
 */
export function ShareIntake() {
  const overlays = useOverlays();
  const { toast } = useToasts();
  useEffect(() => platform.onShare((shared) => {
    const link = linkFromShare(shared);
    if (!link) { toast("That share has no link, so there's nothing to keep."); return; }
    overlays.open({ kind: "shared", url: link.url, title: link.title });
  }), [overlays, toast]);
  useEffect(() => platform.onIntake((intake) => {
    overlays.open(intake.kind === "source" ? { kind: "add-source", url: intake.url } : { kind: "opml-file", name: intake.name, text: intake.text });
  }), [overlays]);
  return null;
}

/** What to do with a shared link: keep it in a basket, or follow the site it comes from. */
export function SharedDialog({ url, title }: { url: string; title: string }) {
  const overlays = useOverlays();
  return (
    <Dialog title="A shared link" onClose={overlays.close} initialFocus="dialog"
      footer={<>
        <Button onClick={overlays.close}>Cancel</Button>
        <Button onClick={() => overlays.open({ kind: "add-source", url })}>Add as source</Button>
        <Button variant="primary" onClick={() => overlays.open({ kind: "keep-page", url, title })}>Keep link</Button>
      </>}>
      <div style={{ display: "grid", gap: 10 }}>
        {title ? <p><b>{title}</b></p> : null}
        <p className="fine" style={{ wordBreak: "break-all" }}>{url}</p>
        <p className="hint">Keep this page in a basket, or follow its site or feed. A page you already have isn't kept twice.</p>
      </div>
    </Dialog>
  );
}
