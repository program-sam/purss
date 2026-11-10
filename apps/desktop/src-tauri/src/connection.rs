//! The device token (plan/24) in the system's credential store: the macOS Keychain, Windows Credential Manager,
//! the Secret Service on Linux. A Linux desktop without a Secret Service gets a file in the app's config folder that
//! only this user can read, and Settings → This device says so. Never in the page's storage.
//!
//! A credential store can keep a call waiting (a wallet asking to be created or unlocked): each call is given
//! `WAIT` and then counts as no store, so signing in never hangs.

use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "app.purss";
const ACCOUNT: &str = "connection";
const WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Run a credential-store call on its own thread; None when it didn't answer in time.
fn waited<T: Send + 'static>(call: impl FnOnce(&keyring::Entry) -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
            let _ = tx.send(call(&entry));
        }
    });
    rx.recv_timeout(WAIT).ok()
}

/// The credential store, as this module uses it (a trait so tests can make it unavailable).
pub trait Vault: Send + Sync {
    /// The stored value; None when the store didn't answer in time.
    fn get(&self) -> Option<Result<String, keyring::Error>>;
    /// Store and read back; false when that didn't work.
    fn set(&self, value: &str) -> bool;
    fn delete(&self) -> Option<Result<(), keyring::Error>>;
    /// No write that outlived its wait is still running (it could still store a value later).
    fn settled(&self) -> bool;
}

/// The system's credential store, through the `keyring` crate. Counts writes still running.
#[derive(Default)]
pub struct SystemVault(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Vault for SystemVault {
    fn get(&self) -> Option<Result<String, keyring::Error>> {
        waited(|e| e.get_password())
    }
    fn set(&self, value: &str) -> bool {
        use std::sync::atomic::Ordering;
        let value = value.to_string();
        let running = self.0.clone();
        running.fetch_add(1, Ordering::SeqCst);
        waited(move |e| {
            let kept = e.set_password(&value).is_ok() && e.get_password().ok() == Some(value);
            running.fetch_sub(1, Ordering::SeqCst);
            kept
        })
        .unwrap_or(false)
    }
    fn delete(&self) -> Option<Result<(), keyring::Error>> {
        waited(|e| e.delete_credential())
    }
    fn settled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst) == 0
    }
}

pub struct ConnectionStore {
    vault: Box<dyn Vault>,
    /// One read, save or forget at a time, so no write of this store starts during another's checks.
    ops: std::sync::Mutex<()>,
    file: PathBuf,
    /// Present while the credential store may hold a connection that must not be used: one a disconnection couldn't
    /// confirm removing (locked, not answering), or an older one when the newest is kept in the file. Its removal is
    /// tried at every read; storing a new connection in the store ends it.
    forgotten: PathBuf,
}

