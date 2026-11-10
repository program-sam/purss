//! Downloads as real files (plan/42). They live in `PURSS` inside a folder the person chose (by
//! default the system's Downloads folder). The app creates that folder with a marker file and refuses an
//! existing one without it, and it only ever lists, writes or removes entries of its own layout,
//! `<account id>/<item id>/<file>`, so nothing a person keeps there is ever touched. Paths from the page are
//! checked here, never trusted: each part is a plain name, and no part of the way may be a link (symlink or
//! junction) out of the folder.
//!
//! The player plays them from a server on 127.0.0.1 (WebKitGTK plays no media from custom protocols): a random
//! port and a random secret in every address, serving only files of the layout, with range requests.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, RwLock, RwLockReadGuard};

pub const FOLDER_NAME: &str = "PURSS";
const MARKER: &str = ".purss";
const MARKER_TEXT: &str = "This folder holds the PURSS app's downloads. The app removes only its own folders here.\n";
/// No download is larger than this (the phones' rule, MAX_DOWNLOAD_BYTES).
pub const MAX_DOWNLOAD: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    /// The folder the person chose; `PURSS` inside it holds the downloads.
    parent: Option<PathBuf>,
}

pub struct Files {
    config_dir: PathBuf,
    settings_file: PathBuf,
    default_parent: PathBuf,
    state: Mutex<Settings>,
    transfers: Mutex<HashMap<String, Arc<Notify>>>,
    secret: String,
    port: Mutex<u16>,
    /// Held shared by every command that touches the folder (downloads for their whole transfer) and exclusively by a
    /// move, so a move never runs beside a write, a removal or a transfer.
    gate: RwLock<()>,
    moving: AtomicBool,
}

/// An id as the PURSS makes them (`usr_…`, `itm_…`).
fn is_id(s: &str) -> bool {
    let Some((prefix, rest)) = s.split_once('_') else { return false };
    (1..=8).contains(&prefix.len()) && prefix.bytes().all(|b| b.is_ascii_lowercase()) && rest.len() == 26 && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// A file name the download manager writes: `media.mp3`, `item.json`, `page.html`, …
fn is_file_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.as_bytes()[0].is_ascii_alphanumeric() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_') && !s.ends_with(".part")
}

/// The parts of a path in the app's layout: "", "<account>", "<account>/<item>" or "<account>/<item>/<file>".
pub fn layout(path: &str) -> Option<Vec<&str>> {
    if path.is_empty() {
        return Some(vec![]);
    }
    let parts: Vec<&str> = path.split('/').collect();
    let ok = match parts.as_slice() {
        [a] => is_id(a),
        [a, i] => is_id(a) && is_id(i),
        [a, i, f] => is_id(a) && is_id(i) && is_file_name(f),
        _ => false,
    };
    ok.then_some(parts)
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink() || is_reparse(&m)).unwrap_or(false)
}

