//! The web view for pages from other sites: an article's original, or a link in it, shown inside the
//! reader instead of the default browser. It is a second web view in the main window, drawn over the part of the page
//! the reader gives it; the page says where (CSS pixels, which are the window's logical pixels) and hides it while
//! something of PURSS's covers that part.
//!
//! What it may do:
//! - It loads web pages only: its own navigations go to http(s) (frames inside a page also to `about:`, `data:` and
//!   `blob:`, which the engines confine); never local files, the app's own pages or other schemes.
//! - It reaches none of the app's commands: Tauri lets a remote page call commands only where a capability names its
//!   address, none does, and the app's command handler also refuses every web view but the main one (lib.rs).
//! - Its storage is its own and kept in memory only (incognito): sites start signed out, nothing they store outlives
//!   the app, and nothing is shared with the person's browser or with PURSS.
//! - A new window it asks for opens in it instead; a download goes to the default browser.
//!
//! On Linux Tauri packs every web view into the window's GTK box, one under the other, which ignores the place and
//! takes room from the page; there the web view is moved into a GTK overlay over the page instead (`linux`).

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

use crate::MAIN;

pub const WEB: &str = "web";
/// The page is told where the web view is and whether it is loading.
const STATE_EVENT: &str = "purss://web";

/// Where the web view goes, in the main page's CSS pixels.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn rect(self) -> Result<Rect, String> {
        let ok = |v: f64, min: f64| v.is_finite() && v >= min && v <= 100_000.0;
        if !(ok(self.x, 0.0) && ok(self.y, 0.0) && ok(self.width, 1.0) && ok(self.height, 1.0)) {
            return Err("not a place in the window".into());
        }
        Ok(Rect { position: LogicalPosition::new(self.x, self.y).into(), size: LogicalSize::new(self.width, self.height).into() })
    }
}

#[derive(Serialize, Clone)]
struct WebState {
    url: String,
    loading: bool,
}

/// `localhost` and its subdomains: on Windows the app's own pages and IPC are `http://tauri.localhost` and
/// `http://ipc.localhost`, which the web view must never load.
fn local_host(url: &Url) -> bool {
    url.host_str().is_some_and(|h| {
        let h = h.trim_end_matches('.').to_ascii_lowercase();
        h == "localhost" || h.ends_with(".localhost")
    })
}

/// An address the web view opens itself: http(s) on a host that isn't `localhost`, without a login in it.
pub fn web_address(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none() && url.host().is_some() && !local_host(&url) && raw.len() <= 8192).then_some(url)
}

/// A navigation the web view allows. On Linux and macOS this is asked for frames inside the page too, so the
/// addresses frames use are allowed; the engines don't let a page navigate itself to `data:` or `blob:` of others.
pub fn may_navigate(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => !local_host(url),
        "about" => matches!(url.as_str(), "about:blank" | "about:srcdoc"),
        "data" | "blob" => true,
        _ => false,
    }
}

static CREATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn tell<R: Runtime>(app: &AppHandle<R>, url: &Url, loading: bool) {
    let shown = if url.scheme() == "about" { String::new() } else { url.to_string() };
    let _ = app.emit_to(MAIN, STATE_EVENT, WebState { url: shown, loading });
}

/// Show `url` in the web view at `bounds`, making the web view the first time.
#[tauri::command]
pub async fn web_open(url: String, bounds: Bounds, app: AppHandle) -> Result<(), String> {
    let url = web_address(&url).ok_or("only web addresses open here")?;
    let rect = bounds.rect()?;
    let _creating = CREATING.lock().await;
    if let Some(view) = app.get_webview(WEB) {
        view.navigate(url).map_err(|e| e.to_string())?;
        place(&view, bounds)?;
        return view.show().map_err(|e| e.to_string());
    }
    let window = app.get_window(MAIN).ok_or("the window isn't there")?;
    let opens = app.clone();
    let downloads = app.clone();
    let loads = app.clone();
    let builder = WebviewBuilder::new(WEB, WebviewUrl::External(url))
        .incognito(true)
        .on_navigation(may_navigate)
        .on_new_window(move |url, _| {
            if let Some(view) = opens.get_webview(WEB).filter(|_| web_address(url.as_str()).is_some()) {
                tauri::async_runtime::spawn(async move {
                    let _ = view.navigate(url);
                });
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                if web_address(url.as_str()).is_some() {
                    let _ = downloads.opener().open_url(url.as_str(), None::<&str>);
                }
            }
            false
        })
        .on_page_load(move |_, payload| tell(&loads, payload.url(), payload.event() == PageLoadEvent::Started));
    let _view = window.add_child(builder, rect.position, rect.size).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    linux::lift(&_view, bounds)?;
    Ok(())
}

