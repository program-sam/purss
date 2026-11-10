import { queryOptions } from "@tanstack/react-query";
import type { ComingUp, ItemReminderDTO } from "@purss/domain";
import { get } from "./client.ts";

/** "Remind me" on kept items (plan/34): what is coming up for Home, and the reminder on one item. */
export const reminderKeys = {
  comingUp: ["coming-up"] as const,
  item: (id: string) => ["item-reminder", id] as const,
};

export const comingUpQuery = queryOptions({
  queryKey: reminderKeys.comingUp,
  queryFn: ({ signal }) => get<ComingUp>("/api/item-reminders", undefined, signal),
  staleTime: 60_000,
});

export const itemReminderQuery = (id: string) => queryOptions({
  queryKey: reminderKeys.item(id),
  queryFn: async ({ signal }) => (await get<{ reminder: ItemReminderDTO | null }>(`/api/items/${encodeURIComponent(id)}/reminder`, undefined, signal)).reminder,
  staleTime: 60_000,
});
