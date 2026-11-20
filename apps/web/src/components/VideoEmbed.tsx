import { useEffect, useRef, useState } from "react";
import { app } from "@purss/copy/app";
import type { ItemDTO } from "@purss/domain";
import type { Embed } from "../lib/embeds.ts";
import { Art, type Face } from "./item-bits.tsx";
import { newPlaybackSessionId } from "../outbox/entries.ts";
import { useItemActions } from "../state/actions.ts";
import { youtubeStartWorkflow } from "../player/embedded-workflow.ts";

const t = app.components.videoEmbed;

/**
 * A video page's own player in the reader. Until the person presses play only the item's picture shows and
 * nothing is asked of the platform; then the platform's player loads in its place and starts. It runs walled off
 * from PURSS (another origin, sandboxed, no navigating this page). Some videos refuse to be embedded: the
 * platform's player says so, and the "Open on …" link beside it still opens the video's own page. A post (Instagram)
 * has no picture of its own to press, so it loads at once (`autoload`), or behind a button when its kept pictures already show.
 */
export function VideoEmbed({ item, face, embed, autoload = false }: { item: ItemDTO; face: Face; embed: Embed; autoload?: boolean }) {
  const [on, setOn] = useState(autoload);
  const pressed = useRef(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const actions = useItemActions();
  const start = () => {
    const automatic = youtubeStartWorkflow(embed.platform, item.workflow, item.workflowRevision, newPlaybackSessionId());
    if (automatic) void actions.setPlaybackWorkflow(item.id, automatic.from, automatic.to, automatic.playback);
    pressed.current = true;
    setOn(true);
  };
  // The button the person pressed is replaced by the player: focus goes to it, so it doesn't fall to the page. One loaded by itself takes no focus.
  useEffect(() => { if (on && pressed.current) frame.current?.focus(); }, [on]);
  if (!on && embed.post) {
    return <button type="button" className="mbtn embed-show" onClick={start} title={t.loadPost(embed.platform)}>{t.showPost}</button>;
  }
  if (!on) {
    return (
      <button type="button" className="art-link embed-start" onClick={start} aria-label={`Play here: ${item.title}`} title={t.playHere(embed.platform)}>
        <Art item={item} face={face} playable />
      </button>
    );
  }
  return (
    // Twitch's player needs at least 300 px of height (and 400 of width) to start by itself; narrower, it waits for its own play button.
    <div className={`embed${embed.platform === "Twitch" ? " embed-tw" : embed.post ? " embed-post" : ""}`}>
      <iframe
        ref={frame}
        src={embed.src}
        title={t.frameTitle(embed.platform, embed.post ? app.words.post : t.player, item.title)}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        // The platforms want to know which site plays their video (YouTube refuses to play without it): the origin only.
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