/// Move the web view to `bounds`.
fn place(view: &tauri::Webview, bounds: Bounds) -> Result<(), String> {
    let rect = bounds.rect()?;
    #[cfg(target_os = "linux")]
    {
        let _ = rect;
        linux::place(view, bounds)
    }
    #[cfg(not(target_os = "linux"))]
    view.set_bounds(rect).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::Bounds;
    use gtk::prelude::*;

    fn apply(widget: &gtk::Widget, b: Bounds) {
        widget.set_margin_start(b.x.round() as i32);
        widget.set_margin_top(b.y.round() as i32);
        widget.set_size_request(b.width.round() as i32, b.height.round() as i32);
    }

    /// Lay the new web view over the page: the page goes into a GTK overlay in the window's box, and the web view
    /// becomes the overlay's child at `bounds` (aligned to the top left, offset by margins). Elsewhere the page gets the input.
    pub fn lift(view: &tauri::Webview, b: Bounds) -> Result<(), String> {
        view.with_webview(move |platform| {
            let widget: gtk::Widget = platform.inner().upcast();
            // Tauri put it in the window's box, after the page.
            let Some(vbox) = widget.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return };
            let page: Vec<gtk::Widget> = vbox.children().into_iter().filter(|c| *c != widget).collect();
            vbox.remove(&widget);
            let overlay = gtk::Overlay::new();
            for p in &page {
                vbox.remove(p);
                overlay.add(p);
            }
            widget.set_halign(gtk::Align::Start);
            widget.set_valign(gtk::Align::Start);
            apply(&widget, b);
            overlay.add_overlay(&widget);
            vbox.pack_start(&overlay, true, true, 0);
            overlay.show_all();
        })
        .map_err(|e| e.to_string())
    }

    pub fn place(view: &tauri::Webview, b: Bounds) -> Result<(), String> {
        view.with_webview(move |platform| apply(&platform.inner().upcast(), b)).map_err(|e| e.to_string())
    }
}

/// Move the web view, or hide it (`bounds` null) while something covers its place; its page stays.
#[tauri::command]
pub fn web_place(bounds: Option<Bounds>, app: AppHandle) -> Result<(), String> {
    let Some(view) = app.get_webview(WEB) else { return Ok(()) };
    match bounds {
        Some(b) => {
            place(&view, b)?;
            view.show().map_err(|e| e.to_string())
        }
        None => view.hide().map_err(|e| e.to_string()),
    }
}

/// Hide the web view and unload its page. Waits for one being made, so a pane closed meanwhile leaves none on screen.
#[tauri::command]
pub async fn web_close(app: AppHandle) -> Result<(), String> {
    let _creating = CREATING.lock().await;
    let Some(view) = app.get_webview(WEB) else { return Ok(()) };
    view.hide().map_err(|e| e.to_string())?;
    view.navigate(Url::parse("about:blank").expect("a valid address")).map_err(|e| e.to_string())
}

/// Back, forward or reload in the web view.
#[tauri::command]
pub fn web_go(action: String, app: AppHandle) -> Result<(), String> {
    let Some(view) = app.get_webview(WEB) else { return Ok(()) };
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        _ => return Err("unknown action".into()),
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_web_addresses_only() {
        assert!(web_address("https://example.org/a?b#c").is_some());
        assert!(web_address("http://example.org/").is_some());
        for bad in ["file:///etc/passwd", "tauri://localhost/", "http://tauri.localhost/", "http://localhost:3000/", "javascript:alert(1)", "https://user:pw@example.org/", "data:text/html,x", "purss://open", "not an address"] {
            assert!(web_address(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn navigates_to_web_pages_and_what_frames_use_only() {
        let ok = |s: &str| may_navigate(&Url::parse(s).unwrap());
        assert!(ok("https://example.org/") && ok("http://example.org/") && ok("about:blank") && ok("about:srcdoc"));
        assert!(ok("data:text/html,x") && ok("blob:https://example.org/1234"));
        for bad in ["file:///etc/passwd", "tauri://localhost/", "http://tauri.localhost/", "http://ipc.localhost/x", "https://TAURI.LOCALHOST./", "ipc://localhost/x", "about:config", "mailto:a@example.org", "purss://open"] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[test]
    fn places_only_inside_sane_bounds() {
        let b = |x, y, width, height| Bounds { x, y, width, height }.rect();
        assert!(b(10.0, 48.0, 600.0, 700.0).is_ok());
        assert!(b(-1.0, 0.0, 10.0, 10.0).is_err());
        assert!(b(0.0, 0.0, 0.0, 10.0).is_err());
        assert!(b(f64::NAN, 0.0, 10.0, 10.0).is_err());
        assert!(b(0.0, 0.0, 1e9, 10.0).is_err());
    }
}