#[cfg(windows)]
fn is_reparse(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(_: &fs::Metadata) -> bool {
    false
}

impl Files {
    pub fn new(config_dir: &Path, default_parent: PathBuf) -> Self {
        let settings_file = config_dir.join("downloads.json");
        let state = fs::read(&settings_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut secret = [0u8; 24];
        getrandom::fill(&mut secret).expect("random bytes");
        Files {
            config_dir: config_dir.to_path_buf(),
            settings_file,
            default_parent,
            state: Mutex::new(state),
            transfers: Mutex::new(HashMap::new()),
            secret: secret.iter().map(|b| format!("{b:02x}")).collect(),
            port: Mutex::new(0),
            gate: RwLock::new(()),
            moving: AtomicBool::new(false),
        }
    }

    /// Wait until no move is running, and keep moves out while the guard lives.
    pub async fn shared(&self) -> RwLockReadGuard<'_, ()> {
        self.gate.read().await
    }

    fn parent(&self) -> PathBuf {
        self.state.lock().unwrap().parent.clone().unwrap_or_else(|| self.default_parent.clone())
    }

    /// The downloads folder (`…/PURSS`), created with its marker when it isn't there yet.
    pub fn root(&self) -> Result<PathBuf, String> {
        let root = self.parent().join(FOLDER_NAME);
        ensure_root(&root)?;
        Ok(root)
    }

    /// Where a layout path is, after checking that no part of the way is a link.
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let parts = layout(path).ok_or("io:not a download path")?;
        let mut p = self.root()?;
        for part in parts {
            p.push(part);
            if is_link(&p) {
                return Err("io:a link in the downloads folder".into());
            }
        }
        Ok(p)
    }

    pub fn list(&self, path: &str) -> Result<Vec<String>, String> {
        let depth = layout(path).ok_or("io:not a download path")?.len();
        let dir = self.resolve(path)?;
        let mut out = vec![];
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let ok = match depth {
                0 | 1 => kind.is_dir() && is_id(&name),
                2 => kind.is_file() && is_file_name(&name),
                _ => false,
            };
            if ok {
                out.push(name);
            }
        }
        Ok(out)
    }

    pub fn write_text(&self, path: &str, text: &str) -> Result<u64, String> {
        if layout(path).map(|p| p.len()) != Some(3) {
            return Err("io:not a file path".into());
        }
        let file = self.resolve(path)?;
        fs::create_dir_all(file.parent().unwrap()).map_err(|e| format!("io:{e}"))?;
        let tmp = file.with_extension("tmp-write");
        let mut out = create_fresh(&tmp).map_err(|e| format!("io:{e}"))?;
        std::io::Write::write_all(&mut out, text.as_bytes()).map_err(|e| format!("io:{e}"))?;
        drop(out);
        fs::rename(&tmp, &file).map_err(|e| format!("io:{e}"))?;
        Ok(text.len() as u64)
    }

    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        if layout(path).map(|p| p.len()) != Some(3) {
            return None;
        }
        fs::read(self.resolve(path).ok()?).ok()
    }

    /// Remove a download path. The whole folder ("") means every account folder in it, nothing else.
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let target = self.resolve(path)?;
        if path.is_empty() {
            for name in self.list("")? {
                let _ = fs::remove_dir_all(target.join(name));
            }
            return Ok(());
        }
        let meta = match fs::symlink_metadata(&target) {
            Ok(m) => m,
            Err(_) => return Ok(()),
        };
        if meta.is_dir() { fs::remove_dir_all(&target) } else { fs::remove_file(&target) }.map_err(|e| format!("io:{e}"))
    }

    /// Fetch the publisher's file into `path` (as `<path>.part`, renamed when complete). https only, at most `max`
    /// bytes (and never more than 4 GB); `progress` gets the bytes so far and the declared total (0 when unknown).
    pub async fn download(&self, id: String, url: String, path: String, max: Option<u64>, progress: impl Fn(u64, u64)) -> Result<u64, String> {
        let parsed = reqwest::Url::parse(&url).map_err(|_| "insecure".to_string())?;
        if parsed.scheme() != "https" {
            return Err("insecure".into());
        }
        if layout(&path).map(|p| p.len()) != Some(3) {
            return Err("io:not a file path".into());
        }
        let file = self.resolve(&path)?;
        let max = max.unwrap_or(MAX_DOWNLOAD).min(MAX_DOWNLOAD);
        let stop = self.register(&id)?;
        let part = PathBuf::from(format!("{}.part", file.display()));
        let result = tokio::select! {
            r = fetch(&parsed, &file, &part, max, &progress) => r,
            _ = stop.notified() => Err("cancelled".to_string()),
        };
        self.transfers.lock().unwrap().remove(&id);
        if result.is_err() {
            let _ = tokio::fs::remove_file(&part).await;
        }
        result
    }

    /// Register a transfer, unless a move has begun: checked and registered under the lock a move cancels under, so
    /// every transfer is either refused or reached by the move's cancellation.
    fn register(&self, id: &str) -> Result<Arc<Notify>, String> {
        let mut transfers = self.transfers.lock().unwrap();
        if self.moving.load(Ordering::SeqCst) {
            return Err("io:the downloads folder is being moved".into());
        }
        let stop = Arc::new(Notify::new());
        transfers.insert(id.to_string(), stop.clone());
        Ok(stop)
    }

    /// A move begins: no transfer starts from now on, and every registered one is told to stop.
    fn begin_move(&self) {
        let mut transfers = self.transfers.lock().unwrap();
        self.moving.store(true, Ordering::SeqCst);
        for (_, stop) in transfers.drain() {
            stop.notify_one();
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Some(stop) = self.transfers.lock().unwrap().remove(id) {
            stop.notify_one();
        }
    }

    /// Move the downloads to `PURSS` in `parent`: stop transfers and wait for every command touching the
    /// folder, copy, keep the new choice, then delete the old copies. None when it is the folder in use already. A
    /// current folder that isn't usable (not the app's) is left untouched: there is nothing of the app's to move.
    /// Runs on a blocking thread.
    pub fn move_to(&self, parent: PathBuf) -> Result<Option<PathBuf>, String> {
        let old = self.parent().join(FOLDER_NAME);
        let new = parent.join(FOLDER_NAME);
        if fs::canonicalize(&parent).ok() == fs::canonicalize(self.parent()).ok() {
            return Ok(None);
        }
        if new.starts_with(&old) {
            return Err("Choose a folder outside the current downloads folder.".into());
        }
        ensure_root(&new)?;
        self.begin_move();
        let result = {
            let _exclusive = self.gate.blocking_write();
            self.copy_and_switch(&old, &new, parent)
        };
        self.moving.store(false, Ordering::SeqCst);
        result.map(Some)
    }

    fn copy_and_switch(&self, old: &Path, new: &Path, parent: PathBuf) -> Result<PathBuf, String> {
        let old_usable = old.join(MARKER).is_file() && !is_link(old);
        let accounts = if old_usable { self.list("")? } else { vec![] };
        for account in &accounts {
            copy_tree(&old.join(account), &new.join(account)).map_err(|e| format!("Couldn't copy the downloads: {e}"))?;
        }
        // The choice is kept before anything old is deleted: a failure here leaves both copies and the old choice.
        let settings = Settings { parent: Some(parent) };
        fs::create_dir_all(&self.config_dir).map_err(|e| format!("Couldn't keep the new folder: {e}"))?;
        let tmp = self.settings_file.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec(&settings).unwrap_or_default())
            .and_then(|_| fs::rename(&tmp, &self.settings_file))
            .map_err(|e| format!("Couldn't keep the new folder: {e}"))?;
        *self.state.lock().unwrap() = settings;
        for account in accounts {
            let _ = fs::remove_dir_all(old.join(account));
        }
        if old_usable {
            let _ = fs::remove_file(old.join(MARKER));
            let _ = fs::remove_dir(old);
        }
        Ok(new.to_path_buf())
    }

    pub fn media_base(&self) -> String {
        format!("http://127.0.0.1:{}/{}/", *self.port.lock().unwrap(), self.secret)
    }

    /// Serve downloads to the player on 127.0.0.1 (a thread of its own).
    pub fn serve(self: &Arc<Self>) -> Result<(), String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        *self.port.lock().unwrap() = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let files = self.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let files = files.clone();
                std::thread::spawn(move || files.answer(request));
            }
        });
        Ok(())
    }

    fn answer(&self, request: tiny_http::Request) {
        let not_found = || tiny_http::Response::from_string("").with_status_code(404);
        let url = request.url().split('?').next().unwrap_or("").to_string();
        let path = url.strip_prefix('/').and_then(|p| p.strip_prefix(&self.secret)).and_then(|p| p.strip_prefix('/'));
        let decoded = path.and_then(|p| percent_decode(p));
        let file = decoded.filter(|p| layout(p).map(|l| l.len()) == Some(3)).and_then(|p| self.resolve(&p).ok());
        let Some(file) = file.filter(|f| f.is_file()) else {
            let _ = request.respond(not_found());
            return;
        };
        let Ok(mut f) = fs::File::open(&file) else {
            let _ = request.respond(not_found());
            return;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let range = request.headers().iter().find(|h| h.field.equiv("Range")).and_then(|h| parse_range(h.value.as_str(), len));
        let mime = mime_of(&file);
        let header = |k: &str, v: &str| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap();
        let (status, start, end) = match range {
            Some((s, e)) => (206, s, e),
            None => (200, 0, len.saturating_sub(1)),
        };
        if len > 0 && f.seek(SeekFrom::Start(start)).is_err() {
            let _ = request.respond(not_found());
            return;
        }
        let size = if len == 0 { 0 } else { end - start + 1 };
        let mut headers = vec![header("Content-Type", mime), header("Accept-Ranges", "bytes"), header("Cache-Control", "no-store")];
        if status == 206 {
            headers.push(header("Content-Range", &format!("bytes {start}-{end}/{len}")));
        }
        let response = tiny_http::Response::new(tiny_http::StatusCode(status), headers, f.take(size), Some(size as usize), None);
        let _ = request.respond(response);
    }
}

