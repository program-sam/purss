//! The interface the window shows (plan/39, plan/42): the one built into the app, or one downloaded from the
//! connected PURSS. Both are served from Tauri's own origin (`tauri://localhost`, `http://tauri.localhost` on
//! Windows) by `Interfaces`, an asset provider that reads the active downloaded interface from disk and otherwise
//! the built-in one, so the page's storage (offline copies, unsent notes) survives every switch.
//!
//! The page fetches a PURSS's zip and checks its SHA-256; this module only unpacks it (names checked, size
//! capped, and only a build for this app's desktop level), keeps the choice, and rolls back an interface that
//! doesn't report itself started within 15 seconds. A new version of the app removes downloaded interfaces.

use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::utils::assets::{AssetKey, CspHash};
use tauri::{Assets, Runtime};

pub const BUILTIN: &str = "builtin";
/// How long a newly switched-to interface has to report that it started.
pub const READY_WITHIN_SECS: u64 = 15;
const MAX_UNPACKED: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 5000;

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct State {
    /// The downloaded interface shown, by id (its version); none for the built-in one.
    active: Option<String>,
    /// The one shown before the last switch, to go back to when the new one doesn't start.
    previous: Option<String>,
    /// Switched to and not yet reported as started.
    trial: bool,
    /// Versions that didn't start: never installed again.
    failed: Vec<String>,
    /// The app version these were downloaded with.
    app: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InterfaceRef {
    pub id: String,
    pub version: String,
}

/// The built-in interface's build (its app-build.json, written by the web build).
#[derive(Deserialize, Clone, Debug)]
pub struct Build {
    pub built: u64,
    #[serde(default)]
    pub desktop: Option<u32>,
}

pub struct Shared {
    dir: Option<PathBuf>,
    state: State,
    builtin: Option<Build>,
    /// A failed version not yet asked for by the page (interface_failed).
    newly_failed: Option<String>,
}

#[derive(Clone)]
pub struct Interfaces(pub Arc<Mutex<Shared>>);

/// A version as the page names it: `<desktop level>.<built>.0`.
fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts[2] == "0"
        && (1..=4).contains(&parts[0].len())
        && (1..=12).contains(&parts[1].len())
        && parts[..2].iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
}

