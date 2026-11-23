import { useEffect, useRef } from "react";
import { app } from "@purss/translations/app";
import { Icon } from "@purss/ui";
import { bookmarklet } from "../../lib/deep-links.ts";
import type { BookmarkletKind } from "../../lib/deep-links.ts";
import { platform } from "../../platform/index.ts";
import { useToasts } from "../../state/toasts.tsx";
import { CopyButton } from "../shared/bits.tsx";

const t = app.connect.bookmarklets;

const BOOKMARKLETS: { kind: BookmarkletKind; name: string; does: string }[] = [
  { kind: "add", name: app.words.addAsSource, does: t.add.does },
  { kind: "keep", name: app.words.keepThisPage, does: t.keep.does },
];

/**
 * A link whose address is the bookmarklet. React refuses javascript: addresses in markup, so it is set
 * on the element directly; PURSS's own security policy stops it from running here if clicked.
 */
function DragLink({ code, name }: { code: string; name: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const { toast } = useToasts();
  useEffect(() => { ref.current?.setAttribute("href", code); }, [code]);
  return (
    <a ref={ref} className="btn bm-drag" draggable onClick={(e) => { e.preventDefault(); toast(t.dragInstead); }}>
      <Icon name="bookmark" size="sm" />{name}
    </a>
  );
}

/**
 * Settings → Connected apps: bookmarklets for browsers without the extension. They only open
 * this PURSS with the page's address; they never send anything from the page by themselves.
 */
export function Bookmarklets() {
  const origin = platform.publicOrigin();
  return (
    <section className="field" aria-labelledby="bm-l">
      <div className="lbl" id="bm-l">{app.words.bookmarklets}</div>
      <p className="fine">{t.hint}</p>
      <ul className="seclist">
        {BOOKMARKLETS.map((b) => {
          const code = bookmarklet(origin, b.kind);
          return (
            <li key={b.kind}>
              <DragLink code={code} name={b.name} />
              <span className="tx"><small>{b.does}</small></span>
              <CopyButton value={code} what={t.what(b.name)} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