fn ensure_root(root: &Path) -> Result<(), String> {
    let marker = root.join(MARKER);
    if root.is_dir() && !marker.is_file() {
        let empty = fs::read_dir(root).map(|mut d| d.next().is_none()).unwrap_or(false);
        if !empty {
            return Err(format!("There's already a folder called “{FOLDER_NAME}” there that isn't the app's. Choose another folder."));
        }
    }
    if is_link(root) {
        return Err(format!("“{FOLDER_NAME}” there is a link. Choose another folder."));
    }
    fs::create_dir_all(root).map_err(|e| format!("Couldn't make the downloads folder: {e}"))?;
    if !marker.is_file() {
        fs::write(&marker, MARKER_TEXT).map_err(|e| format!("Couldn't make the downloads folder: {e}"))?;
    }
    Ok(())
}

/// Copy the app's folders; nothing is written through a link at the destination.
/// A new file at `path`, never through a link: whatever is there (a file, or a link, which is removed and not followed) is
/// replaced, and the file is created only if nothing took its place meanwhile.
fn create_fresh(path: &Path) -> std::io::Result<fs::File> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => return Err(std::io::Error::other("a folder is in the way")),
        Ok(_) => fs::remove_file(path)?,
        Err(_) => {}
    }
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if is_link(to) {
        return Err(std::io::Error::other("a link in the new downloads folder"));
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if !entry.file_name().to_string_lossy().ends_with(".part") {
            if is_link(&target) {
                return Err(std::io::Error::other("a link in the new downloads folder"));
            }
            let mut out = create_fresh(&target)?;
            std::io::copy(&mut fs::File::open(entry.path())?, &mut out)?;
        }
    }
    Ok(())
}

