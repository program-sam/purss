import { useCallback } from "react";
import { downloadMovesToRead } from "@purss/domain";
import type { ItemDTO } from "@purss/domain";
import { leaveThen } from "../lib/leave.ts";
import { useItemActions } from "../state/actions.ts";

/** Downloading a podcast episode by hand also clicks To read for it (see downloadMovesToRead). */
export function useDownloadMovesToRead(): (item: Pick<ItemDTO, "id" | "kind" | "workflow">) => Promise<void> {
  const actions = useItemActions();
  return useCallback(async (item) => {
    if (downloadMovesToRead(item)) await leaveThen([item.id], "toread", () => actions.setWorkflow([item.id], "toread"));
  }, [actions]);
}