fn level_of(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

impl Interfaces {
    pub fn new(builtin: Option<Build>) -> Self {
        Interfaces(Arc::new(Mutex::new(Shared { dir: None, state: State::default(), builtin, newly_failed: None })))
    }

    /// The app's own desktop level: the one its built-in interface was built for.
    pub fn level(&self) -> Option<u32> {
        self.0.lock().unwrap().builtin.as_ref().and_then(|b| b.desktop)
    }

    pub fn builtin_version(&self) -> String {
        let s = self.0.lock().unwrap();
        match &s.builtin {
            Some(Build { built, desktop: Some(level) }) => format!("{level}.{built}.0"),
            _ => String::new(),
        }
    }

    /// At start: where interfaces live, and what to show. Downloads from another app version, or for another
    /// desktop level, are removed; an active one whose files are missing falls back to the built-in one.
    pub fn open(&self, dir: PathBuf, app_version: &str) {
        let _ = fs::create_dir_all(&dir);
        let mut state: State = fs::read(dir.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let level = self.level();
        if state.app != app_version {
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                if entry.file_name() != "state.json" {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
            state = State { app: app_version.to_string(), ..State::default() };
        }
        if let Some(id) = state.active.clone() {
            let fits = level.is_some() && level_of(&id) == level && dir.join(&id).join("index.html").is_file();
            if !fits {
                state.active = None;
                state.trial = false;
            }
        }
        let mut s = self.0.lock().unwrap();
        s.dir = Some(dir);
        s.state = state;
        save(&s);
    }

    pub fn current(&self) -> InterfaceRef {
        let s = self.0.lock().unwrap();
        match &s.state.active {
            Some(id) => InterfaceRef { id: id.clone(), version: id.clone() },
            None => InterfaceRef { id: BUILTIN.into(), version: String::new() },
        }
    }

    pub fn list(&self) -> Vec<InterfaceRef> {
        let s = self.0.lock().unwrap();
        let Some(dir) = &s.dir else { return vec![] };
        fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                (valid_version(&name) && e.path().join("index.html").is_file()).then(|| InterfaceRef { id: name.clone(), version: name })
            })
            .collect()
    }

    /// Unpack a zip the page checked into `<dir>/<version>/`. Refused: a malformed version, one that failed
    /// before, one for another desktop level, a zip that escapes its folder, is too large, or has no index.html.
    pub fn install(&self, version: &str, zip: &[u8]) -> Result<InterfaceRef, String> {
        if !valid_version(version) {
            return Err("not an interface version".into());
        }
        let (dir, level, failed) = {
            let s = self.0.lock().unwrap();
            (s.dir.clone().ok_or("not ready")?, self_level(&s), s.state.failed.clone())
        };
        if failed.iter().any(|f| f == version) {
            return Err("this interface didn't start before".into());
        }
        if level.is_none() || level_of(version) != level {
            return Err("this interface was built for another version of the app".into());
        }
        let target = dir.join(version);
        if target.join("index.html").is_file() {
            return Ok(InterfaceRef { id: version.into(), version: version.into() });
        }
        let temp = dir.join(format!("{version}.part"));
        let _ = fs::remove_dir_all(&temp);
        unpack(zip, &temp, level).map_err(|e| {
            let _ = fs::remove_dir_all(&temp);
            e
        })?;
        let _ = fs::remove_dir_all(&target);
        fs::rename(&temp, &target).map_err(|e| e.to_string())?;
        Ok(InterfaceRef { id: version.into(), version: version.into() })
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !valid_version(id) {
            return Ok(());
        }
        let s = self.0.lock().unwrap();
        if s.state.active.as_deref() == Some(id) {
            return Err("that interface is the one shown".into());
        }
        if let Some(dir) = &s.dir {
            let _ = fs::remove_dir_all(dir.join(id));
        }
        Ok(())
    }

    /// Choose what to show from the next load on: a downloaded interface (on trial until it reports it started), or the built-in one.
    pub fn apply(&self, id: &str) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        if id == BUILTIN {
            s.state.previous = None;
            s.state.active = None;
            s.state.trial = false;
        } else {
            let dir = s.dir.clone().ok_or("not ready")?;
            if !valid_version(id) || !dir.join(id).join("index.html").is_file() {
                return Err("no such interface".into());
            }
            s.state.previous = s.state.active.take();
            s.state.active = Some(id.into());
            s.state.trial = true;
        }
        save(&s);
        Ok(())
    }

    pub fn ready(&self) {
        let mut s = self.0.lock().unwrap();
        if s.state.trial {
            s.state.trial = false;
            s.state.previous = None;
            save(&s);
        }
    }

    pub fn on_trial(&self) -> bool {
        self.0.lock().unwrap().state.trial
    }

    /// The interface on trial didn't report itself started: go back to the previous one and never install it again.
    /// True when there was one to roll back.
    pub fn roll_back(&self) -> bool {
        let mut s = self.0.lock().unwrap();
        if !s.state.trial {
            return false;
        }
        if let Some(failed) = s.state.active.take() {
            s.state.failed.push(failed.clone());
            let keep = s.state.failed.len().saturating_sub(10);
            s.state.failed.drain(..keep);
            if let Some(dir) = &s.dir {
                let _ = fs::remove_dir_all(dir.join(&failed));
            }
            s.newly_failed = Some(failed);
        }
        s.state.active = s.state.previous.take();
        s.state.trial = false;
        save(&s);
        true
    }

    pub fn take_failed(&self) -> Option<String> {
        self.0.lock().unwrap().newly_failed.take()
    }

    /// A file of the interface shown now, or None (the asset resolver then tries index.html and the like).
    fn file(&self, key: &str) -> Option<Option<Vec<u8>>> {
        let s = self.0.lock().unwrap();
        let (Some(dir), Some(active)) = (&s.dir, &s.state.active) else { return None };
        match contained(key) {
            Some(rel) => Some(fs::read(dir.join(active).join(rel)).ok()),
            None => Some(None),
        }
    }
}

/// An asset key as a path inside the interface's folder: plain names only (no `.`, `..`, drive letters such as
/// `C:`, backslashes or other roots), else None.
fn contained(key: &str) -> Option<PathBuf> {
    let rel = key.trim_start_matches('/');
    let plain = |seg: &str| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains(['\\', ':', '\0']);
    if !rel.split('/').all(plain) {
        return None;
    }
    let path = PathBuf::from(rel);
    path.components().all(|c| matches!(c, std::path::Component::Normal(_))).then_some(path)
}

fn self_level(s: &Shared) -> Option<u32> {
    s.builtin.as_ref().and_then(|b| b.desktop)
}

fn save(s: &Shared) {
    if let Some(dir) = &s.dir {
        let tmp = dir.join("state.json.tmp");
        if fs::write(&tmp, serde_json::to_vec(&s.state).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, dir.join("state.json"));
        }
    }
}

fn unpack(zip: &[u8], into: &Path, level: Option<u32>) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|_| "not a zip".to_string())?;
    if archive.len() > MAX_FILES {
        return Err("too many files".into());
    }
    let mut total: u64 = 0;
    let mut build_ok = false;
    fs::create_dir_all(into).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else { return Err("a file outside the interface".into()) };
        if entry.is_dir() {
            continue;
        }
        let path = into.join(&name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::new();
        let limit = MAX_UNPACKED.saturating_sub(total) + 1;
        (&mut entry).take(limit).read_to_end(&mut data).map_err(|e| e.to_string())?;
        total += data.len() as u64;
        if total > MAX_UNPACKED {
            return Err("the interface is too large".into());
        }
        if name == Path::new("app-build.json") {
            let build: Build = serde_json::from_slice(&data).map_err(|_| "no build information".to_string())?;
            build_ok = build.desktop.is_some() && build.desktop == level;
        }
        fs::write(&path, &data).map_err(|e| e.to_string())?;
    }
    if !build_ok {
        return Err("this interface was built for another version of the app".into());
    }
    if !into.join("index.html").is_file() {
        return Err("the interface has no page".into());
    }
    Ok(())
}

