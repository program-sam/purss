//! What is handed to the app from outside (plan/42): addresses (`purss://connect` answers, `purss://open` links,
//! `feed:`, `podcast:` and `pcast:` links) and opened OPML files. Kept until the page asks (what started the app)
//! and sent to it as an event while it runs; the page decides what each one means.

use serde::Serialize;

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// An OPML file larger than this isn't read.
const MAX_FILE: u64 = 5 * 1024 * 1024;
const SCHEMES: [&str; 4] = ["purss:", "feed:", "podcast:", "pcast:"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Incoming {
    Url { url: String },
    File { name: String, text: String },
    FileError { name: String, reason: String },
}

#[derive(Default)]
pub struct Queue(pub Mutex<Vec<Incoming>>);

/// An address the app handles, or None.
pub fn as_link(arg: &str) -> Option<String> {
    let lower = arg.trim().to_ascii_lowercase();
    (SCHEMES.iter().any(|s| lower.starts_with(s)) && arg.len() <= 4096).then(|| arg.trim().to_string())
}

/// A file named on the command line (Windows and Linux open files that way, as a path or a `file://` address), read
/// when it is an OPML file.
pub fn as_file(arg: &str) -> Option<Incoming> {
    let from_url = arg.starts_with("file://").then(|| tauri::Url::parse(arg).ok()?.to_file_path().ok()).flatten();
    let path_buf = from_url.unwrap_or_else(|| std::path::PathBuf::from(arg));
    let path = path_buf.as_path();
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "opml" && ext != "xml" {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    if meta.len() > MAX_FILE {
        return Some(Incoming::FileError { name, reason: "That file is too large to be a subscription list.".into() });
    }
    Some(match std::fs::read(path) {
        Ok(bytes) => Incoming::File { name, text: String::from_utf8_lossy(&bytes).into_owned() },
        Err(_) => Incoming::FileError { name, reason: "That file couldn't be read.".into() },
    })
}

/// Hand something to the page: queued, and the page told to take the queue (so nothing arrives twice, and what
/// arrives before the page listens waits for it); the window comes to the front.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, item: Incoming) {
    if let Some(queue) = app.try_state::<Queue>() {
        let mut q = queue.0.lock().unwrap();
        q.push(item);
        if q.len() > 20 {
            q.remove(0);
        }
    }
    let _ = app.emit("purss://incoming", ());
    crate::show_window(app);
}

/// Command-line arguments: addresses and files, in order.
pub fn from_args<R: Runtime>(app: &AppHandle<R>, args: &[String], links_too: bool) {
    for arg in args {
        if let Some(url) = as_link(arg) {
            if links_too {
                deliver(app, Incoming::Url { url });
            }
        } else if let Some(file) = as_file(arg) {
            deliver(app, file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_the_app_handles() {
        assert_eq!(as_link("feed:https://x.example/rss").as_deref(), Some("feed:https://x.example/rss"));
        assert_eq!(as_link("PURSS://open?item=x").as_deref(), Some("PURSS://open?item=x"));
        assert_eq!(as_link("https://x.example"), None);
        assert_eq!(as_link("--hidden"), None);
    }

    #[test]
    fn opml_files() {
        let dir = std::env::temp_dir().join(format!("purss-incoming-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("subs.opml");
        std::fs::write(&f, "<opml/>").unwrap();
        assert_eq!(as_file(f.to_str().unwrap()), Some(Incoming::File { name: "subs.opml".into(), text: "<opml/>".into() }));
        assert_eq!(as_file(&format!("file://{}", f.display())), Some(Incoming::File { name: "subs.opml".into(), text: "<opml/>".into() }), "as a desktop entry's %U passes it");
        let other = dir.join("notes.txt");
        std::fs::write(&other, "x").unwrap();
        assert_eq!(as_file(other.to_str().unwrap()), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
