import { useEffect, useState } from "react";
import { TextInput } from "@purss/ui";
import { get, messageOf } from "../../api/client.ts";
import { platform } from "../../platform/index.ts";
import { CopyButton } from "../shared/bits.tsx";
import { followButtonHtml } from "./follow-button.ts";

/**
 * Settings → Connected apps: a "Follow" button for your own blog or site. It points at this PURSS's
 * follow page, where readers follow the feed here, or copy it into any other feed reader. PURSS
 * makes the link, so it accepts exactly the addresses its follow page does (no private feed links).
 */
export function FollowButton() {
  const [feed, setFeed] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setLink(null); setError("");
    const url = feed.trim();
    if (!url) return;
    let live = true;
    const t = setTimeout(() => {
      get<{ followUrl: string }>("/api/follow-link", { url })
        .then((out) => { if (live) setLink(out.followUrl); })
        .catch((err: unknown) => { if (live) setError(messageOf(err)); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [feed]);
  return (
    <section className="field" aria-labelledby="fb-l">
      <div className="lbl" id="fb-l">Follow button for your site</div>
      <p className="fine">Write a blog or run a site? Paste its feed address to get a button for your pages. Readers who press it can follow your site in their PURSS here, or copy the feed into any other feed reader. Nobody is tracked.</p>
      <TextInput aria-label="Your site's feed address" type="url" inputMode="url" placeholder="https://example.com/feed.xml" value={feed} onChange={(e) => setFeed(e.target.value)} />
      {error ? <p className="fine" role="alert">{error}</p> : null}
      {link ? (
        <>
          <p className="fine">It looks like this: <a className="fx-follow-btn" href={link} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); platform.openExternal(link); }}>Follow in PURSS</a></p>
          <div className="fx-link"><span className="fx-link-l">Button</span><code className="fx-url">{followButtonHtml(link)}</code><CopyButton value={followButtonHtml(link)} what="Follow button" /></div>
          <div className="fx-link"><span className="fx-link-l">Link only</span><code className="fx-url">{link}</code><CopyButton value={link} what="Follow link" /></div>
        </>
      ) : null}
    </section>
  );
}
