import type { Outbox } from "./outbox.ts";

export type SignOutChoice = "send" | "discard" | "stay";
/** `failed`: the person already chose to send them first, and it didn't work. */
export type Asker = (info: { count: number; failed: boolean }) => Promise<SignOutChoice>;

/**
 * Signing out with changes that have not been sent asks what to do with them: send them first, discard them, or
 * stay signed in. Sending first that doesn't work (no connection) asks again, saying so, so nothing is lost by
 * accident. Without waiting changes, signing out goes straight ahead.
 */
export async function signOutGate(box: Pick<Outbox, "pendingCount" | "sendNow" | "discard">, ask: Asker): Promise<"go" | "stay"> {
  if (box.pendingCount() === 0) return "go";
  let failed = false;
  for (;;) {
    const choice = await ask({ count: box.pendingCount(), failed });
    if (choice === "stay") return "stay";
    if (choice === "discard") { await box.discard(); return "go"; }
    await box.sendNow();
    if (box.pendingCount() === 0) return "go";
    failed = true;
  }
}
