import { bind, play, setEnabled, setTheme, setVolume, unlock } from "cuelume";
import type { PlayOptions, SoundName, ThemeName } from "cuelume";

/**
 * Interface sounds (cuelume, MIT): synthesized live with Web Audio, no files or requests.
 * Controls opt in with data-cuelume-* attributes (see packages/ui); outcomes play from code.
 * Settings are per device, like appearance, and sounds only ever follow the person's own
 * actions: background arrivals and live updates stay silent.
 */
export type SoundMaterial = Extract<ThemeName, "default" | "mech" | "bubble" | "press">;
export type SoundSettings = { enabled: boolean; volume: number; material: SoundMaterial };

export const SOUND_MATERIALS: { value: SoundMaterial; label: string; blurb: string }[] = [
  { value: "default", label: "Glass and wood", blurb: "Warm taps and soft mallets" },
  { value: "mech", label: "Mechanical", blurb: "Shutter clicks and latches" },
  { value: "bubble", label: "Bubbly", blurb: "Playful drips and pops" },
  { value: "press", label: "Trackpad", blurb: "Clicks over a deep note" },
];

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: false, volume: 0.4, material: "default" };
const KEY = "purss:sounds";

export function parseSoundSettings(raw: string | null): SoundSettings {
  if (!raw) return { ...DEFAULT_SOUND_SETTINGS };
  try {
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    const volume = typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_SOUND_SETTINGS.volume;
    const material = SOUND_MATERIALS.some((m) => m.value === v.material) ? (v.material as SoundMaterial) : DEFAULT_SOUND_SETTINGS.material;
    return { enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_SOUND_SETTINGS.enabled, volume, material };
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS };
  }
}

function read(): SoundSettings {
  try { return parseSoundSettings(localStorage.getItem(KEY)); } catch { return { ...DEFAULT_SOUND_SETTINGS }; }
}

let current: SoundSettings = { ...DEFAULT_SOUND_SETTINGS };
const listeners = new Set<() => void>();

function apply(s: SoundSettings): void {
  setEnabled(s.enabled);
  setVolume(s.volume);
  setTheme(s.material);
}

/** Wire up every data-cuelume-* control once, with this device's settings. */
export function initSounds(): void {
  current = read();
  apply(current);
  bind(document);
}

export function soundSettings(): SoundSettings {
  return current;
}

export function subscribeSounds(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Save and apply. Call from the click that changes it, so browsers allow audio to start. */
export function updateSounds(patch: Partial<SoundSettings>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode: keep for this visit */ }
  apply(current);
  if (current.enabled) void unlock();
  listeners.forEach((fn) => fn());
}

/** An outcome cue for something the person just did. Silent when the page isn't visible. */
export function cue(name: SoundName, options?: PlayOptions): void {
  if (!current.enabled || document.visibilityState !== "visible") return;
  play(name, options);
}
