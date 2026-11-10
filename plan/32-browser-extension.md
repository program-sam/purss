# Browser extension and bookmarklets

The owner approved a browser extension and lifted the non-goal on browser-assisted capture. People
find things while browsing, not inside PURSS; this brings keeping a page, following its site
and searching PURSS to the page itself. This document records the build decisions. The
connection, device tokens and duplicate-aware keeping it relies on are in
[plan/24](24-connected-apps.md).

## Surfaces

| Surface | Install | Does | Never |
| --- | --- | --- | --- |
| Deep links | Nothing | `/?dialog=add&url=…` opens Add source filled in; `/?dialog=keep&url=…&title=…` asks which basket to keep a page in; `/?dialog=search&q=…` opens search. They survive signing in | Look anything up or keep anything without the person pressing Find or Keep |
| Bookmarklets | Drag from *Settings → Connected apps*, or copy | Open a deep link in a new tab with the page's address (and title, to keep) | Call the API: the page's security policy can't block it and the page sees nothing of PURSS |
| Extension (`apps/extension`) | Load unpacked, or the owner publishes it | Popup on the open page, right-click menu, opt-in toolbar mark, address-bar keyword, browser-assisted capture | Run on pages by itself, fetch for the server, or talk to anything but the connected PURSS |

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Hand-off | Add source and Keep open in the PURSS tab through deep links; the extension never re-implements discovery, following or the collection choice | One guided flow with its private-feed warnings and duplicate checks (plan/04) |
| No fetch on visit | Add source with a handed-over link only fills it in; the old auto-run on a passed URL is gone. The keep dialog reads only PURSS (lookup) | Otherwise any site could make the server fetch by linking to PURSS |
| Return through sign-in | A signed-out visit to any PURSS address other than `/` goes to `/signin?next=` with that path (same-site only, `safeNext`) | Deep links from the extension and bookmarklets usually arrive in a fresh tab |
| Build tool | Hand-written build (`src/packaging/build.ts`) on Vite 8, already the web app's bundler: pages as a Vite multi-page build, background and page readers as single classic scripts, one manifest per browser, reproducible ZIPs from a small writer. Versions pinned exactly | No new tool chain; WXT (0.21, pre-1.0) would add a large dependency tree and its own conventions for four entry points. Unminified output is easy for store reviewers to read |
| One code, three targets | `chromium` (Chrome, Edge), `firefox`, `safari` differ only in the manifest: service worker vs event page, Firefox's add-on id and data-collection declaration, no `identity` on Safari. Features are detected at run time | One source; the behaviour can't drift between browsers |
| Permissions | `activeTab`, `scripting`, `storage`, `contextMenus`, `identity` (not Safari); optional `tabs` only for the opt-in mark. No host permissions, no content scripts declared, no `<all_urls>`, cookies or web requests | PURSS answers the extension with CORS (plan/24); pages are read only when the person opens the popup or right-click menu on them. Short install warning, faster store review |
| Server | The official server (`OFFICIAL_WORKSPACE_ORIGIN` in `packages/domain/src/distribution.ts`, the one value to change when it moves) is preselected: the options page shows *Server: …* and **Connect**, with a small **Change server** that reveals the address field (and *Use the official server* to go back). The server last connected to is remembered (`server` in the extension's storage, kept after disconnecting) and preselected next time. With the constant empty, only the address field is shown. The web sign-in page needs no choice: each server serves its own | Most people use the official server and never see an address; self-hosters change it once |
| Connecting | Options page: the chosen server (or typed address); `/api/connect/info` must name a PURSS that calls itself by that address. `identity.launchWebAuthFlow` opens `/connect` with PKCE (S256), a fresh `state`, and the browser's own redirect (`chromiumapp.org`, `extensions.allizom.org`); the answer must carry that state and `iss` equal to the PURSS. Safari, and anyone who prefers it, uses the typed code | The plan/24 flow, with the checks that stop a code from another attempt or PURSS being exchanged. The connection runs in the options tab, because a popup closes when the approval window takes focus |
| Address rules | One rule with the apps (`parseWorkspaceAddress` in `packages/domain/src/workspace-address.ts`): without a scheme, `https://`; plain `http://` only for this computer, private, shared (CGNAT) and link-local ranges (IPv4 and IPv6) and local-only names (`.local`, `.lan`, `.home.arpa`, `.internal`), with a warning when it isn't loopback | Self-hosters on a home network often have no TLS; on the internet the token would travel readable |
| Token | Kept in the extension's local storage, never synced; sent only as a bearer header with `credentials: "omit"`. A 401 forgets it; **Disconnect** calls `DELETE /api/connect/device` and forgets it even if the PURSS can't be reached | Same lifetime and revocation as plan/24 |
| Popup | On open: lookup (kept, where, followed sources), baskets, and the page's feed hints, side by side. Keep with a basket picker (starts on the last basket used), optional "Also keep its text as you see it", **Add as a source** when the page advertises a feed or is a YouTube channel or video, **Open it in your PURSS** | Everything is one click from the page; nothing happens without one |
| Feed hints | A content script, injected only when the popup opens, reads `<link rel="alternate">` feeds (RSS, Atom, JSON Feed, RDF; up to 8) and the YouTube channel. Channel pages are read from the address; a video's channel from its microdata only when that microdata is about this video, else the video's own address is handed over | YouTube changes pages without reloading, so the head can describe the previous page. The extension sends addresses, never feed contents: FreshRSS stays the only fetcher |
| Right-click menu | *Keep page in ›* and *Keep link in ›* with up to 12 baskets (names cached from the last popup, connection or browser start); the toolbar shows ✓ or ! with the outcome. Not on iOS (no menus there) | Keeping a link without opening it; the popup covers every basket |
| Toolbar mark | The popup sets ✓ on the tab after its lookup. Marking pages as they open is a setting, **off by default**; turning it on asks for the `tabs` permission at that moment. Then each page opened in a normal window (never a private one) is looked up after 1.2 s on it, with answers kept 10 minutes per address (fragment ignored, at most 500) | Doing it by default would send every visited address to the PURSS. The PURSS is the person's own, but the browsing history is still more than the feature needs |
| Address-bar search | Keyword `ws`: Enter opens `/?dialog=search&q=…`. No suggestions while typing | Each keystroke would go to the PURSS; opening search there gives the full results |
| Browser-assisted capture | On request only. In the page, Mozilla Readability reads a clone of the document (the page itself is untouched); at most 2,000,000 characters. `POST /api/items/browser-capture` keeps the page like `/api/items/manual` (same duplicate rules) and stores the HTML as a capture of kind `browser`, sanitized again with the server's allowlist; the server fetches nothing | What the person sees, including pages behind their own sign-in, without a server fetch that couldn't see it |
| Labelling | The item panel says **Captured in your browser on 5 Nov 2026**, with: "The text as your browser showed it. PURSS didn't fetch the page, so it can't confirm that this matches the original." Lookup reports `browserCapturedAt`; MCP's `get_item` reports `textSource: "text saved from the person's browser"` | Never mistaken for a copy the server fetched, and never a promise about the original (AGENTS.md) |
| One per item | At most one browser capture per item (a unique index). Capturing again replaces its text in place, keeping its id so highlights made on it still name it; the popup says "Replaces the text kept from your browser on …" before it happens | Repeated captures don't pile up silently; replacing is the person's explicit choice |
| Storage | Measured like a server capture and admitted against the account's allocation in its own savepoint; a replacement releases the old copy first. Text that doesn't fit is refused while the link is still kept (or the earlier text stays), with the reason; growth isn't paused for it. In a "Save readable text" basket the browser text stands in for the server's fetch | Counted once, never evicted silently, optional like automatic full-text copies |
| Export | Captures carry `kind` in the archive; import restores browser captures (the newest one per item) and counts them | Export is independent of where the text came from |
| Limits | Request body 8 MB; 60 browser captures per 10 minutes per account; title ≤ 300 characters | Bounded load; the extension checks the size before sending |
| Extension's routes | The plan/24 list plus `POST /api/items/browser-capture`; `/api/connect/info` reports `features.browserCapture` | The extension shows the option only where PURSS has it |

## Threats

| Threat | Answer |
| --- | --- |
| A site links to PURSS's deep link to make it fetch | Add source only fills in; Find is the person's action. Keep needs a basket choice and a click |
| A page's script tampers with a bookmarklet | Bookmarklets run in the page and could be interfered with by it, like any bookmarklet; they only open a deep link (`noopener`, and PURSS sends `Cross-Origin-Opener-Policy: same-origin`), and every action is confirmed in PURSS |
| A page feeds misleading feed hints or text | Hints are addresses that go through Add source's safe fetching; captured HTML is sanitized on the server and labelled as what the browser showed; it can only reach the person's own PURSS |
| Capture of private content | Only on request, only to the person's own PURSS, never shared or published (publications store their own snapshots, plan/19). Hosted operators can technically read stored text, as with all content (plan/10) |
| Browsing history leaking to PURSS | Lookups happen on popup open; the automatic mark is opt-in, skips private windows and PURSS itself |
| Another PURSS's code | `state` and `iss` must match the attempt; info's origin must match the typed address |
| Oversized or hostile capture | Size caps on both sides, server sanitizer bounded in nesting depth and parser work (markup beyond the bounds keeps only its text), per-account rate limit, storage admission |

## Validation

Unit tests: address handling, deep links, PKCE and redirect checks, the API client, feed and YouTube
detection, Readability capture, popup wording, menus, the mark's cache and debounce, manifests per
browser, the ZIP writer (`apps/extension/src/**`); the endpoint, sanitizer reuse, replacement, quota,
cross-tenant isolation, schema caps, export and import (`apps/api/src/services/browser-capture.test.ts`),
the extension's route, body limit and CORS (`connect.test.ts`), migration 030; deep links and
bookmarklets (`apps/web/src/lib/deep-links.test.ts`). The hermetic journey
`tests/acceptance/extension.ts` loads the built Chromium extension in Chromium's new headless mode
(verified to run extensions, `launchWebAuthFlow` and `action.openPopup`) and walks the flows in the
[acceptance README](../tests/acceptance/README.md#browser-extension-and-bookmarklets).

## Not built

Store listings and signing (owner-held accounts: Chrome Web Store, AMO, Apple); the Safari app
container (made with Apple's packager from the ZIP); Firefox for Android (needs its own testing and
probably a separate manifest); suggestions while typing in the address bar; keeping a selection as a
quote; capturing images, styles or whole-page archives (only readable text is kept); a way to remove
only a browser capture (deleting the item removes it); automated runs in Firefox and Safari (the
journey drives Chromium; Firefox is checked with `web-ext lint`).

## Open questions for the owner

- The Firefox add-on id (`FIREFOX_ID` in `src/packaging/manifest.ts`) must be final before the first
  AMO upload, and the data-collection declaration (`browsingActivity`, `websiteContent`) chosen to
  match what the listing says.
- Whether the hosted service should show an extra notice before the first browser capture (operators
  can read stored text there).
- Whether to pin official extension ids once published (plan/24).
- **Plain HTTP on the local network** (shared with the apps, plan/31): the conservative default built
  allows it only for local addresses, with a warning. Refusing it entirely, or allowing more, is the
  owner's call.
