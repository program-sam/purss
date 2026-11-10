/** What a key press does inside an open popup (menu or dialog-like panel). Pure, so every case can be tested. */
export type PopKey =
  | { do: "none" }
  /** Close the popup and give focus back to the control that opened it. */
  | { do: "close" }
  /** Close the popup, give focus back to its control and let the Tab go on from there. */
  | { do: "leave" }
  /** Move focus to the control at this position; the key's own action is cancelled. */
  | { do: "focus"; index: number };

export type PopKeyInput = {
  key: string;
  shift: boolean;
  role: "menu" | "dialog";
  /** Where focus is now: on one of the popup's controls, on the popup itself, or outside it (still on its opener). */
  at: "control" | "popup" | "outside";
  /** Position of the focused control among the popup's controls (-1 when focus is not on one). */
  index: number;
  /** How many controls the popup has. */
  count: number;
};

/**
 * A menu moves between its items with the arrow keys, Home and End, and Tab leaves it. A panel (a dialog
 * with buttons and links, such as the bell's list) lets Tab walk through its controls in order and the
 * arrow keys step between them; Tab past either end leaves it. Escape closes both.
 */
export function popKey({ key, shift, role, at, index, count }: PopKeyInput): PopKey {
  if (key === "Escape") return { do: "close" };
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!count) return { do: "none" };
    const down = key === "ArrowDown";
    return { do: "focus", index: index < 0 ? (down ? 0 : count - 1) : (index + (down ? 1 : -1) + count) % count };
  }
  if ((key === "Home" || key === "End") && role === "menu") return count ? { do: "focus", index: key === "Home" ? 0 : count - 1 } : { do: "none" };
  if (key !== "Tab") return { do: "none" };
  if (role === "menu") return { do: "leave" };
  if (at === "outside") return shift || !count ? { do: "leave" } : { do: "focus", index: 0 };
  if (shift) return at === "popup" || index <= 0 ? { do: "leave" } : { do: "none" };
  if (!count) return { do: "leave" };
  return at === "control" && index === count - 1 ? { do: "leave" } : { do: "none" };
}