/// The asset provider: the active downloaded interface, else the one built into the app.
pub struct DiskOrEmbedded<R: Runtime> {
    pub interfaces: Interfaces,
    pub embedded: Box<dyn Assets<R>>,
}

impl<R: Runtime> Assets<R> for DiskOrEmbedded<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.interfaces.file(key.as_ref()) {
            Some(found) => found.map(Cow::Owned),
            None => self.embedded.get(key),
        }
    }

    fn iter(&self) -> Box<dyn Iterator<Item = (Cow<'_, str>, Cow<'_, [u8]>)> + '_> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

/// Stands in for the embedded assets while they are taken out of the context to be wrapped.
pub struct NoAssets;

impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<dyn Iterator<Item = (Cow<'_, str>, Cow<'_, [u8]>)> + '_> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(&mut out);
        for (name, body) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
        out.into_inner()
    }

    fn setup(level: u32) -> (Interfaces, PathBuf) {
        let dir = std::env::temp_dir().join(format!("purss-iface-test-{}-{}", std::process::id(), rand_suffix()));
        let i = Interfaces::new(Some(Build { built: 100, desktop: Some(level) }));
        i.open(dir.clone(), "26.312.1");
        (i, dir)
    }

    fn rand_suffix() -> u64 {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        u64::from_le_bytes(b)
    }

    const BUILD: &str = r#"{"native":1,"built":200,"desktop":2}"#;

    #[test]
    fn installs_switches_and_rolls_back() {
        let (i, dir) = setup(2);
        assert_eq!(i.builtin_version(), "2.100.0");
        let zip = zip_of(&[("index.html", "<p>new</p>"), ("app-build.json", BUILD), ("assets/a.js", "x")]);
        let got = i.install("2.200.0", &zip).unwrap();
        assert_eq!(got.id, "2.200.0");
        assert_eq!(i.list(), vec![got.clone()]);
        assert_eq!(i.file("/index.html"), None, "the built-in one shows until the switch");
        i.apply("2.200.0").unwrap();
        assert_eq!(i.file("/index.html"), Some(Some(b"<p>new</p>".to_vec())));
        assert_eq!(i.file("/../state.json"), Some(None), "nothing outside the interface");
        for escape in ["/C:/Windows/win.ini", "/C:", "/a\\..\\..\\x", "//etc/passwd", "/./index.html"] {
            assert_eq!(i.file(escape), Some(None), "{escape}");
        }
        assert!(i.on_trial());
        assert!(i.roll_back());
        assert_eq!(i.current().id, BUILTIN);
        assert_eq!(i.take_failed().as_deref(), Some("2.200.0"));
        assert!(i.install("2.200.0", &zip).is_err(), "a version that didn't start isn't installed again");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ready_keeps_it_and_a_new_app_version_removes_downloads() {
        let (i, dir) = setup(2);
        let zip = zip_of(&[("index.html", "n"), ("app-build.json", BUILD)]);
        i.install("2.200.0", &zip).unwrap();
        i.apply("2.200.0").unwrap();
        i.ready();
        assert!(!i.roll_back());
        assert_eq!(i.current().id, "2.200.0");
        let again = Interfaces::new(Some(Build { built: 100, desktop: Some(2) }));
        again.open(dir.clone(), "26.312.1");
        assert_eq!(again.current().id, "2.200.0", "kept across starts of the same app");
        let updated = Interfaces::new(Some(Build { built: 300, desktop: Some(2) }));
        updated.open(dir.clone(), "26.313.1");
        assert_eq!(updated.current().id, BUILTIN, "a new version of the app starts on its own interface");
        assert!(updated.list().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_other_levels_escapes_and_malformed_versions() {
        let (i, dir) = setup(2);
        assert!(i.install("3.200.0", &zip_of(&[("index.html", "n"), ("app-build.json", r#"{"built":200,"desktop":3}"#)])).is_err());
        assert!(i.install("2.200.0", &zip_of(&[("index.html", "n"), ("app-build.json", r#"{"built":200,"desktop":3}"#)])).is_err(), "the zip's own level counts");
        assert!(i.install("2.200.0", &zip_of(&[("index.html", "n")])).is_err(), "no build information");
        assert!(i.install("2.200.0", &zip_of(&[("../evil.html", "x"), ("index.html", "n"), ("app-build.json", BUILD)])).is_err());
        assert!(!dir.parent().unwrap().join("evil.html").exists());
        assert!(i.install("../x", b"").is_err());
        assert!(i.install("2.200.0", b"not a zip").is_err());
        assert!(i.apply("2.999.0").is_err(), "only an installed interface");
        assert!(i.list().is_empty(), "nothing half-unpacked is left");
        let _ = fs::remove_dir_all(dir);
    }
}
