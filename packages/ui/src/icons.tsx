import type { ReactElement } from "react";

/**
 * Original line-icon set. The sprite is rendered once near the root; every icon is a
 * `<use>` reference so icons inherit `currentColor` and stay crisp at any size.
 */
const PATHS = {
  plus: "M12 5v14M5 12h14",
  chev: "M9 6l6 6-6 6",
  home: "M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z",
  search: "",
  gear: "M4 7h9M19 7h1M4 17h1M11 17h9",
  x: "M6 6l12 12M18 6L6 18",
  more: "",
  mark: "M9.35 4.7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM11.65 4.7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0zM4.29 7Q12 4.35 19.71 7a.95.95 0 0 1-.62 1.8Q12 6.25 4.91 8.8a.95.95 0 0 1-.62-1.8zM5.2 9.6Q12 7.9 18.8 9.6L20.5 15.4Q21.2 20.4 16 20.6H8Q2.8 20.4 3.5 15.4z",
  bookmark: "M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z",
  basket: "M3.5 10h17l-1.7 8.6a1.5 1.5 0 0 1-1.5 1.2H6.7a1.5 1.5 0 0 1-1.5-1.2z M8 10l3-5.5M16 10l-3-5.5",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  sidebar: "",
  key: "M10.5 12.5L19 4M16 7l3 3M13.5 9.5l2 2",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  rss: "M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14",
  play: "M8 5l11 7-11 7z",
  pencil: "M4 20l1-4L16.5 4.5l3 3L8 19z",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  fold: "M5 9h14M5 15h14",
  unfold: "M12 4v16M5 8l7-4 7 4M5 16l7 4 7-4",
  info: "M12 11v5M12 8h.01",
  cal: "M4 10h16M8.5 3.5v4M15.5 3.5v4",
  back: "M15 6l-6 6 6 6",
  folder: "M4 7.5A1.5 1.5 0 0 1 5.5 6H10l2 2.5h6.5A1.5 1.5 0 0 1 20 10v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z",
  item: "M6 4.5h9l3 3V19.5H6zM9 11h6M9 15h6",
  filter: "M4 6h16l-6.2 7.5V19l-3.6-2v-3.5z",
  sort: "M8 5v14M4.5 15.5L8 19l3.5-3.5M16 19V5M12.5 8.5L16 5l3.5 3.5",
  selectsq: "M8.5 12.2l2.5 2.5 4.5-5",
  pause: "M9 5v14M15 5v14",
  skipback: "M4.5 12A7.5 7.5 0 1 0 12 4.5M14.5 2 12 4.5 14.5 7",
  skipfwd: "M19.5 12A7.5 7.5 0 1 1 12 4.5M9.5 2 12 4.5 9.5 7",
  copy: "M5 15V6a2 2 0 0 1 2-2h8",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2 2 0 0 0 4 0",
  trash: "M5 7h14M9.5 7V4.5h5V7M7 7l.8 12.5h8.4L17 7M10 11v5M14 11v5",
  chart: "M4 20h16M7 16v-5M12 16V6M17 16v-8",
  disk: "M4 14.5 6.6 6.2A1.5 1.5 0 0 1 8 5h8a1.5 1.5 0 0 1 1.4 1.2L20 14.5M4 14.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-3.5M4 14.5h16M16.5 17h.01",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  phone: "M11 18h2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  lock: "M7 11V8a5 5 0 0 1 10 0v3",
  clock: "M12 7.5V12l3 2",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  alert: "M12 8v5M12 16.5h.01",
  user: "M5 20a7 7 0 0 1 14 0",
  compass: "M15.5 8.5l-2 5-5 2 2-5z",
} as const;

export type IconName = keyof typeof PATHS;

/** Elements that need more than a single path, keyed by icon name. */
const EXTRA: Partial<Record<IconName, ReactElement>> = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  gear: <><path d={PATHS.gear} /><circle cx="16" cy="7" r="2.2" /><circle cx="8" cy="17" r="2.2" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  sidebar: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  key: <><circle cx="8" cy="15" r="3.5" /><path d={PATHS.key} /></>,
  rss: <><path d={PATHS.rss} /><circle cx="6.2" cy="17.8" r="1.6" fill="currentColor" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d={PATHS.info} /></>,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d={PATHS.alert} /></>,
  cal: <><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" /><path d={PATHS.cal} /></>,
  selectsq: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d={PATHS.selectsq} /></>,
  copy: <><rect x="8" y="8" width="11" height="12" rx="2" /><path d={PATHS.copy} /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d={PATHS.lock} /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d={PATHS.clock} /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d={PATHS.user} /></>,
  grip: <path d={PATHS.grip} strokeWidth="3" />,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d={PATHS.phone} /></>,
  compass: <><circle cx="12" cy="12" r="8.5" /><path d={PATHS.compass} /></>,
};

/** Renders the symbol sprite once; place it at the top of the application. */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        {(Object.keys(PATHS) as IconName[]).map((name) => (
          <symbol key={name} id={`i-${name}`} viewBox="0 0 24 24">
            {EXTRA[name] ?? <path d={PATHS[name]} />}
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

export function Icon({ name, size, className = "" }: { name: IconName; size?: "sm"; className?: string }) {
  return (
    <svg className={`ic${size ? ` ${size}` : ""}${className ? ` ${className}` : ""}`} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}
