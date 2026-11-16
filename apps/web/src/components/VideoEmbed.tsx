import { useEffect, useRef, useState } from "react";
import type { ItemDTO } from "@purss/domain";
import type { Embed } from "../lib/embeds.ts";
import { Art, type Face } from "./item-bits.tsx";
import { newPlaybackSessionId } from "../outbox/entries.ts";
import { useItemActions } from "../state/actions.ts";
import { youtubeStartWorkflow } from "../player/embedded-workflow.ts";

/**
 * A video page's own player in the reader. Until the person presses play only the item's picture shows and
 * nothing is asked of the platform; then the platform's player loads in its place and starts. It runs walled off
 * from PURSS (another origin, sandboxed, no navigating this page). Some videos refuse to be embedded: the
 * platform's player says so, and the "Open on …" link beside it still opens the video's own page.
 */
export function VideoEmbed({ item, face, embed }: { item: ItemDTO; face: Face; embed: Embed }) {
  const [on, setOn] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const actions = useItemActions();
  const start = () => {
    const automatic = youtubeStartWorkflow(embed.platform, item.workflow, item.workflowRevision, newPlaybackSessionId());
    if (automatic) void actions.setPlaybackWorkflow(item.id, automatic.from, automatic.to, automatic.playback);
    setOn(true);
  };
  // The button the person pressed is replaced by the player: focus goes to it, so it doesn't fall to the page.
  useEffect(() => { if (on) frame.current?.focus(); }, [on]);
  if (!on) {
    return (
      <button type="button" className="art-link embed-start" onClick={start} aria-label={`Play here: ${item.title}`} title={`Play here, in ${embed.platform}'s player`}>
        <Art item={item} face={face} playable />
      </button>
    );
  }
  return (
    // Twitch's player needs at least 300 px of height (and 400 of width) to start by itself; narrower, it waits for its own play button.
    <div className={`embed${embed.platform === "Twitch" ? " embed-tw" : ""}`}>
      <iframe
        ref={frame}
        src={embed.src}
        title={`${embed.platform} player: ${item.title}`}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        // The platforms want to know which site plays their video (YouTube refuses to play without it): the origin only.
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