async fn fetch(url: &reqwest::Url, file: &Path, part: &Path, max: u64, progress: &impl Fn(u64, u64)) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        // Publishers often refuse requests that don't say what they are.
        .user_agent(concat!("PURSS/", env!("CARGO_PKG_VERSION"), " (desktop app; downloads for offline listening)"))
        // Only to https, as the first address.
        .redirect(reqwest::redirect::Policy::custom(|a| if a.url().scheme() != "https" || a.previous().len() >= 10 { a.stop() } else { a.follow() }))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "network".to_string())?;
    let res = client.get(url.clone()).send().await.map_err(|_| "network".to_string())?;
    if res.url().scheme() != "https" {
        return Err("insecure".into());
    }
    let status = res.status();
    if !status.is_success() {
        return Err(format!("http:{}", status.as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    if total > max {
        return Err("too_large".into());
    }
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("io:{e}"))?;
    }
    let part_file = part.to_path_buf();
    let fresh = tokio::task::spawn_blocking(move || create_fresh(&part_file)).await.map_err(|e| format!("io:{e}"))?;
    let mut out = tokio::fs::File::from_std(fresh.map_err(|e| format!("io:{e}"))?);
    let mut stream = res.bytes_stream();
    let mut bytes: u64 = 0;
    let mut reported: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "network".to_string())?;
        bytes += chunk.len() as u64;
        if bytes > max {
            return Err("too_large".into());
        }
        out.write_all(&chunk).await.map_err(|e| format!("io:{e}"))?;
        if bytes - reported >= 256 * 1024 {
            reported = bytes;
            progress(bytes, total);
        }
    }
    out.flush().await.map_err(|e| format!("io:{e}"))?;
    drop(out);
    tokio::fs::rename(part, file).await.map_err(|e| format!("io:{e}"))?;
    progress(bytes, total);
    Ok(bytes)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One `bytes=` range within a file of `len` bytes, as (first, last).
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e: u64 = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

