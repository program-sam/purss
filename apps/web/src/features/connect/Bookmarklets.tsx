import { useEffect, useRef } from "react";
import { Icon } from "@purss/ui";
import { bookmarklet } from "../../lib/deep-links.ts";
import type { BookmarkletKind } from "../../lib/deep-links.ts";
import { platform } from "../../platform/index.ts";
import { useToasts } from "../../state/toasts.tsx";
import { CopyButton } from "../shared/bits.tsx";

const BOOKMARKLETS: { kind: BookmarkletKind; name: string; does: string }[] = [
  { kind: "add", name: "Add as source", does: "Opens Add source here with the page's address filled in. Press Find to look for something to follow." },
  { kind: "keep", name: "Keep this page", does: "Opens PURSS and asks which basket to keep the page in." },
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
    <a ref={ref} className="btn bm-drag" draggable onClick={(e) => { e.preventDefault(); toast("Drag it to your bookmarks bar instead, then click it on any page."); }}>
      <Icon name="bookmark" size="sm" />{name}
    </a>
  );
}

/**
 * Settings → Connected apps: bookmarklets for browsers without the extension (plan/32). They only open
 * this PURSS with the page's address; they never send anything from the page by themselves.
 */
export function Bookmarklets() {
  const origin = platform.publicOrigin();
  return (
    <section className="field" aria-labelledby="bm-l">
      <div className="lbl" id="bm-l">Bookmarklets</div>
      <p className="fine">No extension? Drag these to your bookmarks bar, or copy one and paste it as a new bookmark's address. On any page, click it to bring that page here; you confirm everything in PURSS.</p>
      <ul className="seclist">
        {BOOKMARKLETS.map((b) => {
          const code = bookmarklet(origin, b.kind);
          return (
            <li key={b.kind}>
              <DragLink code={code} name={b.name} />
              <span className="tx"><small>{b.does}</small></span>
              <CopyButton value={code} what={`${b.name} bookmarklet`} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
