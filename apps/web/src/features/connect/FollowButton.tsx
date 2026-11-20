import { useEffect, useState } from "react";
import { app } from "@purss/copy/app";
import { TextInput } from "@purss/ui";
import { get, messageOf } from "../../api/client.ts";
import { platform } from "../../platform/index.ts";
import { CopyButton } from "../shared/bits.tsx";
import { followButtonHtml } from "./follow-button.ts";

const copy = app.connect.followButtonSection;

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
      <div className="lbl" id="fb-l">{copy.title}</div>
      <p className="fine">{copy.hint}</p>
      <TextInput aria-label="Your site's feed address" type="url" inputMode="url" placeholder="https://example.com/feed.xml" value={feed} onChange={(e) => setFeed(e.target.value)} />
      {error ? <p className="fine" role="alert">{error}</p> : null}
      {link ? (
        <>
          <p className="fine">{copy.looksLike}<a className="fx-follow-btn" href={link} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); platform.openExternal(link); }}>{app.connect.followButton.label}</a></p>
          <div className="fx-link"><span className="fx-link-l">{copy.button}</span><code className="fx-url">{followButtonHtml(link)}</code><CopyButton value={followButtonHtml(link)} what={copy.buttonWhat} /></div>
          <div className="fx-link"><span className="fx-link-l">{copy.linkOnly}</span><code className="fx-url">{link}</code><CopyButton value={link} what={app.words.followLink} /></div>
        </>
      ) : null}
    </section>
  );
}
