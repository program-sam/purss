# Publisher media and in-app playback

The owner decided that the server never downloads or stores audio or video files for people, on hosted
and self-hosted installs alike. An item whose feed offers a file (an RSS enclosure) plays from the
publisher's own address; the apps can download that file to the device, also straight from the
publisher. This document records the decisions for playback in the web app, which the mobile app
reuses, for playback positions, and for what the server does and does not do with media.

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| What counts as media | The first audio or video enclosure of an item (by declared type, or by file extension when untyped); never a streaming playlist, a web page, a YouTube or other platform page | Only a direct file the publisher offers; no stream ripping, no platform downloaders, no paywall bypass |
| Private sources | No player and no file address in the item; their enclosure addresses are never shown | Enclosure addresses of private feeds can carry the subscriber's secret |
| Server storage | None. The server reports the enclosure (address, kind, declared type and size) and nothing else; it holds no media file, no copy in the storage ledger and no download job, and serves none | The owner's decision: media files are large, belong to the publisher, and are not what PURSS is for. A bookmark or an episode never implies a file is kept (AGENTS.md) |
| Playback position | `playback_positions` per item: position and duration, the position recorded last wins (a position sent late, after playing offline, carries `recordedAt`, its time on the device capped at the server's clock, and doesn't replace one recorded after it), separate from reading progress, workflow, revisions and baskets; one small storage record per item, with the control headroom | Resume on any device; never conflicts with state changes |
| Player | One player above the pages (persistent mini-player), plays the download on this device when there is one (the apps) and otherwise the publisher's file, and says which; skip back 15 s and forward 30 s (also from "next" and "previous" in the system's controls: a headset's double press, a car's buttons), speeds 0.8× to 2× remembered per device, a sleep timer (5 to 60 minutes, on this device's clock, ends when the player closes), position saved on pause, every 15 s while playing, on close and when the page is hidden; Media Session metadata and controls | Listening while reading and moving around |
| Publisher files | Played and downloaded only from an `https` address, directly from the publisher, which sees the listener's address (said in the reader) | The page's policy requires https; the apps follow suit; nothing is fetched through PURSS |
| CSP | `media-src https:` for the page the server serves; the apps' bundled page also allows its own origin (device files) | PURSS serves no media, so only publishers' https files load, like feed images |
| Device downloads | Apps only (Capacitor): "Downloaded" copies on one device, never counted against the account's storage; the file is fetched from the publisher's address (plan/31). On the plain web there is no device download, so no download button is shown | Downloading to the person's own device is theirs to do; the server stores nothing |
| Not kept | If the publisher removes a file, no copy remains on the server; a device download may be the only one | Said in Downloaded and in the user guide |

**Clocks.** A position saved while connected carries no `recordedAt` and is stamped with the server's
clock, so only positions sent late depend on a device's clock. A device clock ahead of the server's is
capped at the server's time when the position arrives: it can't make a position win over later ones
for good, but it does win over anything recorded on other devices between the offline listening and the
upload. A device clock behind the server's makes its late positions look older than they are: one may
lose to a position another device saved meanwhile, and is then not stored (the answer is the newer
position, which the device resumes from). Recording times are compared as given; nothing corrects a device's clock.

## Contracts other workstreams use

**Item DTO** (`packages/domain/src/api.ts`): every `ItemDTO` has `media: ItemMedia | null`:

```ts
type ItemMedia = { url: string; kind: "audio" | "video"; type: string | null; length: number | null };
```

`url` is the publisher's address; `type` and `length` are as the feed declares them and may be missing or wrong.
`ItemDetail` adds `playback: { positionSeconds: number; durationSeconds: number | null; updatedAt: string } | null`.

**Endpoint** (scoped by `requirePrincipal`, so a bearer device token that resolves to a principal works the same):

| Method and path | Does |
| --- | --- |
| `PUT /api/items/:id/playback` | `{ positionSeconds, durationSeconds? }` → the stored position |

**Player interface** (`apps/web/src/player/backend.ts`): the platform part of playback. A native backend
implements `PlayerBackend` and is passed to `<PlayerProvider backend={…}>`:

```ts
interface PlayerBackend {
  readonly supportsVideo: boolean;      // can it show video (the web element can)
  load(source: { url; kind; type }, opts: { startAt; rate; autoplay }): void;
  play(): Promise<void>; pause(): void; seek(seconds: number): void; setRate(rate: number): void;
  view(): HTMLElement | null;           // element that shows video, or null
  state(): { position; duration; playing; buffering; ended; failed };
  subscribe(listener: () => void): () => void;
  unload(): void;
}
```

The controller (`player.ts`) chooses the source (the device download first, then the publisher), resumes,
saves positions and owns the speed; the UI (`PlayerBar.tsx`, `MediaSection.tsx`) and the Media Session
wiring (`media-session.ts`) talk only to the controller. A native shell that plays a device "Downloaded"
file passes that file's URL from its own backend; `HtmlMediaBackend` is the web implementation.

## Not built

- Native background playback, lock-screen controls and CarPlay/Android Auto beyond what plan/31 records.
- Playback positions in the JSON export and import: the archive format carries items and their text,
  not playback positions.
- A queue or playlist in the player, sleep timer, chapters, transcripts.
- Any server copy of a media file, and any download of a streaming playlist (HLS/DASH), a file behind a
  login, or anything from a video platform's page.