impl ConnectionStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self::with_vault(config_dir, Box::new(SystemVault::default()))
    }

    pub fn with_vault(config_dir: PathBuf, vault: Box<dyn Vault>) -> Self {
        ConnectionStore { vault, ops: std::sync::Mutex::new(()), file: config_dir.join("connection.json"), forgotten: config_dir.join("connection-forgotten") }
    }

    /// The connection: from the file while the store's entry is suppressed (see `forgotten`), else from the store,
    /// else from the file.
    pub fn read(&self) -> Option<String> {
        let _one = self.ops.lock().unwrap();
        if self.forgotten.exists() {
            if self.cleared() {
                let _ = fs::remove_file(&self.forgotten);
            }
            return fs::read_to_string(&self.file).ok();
        }
        if let Some(Ok(v)) = self.vault.get() {
            return Some(v);
        }
        fs::read_to_string(&self.file).ok()
    }

    /// Kept in the credential store when there is one (then the file goes, and nothing is suppressed any more); else in
    /// the file, and whatever the store may still hold from before is suppressed, so it can never come back instead.
    pub fn save(&self, json: &str) -> Result<(), String> {
        let _one = self.ops.lock().unwrap();
        if self.vault.set(json) {
            // Only once nothing older can be read instead of it: the file, and the suppression of the store's entry.
            return gone(&self.file).and_then(|_| gone(&self.forgotten)).map_err(|e| format!("The connection couldn't be kept on this computer: {e}"));
        }
        write_private(&self.file, json).map_err(|e| format!("The connection couldn't be kept on this computer: {e}"))?;
        self.suppress().map_err(|e| format!("The connection couldn't be kept on this computer: {e}"))
    }

    /// Remove the connection: the file, and the store's entry. When the store doesn't confirm its entry is gone, the
    /// entry is suppressed (never used again, its removal tried again at every start); fails only when even that can't
    /// be recorded.
    pub fn forget(&self) -> Result<(), String> {
        let _one = self.ops.lock().unwrap();
        let confirmed = self.cleared();
        gone(&self.file).map_err(|e| e.to_string())?;
        if confirmed {
            let _ = fs::remove_file(&self.forgotten);
            Ok(())
        } else {
            self.suppress().map_err(|_| "The credential store couldn't remove the connection.".to_string())
        }
    }

    /// No earlier write can still put a connection in the store (checked first: with `ops` held no new one starts),
    /// and the store confirms it holds none.
    fn cleared(&self) -> bool {
        self.vault.settled() && matches!(self.vault.delete(), Some(Ok(()) | Err(keyring::Error::NoEntry)))
    }

    fn suppress(&self) -> std::io::Result<()> {
        if let Some(dir) = self.forgotten.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.forgotten, "")
    }

    /// Where the connection is kept now: "file" only when the fallback file holds it.
    pub fn kind(&self) -> &'static str {
        if self.file.is_file() { "file" } else { "system" }
    }
}

/// Remove a file; fine when it isn't there.
fn gone(path: &PathBuf) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn write_private(path: &PathBuf, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    fs::rename(&tmp, path)
}

