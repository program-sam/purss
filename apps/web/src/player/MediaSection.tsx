import type { ItemDetail, ItemMedia } from "@purss/domain";
import { Button, Icon } from "@purss/ui";
import { clock, resumePoint } from "./logic.ts";
import { usePlayer } from "./PlayerProvider.tsx";
import { useDownload } from "../downloads/hooks.ts";

/**
 * An item's audio or video: play it here, from the download on this device when there is one (the apps)
 * and otherwise from the publisher. The server keeps no media files.
 */
export function MediaSection({ item }: { item: ItemDetail & { media: ItemMedia } }) {
  const { player, snap } = usePlayer();
  const media = item.media;
  const current = snap.now?.itemId === item.id;
  const playing = current && snap.state.playing;
  const downloaded = useDownload(item.id).record;
  // What is playing says where it plays from; otherwise where it would: a download here first, then the publisher.
  const from = current && snap.now ? snap.now.from : downloaded?.state === "done" && downloaded.media ? "device" : "publisher";
  const playback = player.positionFor(item.id, item.playback);
  const resume = resumePoint(playback);
  const word = media.kind === "video" ? "Watch" : "Listen";

  const play = () => {
    if (current) player.toggle();
    else void player.open({ id: item.id, title: item.title, sourceTitle: item.sourceTitle, imageUrl: item.imageUrl, media, playback: item.playback });
  };

  return (
    <section className="field media-box" aria-label={media.kind === "video" ? "Video" : "Audio"}>
      <div className="media-play">
        <Button variant="primary" onClick={play}>
          <Icon name={playing ? "pause" : "play"} size="sm" />
          {playing ? "Pause" : current ? "Continue" : resume > 0 ? `${word} from ${clock(resume)}` : word}
        </Button>
        <span className="fine">{from === "device" ? "Plays the download on this device, with or without a connection." : "Streams from the publisher's site, which sees your address, like images do."}</span>
      </div>
    </section>
  );
}
