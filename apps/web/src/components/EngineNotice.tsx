import { Icon } from "@purss/ui";
import { useWorkspace } from "../state/workspace.tsx";

/** A calm banner when the collection engine is starting or unavailable. Everything already here stays usable. */
export function EngineNotice() {
  const { data } = useWorkspace();
  const e = data.engine;
  if (e.status === "ok") return null;
  const text = e.status === "starting"
    ? "Getting your PURSS ready. New items will appear soon. You can already add sources and organise them."
    : e.message ?? "New items are delayed. Everything you have is still here.";
  return (
    <p className="notice" role="status"><Icon name={e.status === "starting" ? "clock" : "info"} /><span>{text}</span></p>
  );
}
