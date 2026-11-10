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
app, not here. See [experience and design](../../plan/03-experience-and-design.md).
