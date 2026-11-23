import type { ReactNode } from "react";
import { ANDROID_APK, DESKTOP_RELEASES_URL, DISTRIBUTION, STORE_NAMES, desktopDownloadUrl, publishedStores } from "@purss/domain";
import type { Distributed } from "@purss/domain";
import { app } from "@purss/translations/app";
import { Button, Icon } from "@purss/ui";
import { platform } from "../../platform/index.ts";
import { useSession } from "../../api/hooks.ts";
import type { IconName } from "@purss/ui";

const t = app.connect.appsAndExtensions;

/** Store buttons for what is published, and an honest note with the install instructions for what isn't. */
function Get({ what, selfHosted }: { what: Distributed; selfHosted: boolean }) {
  const d = DISTRIBUTION[what];
  const stores = publishedStores(what);
  const missing = d.stores.filter((id) => !stores.some((s) => s.id === id)).map((id) => STORE_NAMES[id]);
  return (
    <>
      {stores.length < d.stores.length ? (
        <small>{t.notIn(missing.length < 2 ? missing.join("") : t.listOr(missing.slice(0, -1).join(", "), missing.at(-1)))}{" "}
          {selfHosted ? <a className="link" href={d.install} target="_blank" rel="noopener noreferrer">{what === "extension" ? t.howToInstall : t.howToBuild}</a> : null}</small>
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
  const selfHosted = useSession().data?.installation.mode === "self";
  const toBookmarklets = () => {
    const el = document.getElementById("bm-l");
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <section className="field" aria-labelledby="ae-l" id="apps-and-extensions">
      <div className="lbl" id="ae-l">{app.words.appsAndExtensions}</div>
      <ul className="seclist get-apps">
        <Row icon="ext" title={app.words.browserExtension}>
          <small>{t.extension.text(DISTRIBUTION.extension.platforms)}</small>
          <Get what="extension" selfHosted={selfHosted} />
        </Row>
        <Row icon="phone" title={t.phone.title} action={platform.connection && !platform.desktop ? undefined
          : <a className="btn" href={desktopDownloadUrl(ANDROID_APK)} target="_blank" rel="noopener noreferrer">{t.phone.download}</a>}>
          <small>{t.phone.text(DISTRIBUTION.mobile.platforms)}</small>
          <Get what="mobile" selfHosted={selfHosted} />
        </Row>
        <Row icon="download" title={t.desktop.title} action={platform.desktop ? undefined
          : <a className="btn" href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer">{app.words.download}</a>}>
          <small>{platform.desktop ? t.desktop.usingIt : ""}{t.desktop.text}</small>
        </Row>
        <Row icon="bookmark" title={app.words.bookmarklets} action={<Button onClick={toBookmarklets}>{app.words.show}</Button>}>
          <small>{t.bookmarklets.text}</small>
        </Row>
        <Row icon="key" title={app.words.assistants} action={<Button onClick={() => onOpen("assistants")}>{app.words.open}</Button>}>
          <small>{t.assistants.text}</small>
        </Row>
        <Row icon="item" title={app.words.eInkDisplay} action={<Button onClick={() => onOpen("general")}>{app.words.open}</Button>}>
          <small>{t.eink.text}</small>
        </Row>
      </ul>
    </section>
  );
}
