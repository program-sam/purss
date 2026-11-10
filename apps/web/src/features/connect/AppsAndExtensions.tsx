import type { ReactNode } from "react";
import { DESKTOP_RELEASES_URL, DISTRIBUTION, publishedStores } from "@purss/domain";
import type { Distributed } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { platform } from "../../platform/index.ts";
import type { IconName } from "@purss/ui";

/** Store buttons for what is published, and an honest note with the install instructions for what isn't. */
function Get({ what }: { what: Distributed }) {
  const d = DISTRIBUTION[what];
  const stores = publishedStores(what);
  return (
    <>
      {stores.length < d.stores.length ? (
        <small>{stores.length ? "Not in the other stores yet." : "Not in the stores yet."}{" "}
          <a className="link" href={d.install} target="_blank" rel="noopener noreferrer">{what === "extension" ? "How to install it" : "How to build it"}</a></small>
      ) : null}
      {stores.length ? <span className="get-stores">{stores.map((s) => <a key={s.id} className="btn" href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a>)}</span> : null}
    </>
  );
}

function Row({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <li>
      <Icon name={icon} />
      <span className="tx"><b>{title}</b>{children}</span>
      {action}
    </li>
  );
}

/**
 * Settings → Connected apps: everything that brings PURSS beyond this browser tab, in one
 * place. Store buttons appear by themselves once an address is set in @purss/domain's distribution.ts.
 */
export function AppsAndExtensions({ onOpen }: { onOpen: (tab: "general" | "assistants") => void }) {
  const toBookmarklets = () => {
    const el = document.getElementById("bm-l");
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <section className="field" aria-labelledby="ae-l" id="apps-and-extensions">
      <div className="lbl" id="ae-l">Apps and extensions</div>
      <ul className="seclist get-apps">
        <Row icon="ext" title="Browser extension">
          <small>Keep the page you're reading, add its site as a source, and search your PURSS from the address bar. For {DISTRIBUTION.extension.platforms}.</small>
          <Get what="extension" />
        </Row>
        <Row icon="phone" title="Phone and tablet app">
          <small>The same PURSS on {DISTRIBUTION.mobile.platforms}: listen with the screen off, download for reading offline, share links into it.</small>
          <Get what="mobile" />
        </Row>
        <Row icon="download" title="Desktop app" action={platform.desktop ? undefined
          : <a className="btn" href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer">Download</a>}>
          <small>{platform.desktop ? "You're using it. " : ""}For Windows, Mac and Linux: keeps running in the tray with notifications and downloads, opens feed links and OPML files, and updates itself.</small>
        </Row>
        <Row icon="bookmark" title="Bookmarklets" action={<Button onClick={toBookmarklets}>Show</Button>}>
          <small>Nothing to install: bring any page to Add source or a basket from your bookmarks bar.</small>
        </Row>
        <Row icon="key" title="Assistants" action={<Button onClick={() => onOpen("assistants")}>Open</Button>}>
          <small>Let an AI assistant such as Claude search and read your PURSS, and organise it if you allow. Off until you turn it on.</small>
        </Row>
        <Row icon="item" title="E-ink display" action={<Button onClick={() => onOpen("general")}>Open</Button>}>
          <small>Black on white with page buttons instead of scrolling, for e-readers. Set on each device in General.</small>
        </Row>
      </ul>
    </section>
  );
}
