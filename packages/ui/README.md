# UI package

Original visual tokens and accessible primitives for PURSS, ported from the approved A3
design. Domain state does not belong here; the web app composes these pieces.

- `src/tokens.css`: the one accent (hue, saturation, lightness per skin: sky, lilac, meadow), light
  and dark themes, shadows and focus colour.
- `src/eink.css`: the e-ink display (`[data-display="eink"]` on `<html>`): black-on-white tokens,
  no motion, shadows, gradients or translucency, heavier focus and selection edges, larger targets.
- `src/primitives.css`: buttons (soft gloss on the primary only), segmented control, tags, menus,
  popups and dialogs, toasts, form controls, source avatars.
- `src/*.tsx`: `Icon`/`IconSprite` (line icons), `Avatar`, `Button`, `Segmented`, form controls,
  `Dialog` (centred, focus trapped, Esc, bottom sheet on phones), `Popover`/`MenuItems`,
  `ToastView`, `TipLayer`, and `useBreakpoint` (xl ≥ 1680, lg ≥ 1280, md ≥ 1024, sm ≥ 768).

Importing the package pulls in the CSS. The font (`@fontsource-variable/nunito`) is loaded by the
app, not here.

## Rules for UI code

The interface is meant to be understood at a glance, with little instruction text, and to be an inviting place to spend
time. Code in this package and in `apps/web` follows these rules, which
[development](../../docs/development.md#design-principles) lists for contributors; here they say which primitive carries
each one.

- **Meaning is never carried by an icon, a colour, a hover or a gesture alone.** Use short, concrete labels (Follow,
  Keep, Move, Undo) and pair an icon with a label when its meaning isn't obvious. An icon-only control is an
  `IconButton`, which requires a `label` (its accessible name); icons themselves are `aria-hidden`. A `data-tip` tooltip
  repeats the accessible name, shows on hover or keyboard focus only, and never on touch, where a tap acts at once.
  Selected states are announced (`aria-pressed`, `aria-checked`), not only coloured. Drag has a non-drag alternative: a
  board card moves with its menu's *Move to*.
- **Keyboard, touch and screen readers.** Every control has an accessible name, a visible `:focus-visible` ring and a
  usable touch target. Dialogs and popups trap focus, close with Esc and return focus to the control that opened them;
  on phones a dialog is a bottom sheet. The breakpoints are `xl` ≥ 1680, `lg` ≥ 1280, `md` ≥ 1024, `sm` ≥ 768 and `xs`
  below.
- **Every reversible change can be undone, and consequences stay visible.** A change the API can reverse shows a toast
  with **Undo** (`ToastView`; Ctrl+Z does the same). Publishing, permanent deletion, privacy and storage consequences
  are stated where the person decides, not hidden to make a view quieter, and content titles and source identity are
  never dropped to make cards look cleaner. An empty state offers one clear next action, and an error says what happened
  and how to recover in a brief, plain sentence.
- **No invented urgency.** Counts and freshness cues (the New marker, badges, highlights) are information the person can
  turn down, never a debt meter or a fake unread count; New is distinct from unread and from the Undecided state, and
  opening a view or clearing a highlight never silently finishes, ignores or reads an item. Nothing plays or embeds a
  third party on its own: playback and platform embeds start only when pressed.
- **Missing metadata is shown as missing, not invented**, and attribution stays: *Open original* is always there.
- **Reduced motion is respected.** Animation sits inside `@media (prefers-reduced-motion: no-preference)` (or is switched
  off under `reduce`), and the e-ink display has no motion at all.
- **Light and dark come from semantic tokens** (`src/tokens.css`) rather than literal colours, and a skin changes only
  the accent's hue, saturation and lightness.