#[cfg(not(unix))]
fn write_private(path: &PathBuf, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A store that can be taken away (locked, no Secret Service) and given back.
    /// (stored value, available, a timed-out write still running)
    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<(Option<String>, bool, bool)>>);

    impl Fake {
        fn available(&self, on: bool) {
            self.0.lock().unwrap().1 = on;
        }
    }

    impl Vault for Fake {
        fn get(&self) -> Option<Result<String, keyring::Error>> {
            let s = self.0.lock().unwrap();
            Some(if !s.1 { Err(keyring::Error::NoStorageAccess("locked".into())) } else { s.0.clone().ok_or(keyring::Error::NoEntry) })
        }
        fn set(&self, value: &str) -> bool {
            let mut s = self.0.lock().unwrap();
            if s.1 {
                s.0 = Some(value.to_string());
            }
            s.1
        }
        fn delete(&self) -> Option<Result<(), keyring::Error>> {
            let mut s = self.0.lock().unwrap();
            Some(if !s.1 { Err(keyring::Error::NoStorageAccess("locked".into())) } else if s.0.take().is_some() { Ok(()) } else { Err(keyring::Error::NoEntry) })
        }
        fn settled(&self) -> bool {
            !self.0.lock().unwrap().2
        }
    }

    fn setup() -> (ConnectionStore, Fake, PathBuf) {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let dir = std::env::temp_dir().join(format!("purss-conn-{}", u64::from_le_bytes(b)));
        let fake = Fake::default();
        fake.available(true);
        (ConnectionStore::with_vault(dir.clone(), Box::new(fake.clone())), fake, dir)
    }

    #[test]
    fn a_disconnection_the_store_cant_confirm_never_comes_back() {
        let (store, fake, dir) = setup();
        store.save("old").unwrap();
        assert_eq!(store.kind(), "system");
        fake.available(false);
        store.forget().unwrap();
        assert_eq!(store.read(), None);
        fake.available(true);
        assert_eq!(store.read(), None, "unlocking the store doesn't bring it back");
        assert_eq!(fake.0.lock().unwrap().0, None, "and it was removed then");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_newer_connection_in_the_file_wins_over_an_older_one_in_the_store() {
        let (store, fake, dir) = setup();
        store.save("old").unwrap();
        fake.available(false);
        store.save("new").unwrap();
        assert_eq!(store.kind(), "file");
        assert_eq!(store.read().as_deref(), Some("new"));
        fake.available(true);
        assert_eq!(store.read().as_deref(), Some("new"), "the old one in the store stays suppressed");
        fake.available(false);
        store.forget().unwrap();
        fake.available(true);
        assert_eq!(store.read(), None, "forgetting the file one leaves nothing to come back");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_write_that_outlived_its_wait_can_never_bring_a_forgotten_connection_back() {
        let (store, fake, dir) = setup();
        // The write timed out (counts as no store: the file), but is still running.
        fake.0.lock().unwrap().2 = true;
        fake.available(false);
        store.save("token").unwrap();
        fake.available(true);
        store.forget().unwrap();
        // The late write lands now.
        {
            let mut s = fake.0.lock().unwrap();
            s.0 = Some("token".into());
            s.2 = false;
        }
        assert_eq!(store.read(), None, "still suppressed, and removed now that the write has settled");
        assert_eq!(fake.0.lock().unwrap().0, None);
        let _ = fs::remove_dir_all(dir);
    }

    /// A vault whose delete lets a timed-out write land right after it (the write settles then).
    #[derive(Clone, Default)]
    struct LandsAfterDelete(Fake);

    impl Vault for LandsAfterDelete {
        fn get(&self) -> Option<Result<String, keyring::Error>> {
            self.0.get()
        }
        fn set(&self, v: &str) -> bool {
            self.0.set(v)
        }
        fn delete(&self) -> Option<Result<(), keyring::Error>> {
            let out = self.0.delete();
            let mut s = self.0 .0.lock().unwrap();
            if s.2 {
                s.0 = Some("late".into());
                s.2 = false;
            }
            out
        }
        fn settled(&self) -> bool {
            self.0.settled()
        }
    }

    #[test]
    fn a_write_landing_just_after_the_delete_is_still_suppressed_on_forget_and_on_read() {
        for via_read in [false, true] {
            let (_, _, dir) = setup();
            let vault = LandsAfterDelete::default();
            vault.0.available(true);
            let store = ConnectionStore::with_vault(dir.clone(), Box::new(vault.clone()));
            vault.0 .0.lock().unwrap().2 = true;
            if via_read {
                store.suppress().unwrap();
                assert_eq!(store.read(), None);
            } else {
                store.forget().unwrap();
            }
            assert!(dir.join("connection-forgotten").exists(), "suppression kept while a write was still running");
            assert_eq!(store.read(), None, "not used while it may still land");
            assert!(dir.join("connection-forgotten").exists());
            {
                // The late write lands and settles.
                let mut st = vault.0 .0.lock().unwrap();
                st.0 = Some("late".into());
                st.2 = false;
            }
            assert_eq!(store.read(), None, "the late write is never used, and removed now");
            assert_eq!(vault.0 .0.lock().unwrap().0, None);
            assert!(!dir.join("connection-forgotten").exists());
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_save_that_cant_clear_what_is_older_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let (store, fake, dir) = setup();
        fake.available(false);
        store.save("old").unwrap();
        fake.available(true);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let saved = store.save("new");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(saved.is_err(), "the older connection in the file couldn't be removed");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_save_keeps_the_suppression() {
        let (store, fake, dir) = setup();
        store.save("old").unwrap();
        fake.available(false);
        store.forget().unwrap();
        // The file can't be written either: a folder is in its place.
        fs::create_dir_all(dir.join("connection.json")).unwrap();
        assert!(store.save("new").is_err());
        fake.available(true);
        fs::remove_dir_all(dir.join("connection.json")).unwrap();
        assert_eq!(store.read(), None);
        store.save("new").unwrap();
        assert_eq!(store.read().as_deref(), Some("new"));
        let _ = fs::remove_dir_all(dir);
    }
}