fn mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "aac" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "json" => "application/json",
        "html" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "usr_0123456789abcdefghjkmnpqrs";
    const I: &str = "itm_0123456789abcdefghjkmnpqrs";

    fn temp() -> PathBuf {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let d = std::env::temp_dir().join(format!("purss-files-test-{}", u64::from_le_bytes(b)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_the_apps_layout_is_a_path() {
        assert!(layout("").is_some());
        assert!(layout(A).is_some());
        assert!(layout(&format!("{A}/{I}/media.mp3")).is_some());
        for bad in ["..", &format!("{A}/../x"), &format!("{A}/{I}/../../x"), &format!("{A}/{I}/.hidden"), &format!("{A}/{I}/a/b"), "Music",
            &format!("{A}/{I}/media.mp3.part"), &format!("{A}//{I}"), &format!("/{A}"), &format!("{A}\\{I}")] {
            assert!(layout(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn keeps_to_its_own_folders_and_leaves_a_persons_files_alone() {
        let parent = temp();
        let files = Files::new(&parent, parent.clone());
        let root = files.root().unwrap();
        assert!(root.join(MARKER).is_file());
        fs::write(root.join("my notes.txt"), "mine").unwrap();
        fs::create_dir_all(root.join("Photos")).unwrap();
        files.write_text(&format!("{A}/{I}/item.json"), "{}").unwrap();
        assert_eq!(files.list("").unwrap(), vec![A.to_string()]);
        assert_eq!(files.list(&format!("{A}/{I}")).unwrap(), vec!["item.json".to_string()]);
        files.remove("").unwrap();
        assert!(root.join("my notes.txt").is_file() && root.join("Photos").is_dir(), "a person's files stay");
        assert!(!root.join(A).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn refuses_a_folder_that_isnt_the_apps_and_links_out() {
        let parent = temp();
        fs::create_dir_all(parent.join(FOLDER_NAME)).unwrap();
        fs::write(parent.join(FOLDER_NAME).join("theirs.txt"), "x").unwrap();
        let files = Files::new(&parent, parent.clone());
        assert!(files.root().is_err());
        assert!(files.write_text(&format!("{A}/{I}/item.json"), "{}").is_err());
        assert_eq!(fs::read_to_string(parent.join(FOLDER_NAME).join("theirs.txt")).unwrap(), "x");
        #[cfg(unix)]
        {
            let other = temp();
            let good = temp();
            let files = Files::new(&good, good.clone());
            let root = files.root().unwrap();
            std::os::unix::fs::symlink(&other, root.join(A)).unwrap();
            assert!(files.write_text(&format!("{A}/{I}/item.json"), "{}").is_err(), "no writing through a link");
            assert!(files.list("").unwrap().is_empty());
            files.remove(A).unwrap_err();
            assert!(other.is_dir());
            let _ = fs::remove_dir_all(other);
            let _ = fs::remove_dir_all(good);
        }
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn moving_copies_switches_then_removes_the_old_copies() {
        let a = temp();
        let b = temp();
        let files = Files::new(&a, a.clone());
        files.write_text(&format!("{A}/{I}/item.json"), "{\"x\":1}").unwrap();
        fs::write(files.root().unwrap().join("keep.txt"), "mine").unwrap();
        let moved = files.move_to(b.clone()).unwrap().unwrap();
        assert_eq!(moved, b.join(FOLDER_NAME));
        assert_eq!(files.read(&format!("{A}/{I}/item.json")).unwrap(), b"{\"x\":1}");
        assert!(!a.join(FOLDER_NAME).join(A).exists());
        assert!(a.join(FOLDER_NAME).join("keep.txt").is_file(), "the old folder keeps what isn't the app's");
        assert_eq!(files.move_to(b.clone()).unwrap(), None);
        let _ = fs::remove_dir_all(a);
        let _ = fs::remove_dir_all(b);
    }

    #[cfg(unix)]
    #[test]
    fn staging_files_and_copies_never_write_through_a_link() {
        let parent = temp();
        let outside = temp().join("victim.txt");
        fs::write(&outside, "keep").unwrap();
        let files = Files::new(&parent, parent.clone());
        let item = files.root().unwrap().join(A).join(I);
        fs::create_dir_all(&item).unwrap();
        std::os::unix::fs::symlink(&outside, item.join("item.tmp-write")).unwrap();
        files.write_text(&format!("{A}/{I}/item.json"), "{}").unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep", "the staging link was replaced, not followed");
        // A link waiting in the new folder's account place stops the move; nothing is written through it.
        let dest = temp();
        let target = temp();
        let root = dest.join(FOLDER_NAME);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MARKER), MARKER_TEXT).unwrap();
        std::os::unix::fs::symlink(&target, root.join(A)).unwrap();
        assert!(files.move_to(dest.clone()).is_err());
        assert!(fs::read_dir(&target).unwrap().next().is_none());
        assert!(files.read(&format!("{A}/{I}/item.json")).is_some(), "the downloads stay where they were");
        for d in [parent, outside.parent().unwrap().to_path_buf(), dest, target] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn a_move_keeps_its_choice_even_without_a_config_folder_yet_and_skips_a_folder_that_isnt_the_apps() {
        let config = temp().join("not-yet");
        let a = temp();
        let b = temp();
        let files = Files::new(&config, a.clone());
        files.write_text(&format!("{A}/{I}/item.json"), "{}").unwrap();
        files.move_to(b.clone()).unwrap();
        assert!(config.join("downloads.json").is_file(), "the choice survives a restart");
        let again = Files::new(&config, a.clone());
        assert_eq!(again.root().unwrap(), b.join(FOLDER_NAME));
        // The current folder turned into one that isn't the app's: choosing another still works and leaves it alone.
        let c = temp();
        fs::remove_file(b.join(FOLDER_NAME).join(MARKER)).unwrap();
        assert!(again.root().is_err());
        assert_eq!(again.move_to(c.clone()).unwrap(), Some(c.join(FOLDER_NAME)));
        assert!(b.join(FOLDER_NAME).join(A).is_dir(), "nothing in a folder that isn't the app's is touched");
        for d in [config.parent().unwrap().to_path_buf(), a, b, c] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn a_move_stops_every_transfer_and_refuses_new_ones() {
        use futures_util::FutureExt;
        let parent = temp();
        let files = Files::new(&parent, parent.clone());
        let running = files.register("a").unwrap();
        files.begin_move();
        assert!(running.notified().now_or_never().is_some(), "a registered transfer is told to stop");
        assert!(files.register("b").is_err(), "none starts while moving");
        files.moving.store(false, Ordering::SeqCst);
        assert!(files.register("c").is_ok());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=990-2000", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
    }
}
