# Originals in the reader

The owner wants a page from another site (an article's original, or a link in its text) to open inside PURSS,
so reading doesn't mean leaving the app, while the publisher is still credited and still gets the visit. The owner
approved this on 2026-11-14: frames where a page allows them, the desktop app's own web view, the browser opening a
new tab only where nothing else works, and no browser extension. This document records how it is built and what it
does not do.

## Shape

```text
reader: "Open original", a link in the article or its excerpt (`data-inapp`)
 ├─ desktop app: the app's web view, drawn over the reader       any page
 ├─ browser:     a frame over the reader, when the page allows it  else a new tab, as before
 └─ phones:      a browser tab over the app (Custom Tabs, SFSafariViewController), as before
```

The page covers the article, which keeps its place underneath; the panel's bar keeps the item's title, State and
Keep. Above the page a bar names the site and the rest of its address, says *Not secure* for plain http, and offers
reload and the page outside PURSS (the browser, or a new tab). *Article* (or Esc) goes back. In the desktop app the
bar also has back and forward within the page.

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Which pages | The reader's own links only: *Open original* (also *Open on YouTube* and the like), links in the article and in its excerpt. Lists' *Open original*, video and audio links, and links elsewhere in PURSS open outside PURSS as before | The reading path is where leaving hurts; files and other places keep their behaviour |
| Credit | The real page loads: its own address, ads, analytics and paywall. The frame sends PURSS's origin as referrer (`strict-origin-when-cross-origin`), as the video players do; the bar names the site and always offers the page itself | A real visit, unlike a copy; no proxy, no rewriting |
| Knowing a frame will work | A browser refuses a frame when the page's headers say so (`Content-Security-Policy: frame-ancestors`, or without it `X-Frame-Options`), and the page around a refused frame can't tell. So `GET /api/frame-check?url=` reads the page's headers on the server (`checkFraming`, `packages/connectors/src/frame-policy.ts`, through `safeFetch`, 16 KB read, 8 s) and judges them against `PURSS_PUBLIC_ORIGIN` the way browsers do (CSP Level 3 source matching; X-Frame-Options DENY and SAMEORIGIN; unknown values such as ALLOW-FROM allow). Only a 2xx answer counts, a download (`Content-Disposition: attachment`) is never framed, and an https PURSS never frames a plain http page (mixed content). The frame loads where the redirects ended, with the link's own fragment | Measured on 2026-11-14 across 50 common publishers: 12 allow frames (mostly independent blogs: Simon Willison, Stratechery, Wikipedia, NPR, …), 28 refuse (NYT, Guardian, BBC, The Verge, GitHub, Substack, YouTube, …), 8 refused the check itself |
| When it is asked | When an item opens, for its original; for a link in the article when the pointer rests on it or it gets focus. A press decides on what is known then: no answer yet means a new tab. A new tab is the link's own behaviour, so no popup blocker interferes | A tab opened after waiting for the server would be blocked as a popup |
| Server memory | Answers are kept 6 hours per PURSS (5000 at most), fragments dropped; a failure is remembered as *no frame*. 300 checks per account per 10 minutes, counted only when the server has to read a page | One account can't learn from timing which pages another opened; the server can't be used to hammer sites |
| The frame | `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"`, `allow="fullscreen"`, never `allow-top-navigation` | Another origin, so the page keeps its own cookies and can't reach PURSS; a page that tries to break out of frames can't navigate PURSS away |
| Page policy | The server's header and the bundled page's policy allow frames from `https: http:`; the apps' connected policy (`workspacePolicy`) narrows frames back to the video players | The browser must allow any page that allows itself; the phones and the desktop never frame originals |
| Signed-in pages | In a frame a site sees PURSS as another site, so browsers keep its cookies apart (or don't send them): paid subscriptions and logins usually don't show there, and *Open in a new tab* does. In the desktop web view sites start signed out | The owner sees signed out as a privacy feature |
| Desktop web view | A second web view (label `web`) in the main window (Tauri's `unstable` multi-webview: `Window::add_child`), placed over the reader's pane in the page's CSS pixels (the window's logical pixels). The page moves it as the pane moves (`ResizeObserver`, window size, page changes), hides it while a menu, popover or dialog lies over it, and ends it above a message at the bottom of the pane; it is closed (and unloads, `about:blank`) when the pane closes, and opened again for the next page. One web view for the run, so sites' cookie questions are asked once per run; closing waits for one still being made. The blank page it is emptied with stays in its history, so Back reaching it goes forward again. On Linux Tauri packs every web view into the window's GTK box, one under the other (the place is ignored and the page loses the room), so there the web view is moved into a GTK overlay over the page and placed by its margins (`src/web.rs`, `gtk` 0.18 as Tauri uses); clicks outside it still reach the page. The interface depends on these commands, so the desktop native level is 3 | The frame's refusals don't apply to a web view: every page works. A native view is always drawn above the page, so the page keeps it clear of its own popups |
| Desktop isolation | No app command: Tauri refuses remote pages unless a capability names their address (none does), the capability names the main web view only (`webviews: ["main"]`), and the command handler refuses every web view but `main`. The page-load hook for interface rollback ignores it. Navigation allowed to http(s) on hosts other than `localhost` and `*.localhost` (Windows serves the app at `http://tauri.localhost`), plus `about:blank`, `about:srcdoc`, `data:` and `blob:` for frames inside the page (WebKitGTK and WKWebView ask about frames too, so plain http can't be refused only for the page itself); never `file:`, `tauri:` or other schemes. Storage incognito (memory only, gone when the app quits; nothing shared with the browser or PURSS). A new window it asks for opens in it instead; a download goes to the default browser | The web view shows untrusted pages next to code that holds the device token |
| Opened with | `web_open(url, bounds)` takes http(s) addresses without a login part, not on `localhost`, at most 8 KB; bounds are finite, inside 0 … 100,000 and at least 1 px | Rust checks every argument, as for the other commands |

## Rejected

- Fetching pages through PURSS and removing their frame headers: it takes away the publisher's protection against
  clickjacking, misleads its analytics, and goes against PURSS's rules for fetching URLs.
- A browser extension that removes the headers for frames inside PURSS: the owner chose not to build it (it would need
  access to every site, against the extension's narrow permissions).
- An iframe in the apps: the phones' browser tab already works for every page with the phone browser's sign-ins.
- A separate desktop window instead of the in-window web view: it works with stable Tauri but sends the person to
  another window; kept as the fallback if the multi-webview feature misbehaves on a platform.

## Verification

- Unit tests: header rules and the check (`packages/connectors/src/frame-policy.test.ts`), the server's memory, its
  tenant scoping and refusals (`apps/api/src/services/frame-check.test.ts`), the page policies
  (`apps/api/src/http.test.ts`, `apps/web/src/platform/csp.test.ts`), placing the web view
  (`apps/web/src/lib/originals.test.ts`); in Rust (`cargo test`): addresses the web view opens and navigates to, and
  its bounds (`src/web.rs`).
- In a browser (Chromium through Playwright), this branch's API and web app on a copy of the local database (a blog
  and a video channel): an article's *Open original* opened in a frame over the reader (the server's check said yes;
  no new tab), with the publisher's page, its sponsor message and its own address; Esc went back to the article; a
  GitHub link in the article (refuses frames) opened a new tab; a link to another post on the same blog opened in the
  frame; a YouTube video's *Open on YouTube* opened a new tab; a phone-sized window shows
  the page under the bar.
- On Linux (Fedora 44, WebKitGTK, a debug build through `tauri-driver` in a headless KWin through XWayland, with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`: the virtual output can't give WebKit GPU buffers; the build from `main` fails
  the same way without it), connected to the same server: the original over the reader at the pane's place; the State
  menu shown over it (the web view stepped aside) and the page back when it closed; *Article* took it away. A hostile
  page in the web view was refused every app command (`connection_read`, `device_name`, `files_folder`, `web_close`,
  `open_external`), listening to events and the opener plugin; its moves to `tauri://localhost`, `file:///etc/hostname`,
  `http://tauri.localhost` and `http://localhost:…` were stopped (the page stayed), a move to another web page went
  through, and its cookie lasted the run.

## Not verified

- Windows (WebView2) and macOS (WKWebView): never run. Windows can be tested in a Windows 11 VM on this machine
  (KVM, QEMU and libvirt are installed; Microsoft's ISO runs unactivated); macOS only on Apple hardware (its licence
  allows VMs only there) or, without looking at it, on the GitHub macOS runner the desktop workflow already uses.
- A new window a page asks for after a click (opened in the web view instead) and a download (sent to the browser):
  WebDriver can't click inside the web view, and WebKit refuses windows a script opens without a click.
- Pages that look for the frame with script and blank themselves, and sites that send different headers to the
  server's check than to a browser (a page judged frameable still shows the bar's *Open in a new tab*).

## Not built

- Clearing the desktop web view's site data on demand (it is gone when the app quits).
- Lists' *Open original* opening the item with its page.
