import { app } from "@purss/translations/app";
import { Icon } from "@purss/ui";
import { usePurss } from "../state/purss.tsx";

const t = app.components.engineNotice;

/** A calm banner when the collection engine is starting or unavailable. Everything already here stays usable. */
export function EngineNotice() {
  const { data } = usePurss();
  const e = data.engine;
  if (e.status === "ok") return null;
  const text = e.status === "starting"
    ? t.starting
    : e.message ?? t.delayed;
  return (
    <p className="notice" role="status"><Icon name={e.status === "starting" ? "clock" : "info"} /><span>{text}</span></p>
  );
}
