//! The desktop app (plan/42): the web app's interface in a Tauri window, with the few things only a desktop app
//! can do. Every power the page has is one of the commands below, and each checks its own arguments; no plugin is
//! reachable from the page (capabilities/main.json allows only listening to events).
//!
//! Closing the window hides it: the page keeps running in the tray, so the event stream, notifications and
//! automatic downloads go on until the person quits from the tray icon.

mod connection;
mod files;
mod incoming;
mod interfaces;

use connection::ConnectionStore;
use files::Files;
use incoming::{Incoming, Queue};
use interfaces::{Build, DiskOrEmbedded, InterfaceRef, Interfaces, NoAssets};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const MAIN: &str = "main";
/// Started at sign-in: stay in the tray.
const HIDDEN_ARG: &str = "--hidden";
/// How often the app looks for a new version of itself.
const UPDATE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

static QUITTING: AtomicBool = AtomicBool::new(false);

/// The AppImage this app runs from, if it does. `APPIMAGE` alone isn't proof: an app started from a program that is an
/// AppImage inherits the variable, so the app itself must be running inside that AppImage's mount (`APPDIR`).
pub fn appimage() -> Option<std::path::PathBuf> {
    let image = std::env::var_os("APPIMAGE")?;
    let dir = std::env::var_os("APPDIR")?;
    let exe = std::env::current_exe().ok()?;
    exe.starts_with(&dir).then(|| image.into())
}

/// A list of paths (`PATH`, `LD_LIBRARY_PATH`, …) without those inside `dir`; None when nothing else is left.
fn without_dir(value: &str, dir: &str) -> Option<String> {
    let inside = |p: &str| p == dir || p.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'));
    let kept: Vec<&str> = value.split(':').filter(|p| !p.is_empty() && !inside(p)).collect();
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// Before this AppImage starts the next version: take its own mount out of the environment its runtime filled in
/// (`PATH`, `LD_LIBRARY_PATH`, the GTK and GIO module paths, …), and keep the next version from inheriting what the runtime
/// handed this one (a handle on the mount, the pipe the runtime waits on). Otherwise this AppImage's runtime keeps running
/// for as long as the next version does.
fn leave_appimage() {
    if appimage().is_none() {
        return;
    }
    let Some(dir) = std::env::var("APPDIR").ok() else { return };
    for (key, value) in std::env::vars() {
        if value.contains(&dir) {
            match without_dir(&value, &dir) {
                Some(v) => std::env::set_var(&key, v),
                None => std::env::remove_var(&key),
            }
        }
    }
    // The next version needs only standard input and output; this process exits right after starting it.
    #[cfg(target_os = "linux")]
    for fd in std::fs::read_dir("/proc/self/fd").into_iter().flatten().flatten().filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok()) {
        if fd > 2 {
            // SAFETY: only sets the close-on-exec flag; a descriptor that isn't open just fails.
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
    }
}

pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---- The connection -------------------------------------------------------------------------------------------

#[tauri::command]
async fn connection_read(store: State<'_, ConnectionStore>) -> Result<Option<String>, String> {
    Ok(store.read())
}

#[tauri::command]
async fn connection_save(json: String, store: State<'_, ConnectionStore>) -> Result<(), String> {
    if json.len() > 4096 {
        return Err("too long".into());
    }
    store.save(&json)
}

#[tauri::command]
async fn connection_forget(store: State<'_, ConnectionStore>) -> Result<(), String> {
    store.forget()
}

#[tauri::command]
async fn credential_store(store: State<'_, ConnectionStore>) -> Result<&'static str, String> {
    Ok(store.kind())
}

/// The name your PURSS shows for this computer: its host name and system.
#[tauri::command]
fn device_name() -> String {
    let os = if cfg!(target_os = "macos") { "Mac" } else if cfg!(windows) { "Windows" } else { "Linux" };
    let host = gethostname::gethostname().to_string_lossy().trim().to_string();
    let host: String = host.chars().filter(|c| !c.is_control()).take(60).collect();
    if host.is_empty() { format!("{os} computer") } else { format!("{host} ({os})") }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---- Links, files and notifications ---------------------------------------------------------------------------

/// Open an address in the default browser: http(s) only.
#[tauri::command]
fn open_external(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "not an address".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("only web addresses open in the browser".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

/// Save a file the person asked for (an export) where they choose. False when they cancelled.
#[tauri::command]
async fn save_file(request: Request<'_>, app: AppHandle) -> Result<bool, String> {
    let InvokeBody::Raw(data) = request.body() else { return Err("expected the file's bytes".into()) };
    let name = request.headers().get("x-purss-name").and_then(|v| v.to_str().ok()).and_then(|v| percent_decode(v)).unwrap_or_else(|| "export".into());
    let name: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':')).take(120).collect();
    let data = data.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(&name).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(false) };
    std::fs::write(path, data).map_err(|e| format!("The file couldn't be saved: {e}"))?;
    Ok(true)
}

fn percent_decode(s: &str) -> Option<String> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[derive(Serialize, Clone)]
struct Click {
    tag: String,
}

/// A system notification. Clicking it shows the window and tells the page which one it was (Linux: the
/// notification's default action; Windows and macOS start or focus the app, which shows the window).
#[tauri::command]
fn notify(tag: String, title: String, body: Option<String>, app: AppHandle) {
    show_notification(&app, tag, title, body);
}

fn show_notification(app: &AppHandle, tag: String, title: String, body: Option<String>) {
    let app = app.clone();
    let title: String = title.chars().take(200).collect();
    let body: Option<String> = body.map(|b| b.chars().take(500).collect());
    #[cfg(target_os = "linux")]
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.appname("PURSS").summary(&title).icon("purss").action("default", "Open");
        if let Some(b) = &body {
            n.body(b);
        }
        if let Ok(handle) = n.show() {
            handle.wait_for_action(|action| {
                if action == "default" {
                    show_window(&app);
                    let _ = app.emit("purss://notification-click", Click { tag: tag.clone() });
                }
            });
        }
    });
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = tag;
        let mut n = app.notification().builder().title(title);
        if let Some(b) = body {
            n = n.body(b);
        }
        let _ = n.show();
    }
}

/// The bell's unread count on the dock or launcher icon (macOS, Linux launchers that support it) and in the tray's tooltip.
#[tauri::command]
fn set_badge(count: u32, app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
    if let Some(tray) = app.tray_by_id(MAIN) {
        let tip = match count {
            0 => "PURSS".to_string(),
            1 => "PURSS: 1 new notification".to_string(),
            n => format!("PURSS: {n} new notifications"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[tauri::command]
fn take_incoming(queue: State<'_, Queue>) -> Vec<Incoming> {
    std::mem::take(&mut *queue.0.lock().unwrap())
}

// ---- Downloads ------------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct Progress {
    bytes: u64,
    total: u64,
}

#[tauri::command]
async fn files_download(id: String, url: String, path: String, max_bytes: Option<u64>, on_progress: tauri::ipc::Channel<Progress>, files: State<'_, Arc<Files>>) -> Result<u64, String> {
    let _shared = files.shared().await;
    files.download(id, url, path, max_bytes, |bytes, total| { let _ = on_progress.send(Progress { bytes, total }); }).await
}

#[tauri::command]
fn files_cancel(id: String, files: State<'_, Arc<Files>>) {
    files.cancel(&id);
}

#[tauri::command]
async fn files_list(path: String, files: State<'_, Arc<Files>>) -> Result<Vec<String>, String> {
    let _shared = files.shared().await;
    files.list(&path)
}

#[tauri::command]
async fn files_write_text(path: String, text: String, files: State<'_, Arc<Files>>) -> Result<u64, String> {
    let _shared = files.shared().await;
    files.write_text(&path, &text)
}

#[tauri::command]
async fn files_read_text(path: String, files: State<'_, Arc<Files>>) -> Result<Option<String>, String> {
    let _shared = files.shared().await;
    Ok(files.read(&path).map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[tauri::command]
async fn files_read_bytes(path: String, files: State<'_, Arc<Files>>) -> Result<Response, String> {
    let _shared = files.shared().await;
    files.read(&path).map(Response::new).ok_or_else(|| "not there".into())
}

#[tauri::command]
async fn files_remove(path: String, files: State<'_, Arc<Files>>) -> Result<(), String> {
    let _shared = files.shared().await;
    files.remove(&path)
}

#[tauri::command]
fn files_media_base(files: State<'_, Arc<Files>>) -> String {
    files.media_base()
}

#[tauri::command]
async fn files_folder(files: State<'_, Arc<Files>>) -> Result<String, String> {
    files.root().map(|p| p.display().to_string())
}

/// Let the person choose a folder (a system dialog, opened here); the downloads move to `PURSS` in it.
#[tauri::command]
async fn files_choose_folder(app: AppHandle, files: State<'_, Arc<Files>>) -> Result<Option<String>, String> {
    let start = files.root().ok().and_then(|r| r.parent().map(|p| p.to_path_buf()));
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = dialog.dialog().file().set_title("Choose where to keep downloads");
        if let Some(dir) = start {
            d = d.set_directory(dir);
        }
        d.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(parent) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let files = files.inner().clone();
    let moved = tauri::async_runtime::spawn_blocking(move || files.move_to(parent)).await.map_err(|e| e.to_string())??;
    Ok(moved.map(|p| p.display().to_string()))
}

#[tauri::command]
async fn files_show_folder(app: AppHandle, files: State<'_, Arc<Files>>) -> Result<(), String> {
    let root = files.root()?;
    app.opener().open_path(root.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

// ---- The interface (plan/39) ----------------------------------------------------------------------------------

#[tauri::command]
fn interface_builtin(i: State<'_, Interfaces>) -> String {
    i.builtin_version()
}

#[tauri::command]
fn interface_current(i: State<'_, Interfaces>) -> InterfaceRef {
    i.current()
}

#[tauri::command]
async fn interface_install(request: Request<'_>, i: State<'_, Interfaces>) -> Result<InterfaceRef, String> {
    let InvokeBody::Raw(zip) = request.body() else { return Err("expected the zip's bytes".into()) };
    let version = request.headers().get("x-purss-version").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    i.install(&version, zip)
}

#[tauri::command]
fn interface_list(i: State<'_, Interfaces>) -> Vec<InterfaceRef> {
    i.list()
}

#[tauri::command]
fn interface_remove(id: String, i: State<'_, Interfaces>) -> Result<(), String> {
    i.remove(&id)
}

/// Switch to an interface; the page reloads at the root, served from it.
#[tauri::command]
fn interface_apply<R: Runtime>(id: String, i: State<'_, Interfaces>, window: tauri::WebviewWindow<R>) -> Result<(), String> {
    i.apply(&id)?;
    window.eval("location.replace('/')").map_err(|e| e.to_string())
}

#[tauri::command]
fn interface_failed(i: State<'_, Interfaces>) -> Option<String> {
    i.take_failed()
}

#[tauri::command]
fn interface_ready(i: State<'_, Interfaces>) {
    i.ready();
}

// ---- The app's own updates ------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "state", rename_all = "lowercase")]
enum UpdateState {
    None,
    Downloading { version: String },
    Ready { version: String },
    Failed { detail: String },
}

#[derive(Default)]
struct AppUpdate {
    state: Mutex<Option<UpdateState>>,
    ready: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

fn set_update(app: &AppHandle, state: UpdateState) {
    *app.state::<AppUpdate>().state.lock().unwrap() = Some(state.clone());
    let _ = app.emit("purss://app-update", state);
}

/// Where a downloaded version waits to be installed, as `<version>.bin`: kept on disk, so a version the person never
/// installed (the computer shut down with the app running) is installed at the next start rather than downloaded again.
fn pending_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("update"))
}

fn pending_file(dir: &std::path::Path, version: &str) -> Option<std::path::PathBuf> {
    let plain = !version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    plain.then(|| dir.join(format!("{version}.bin")))
}

/// Remove every waiting version but `keep`.
fn tidy_pending(dir: &std::path::Path, keep: Option<&std::path::Path>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if Some(entry.path().as_path()) != keep {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn keep_pending(dir: &std::path::Path, file: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let part = file.with_extension("part");
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, file)?;
    tidy_pending(dir, Some(file));
    Ok(())
}

/// Look for a new version now and then; download it in the background, to be installed at the next restart. A version
/// downloaded by an earlier run and never installed is installed as soon as this run finds it is still the newest.
fn watch_updates(app: AppHandle) {
    // A development build or one without a version (plan/40) never updates itself.
    if cfg!(debug_assertions) || app.package_info().version.major == 0 {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let dir = pending_dir(&app);
        let mut starting = true;
        loop {
            let ready_version = app.state::<AppUpdate>().ready.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
            match async { app.updater()?.check().await }.await {
                Ok(Some(update)) => {
                    let file = dir.as_deref().and_then(|d| pending_file(d, &update.version));
                    if starting {
                        if let Some(bytes) = file.as_deref().and_then(|f| std::fs::read(f).ok()) {
                            // install() checks the signature again; a file that fails is removed and downloaded anew.
                            match update.install(&bytes) {
                                Ok(()) => {
                                    leave_appimage();
                                    app.restart()
                                }
                                Err(_) => {
                                    if let Some(f) = &file {
                                        let _ = std::fs::remove_file(f);
                                    }
                                }
                            }
                        }
                    }
                    if ready_version.as_deref() != Some(update.version.as_str()) {
                        set_update(&app, UpdateState::Downloading { version: update.version.clone() });
                        match update.download(|_, _| {}, || {}).await {
                            Ok(bytes) => {
                                if let (Some(d), Some(f)) = (&dir, &file) {
                                    let _ = keep_pending(d, f, &bytes);
                                }
                                let version = update.version.clone();
                                *app.state::<AppUpdate>().ready.lock().unwrap() = Some((update, bytes));
                                set_update(&app, UpdateState::Ready { version: version.clone() });
                                announce_ready(&app, &version);
                            }
                            Err(e) => set_update(&app, UpdateState::Failed { detail: format!("{e}.") }),
                        }
                    }
                }
                // Up to date: whatever waits on disk was installed, or is no longer the newest.
                Ok(None) => {
                    if let Some(d) = &dir {
                        tidy_pending(d, None);
                    }
                }
                Err(_) => {}
            }
            starting = false;
            tokio::time::sleep(UPDATE_EVERY).await;
        }
    });
}

/// Say that a new version is ready: a notification, and *Restart to update* at the top of the tray's menu.
fn announce_ready(app: &AppHandle, version: &str) {
    show_notification(
        app,
        "app-update".into(),
        "A new version of PURSS is ready".into(),
        Some(format!("Version {version} is installed when you restart the app, or when you quit it from the tray.")),
    );
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(MAIN), tray_menu(app, Some(version))) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// The tray's menu; with a downloaded version, *Restart to update* first.
fn tray_menu<R: Runtime, M: Manager<R>>(app: &M, ready: Option<&str>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Open PURSS", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    match ready {
        Some(version) => {
            let restart = MenuItem::with_id(app, "restart", format!("Restart to update to {version}"), true, None::<&str>)?;
            Menu::with_items(app, &[&restart, &PredefinedMenuItem::separator(app)?, &open, &quit_item])
        }
        None => Menu::with_items(app, &[&open, &quit_item]),
    }
}

/// Install the downloaded version, if there is one. True when it was installed. `restart`: start the new version
/// (Windows' installer otherwise starts it by itself, which quitting must not do).
fn install_update(app: &AppHandle, restart: bool) -> Result<bool, String> {
    let Some((update, bytes)) = app.state::<AppUpdate>().ready.lock().unwrap().take() else { return Ok(false) };
    update.restart_after_install(restart).install(bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn app_update_state(u: State<'_, AppUpdate>) -> UpdateState {
    u.state.lock().unwrap().clone().unwrap_or(UpdateState::None)
}

#[tauri::command]
fn app_update_restart(app: AppHandle) -> Result<(), String> {
    match install_update(&app, true) {
        Ok(true) => {
            leave_appimage();
            app.restart()
        }
        Ok(false) => Ok(()),
        Err(e) => {
            set_update(&app, UpdateState::Failed { detail: format!("{e}.") });
            Err(e)
        }
    }
}

fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    let _ = install_update(app, false);
    app.exit(0);
}

// ---- Starting at sign-in --------------------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod autostart {
    //! A `.desktop` file in ~/.config/autostart that starts the app hidden. Written here rather than by a plugin so
    //! that an AppImage starts from the AppImage itself, not from the folder it is mounted on.
    use std::path::PathBuf;

    fn file() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(config.join("autostart").join("purss.desktop"))
    }

    pub fn enabled() -> bool {
        file().is_some_and(|f| f.is_file())
    }

    pub fn set(on: bool) -> Result<(), String> {
        let f = file().ok_or("no config folder")?;
        if !on {
            return match std::fs::remove_file(&f) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let exe = super::appimage().or_else(|| std::env::current_exe().ok()).ok_or("the app's location is unknown")?;
        let exe = exe.display().to_string().replace('\\', "\\\\").replace('"', "\\\"");
        std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
        let text = format!("[Desktop Entry]\nType=Application\nName=PURSS\nExec=\"{exe}\" {}\nIcon=purss\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n", super::HIDDEN_ARG);
        std::fs::write(&f, text).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        autostart::enabled()
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    }
}

#[tauri::command]
fn autostart_set(on: bool, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        autostart::set(on)
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let l = app.autolaunch();
        if on { l.enable() } else { l.disable() }.map_err(|e| e.to_string())
    }
}

// ---- The app --------------------------------------------------------------------------------------------------

fn read_builtin_build(ctx: &tauri::Context) -> Option<Build> {
    let bytes = ctx.assets().get(&"app-build.json".into())?;
    serde_json::from_slice(&bytes).ok()
}

pub fn run() {
    // Variables inherited from an AppImage that started this app (when it isn't one itself) would make the updater
    // and restarts treat that other program as this one. Removed before any thread starts.
    if appimage().is_none() {
        std::env::remove_var("APPIMAGE");
        std::env::remove_var("APPDIR");
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut ctx = tauri::generate_context!();
    let interfaces = Interfaces::new(read_builtin_build(&ctx));
    let embedded = ctx.set_assets(Box::new(NoAssets));
    ctx.set_assets(Box::new(DiskOrEmbedded { interfaces: interfaces.clone(), embedded }));
    let args: Vec<String> = std::env::args().skip(1).collect();
    let hidden = args.iter().any(|a| a == HIDDEN_ARG);

    let builder = tauri::Builder::default()
        // A second start hands its links and files to this one and shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            incoming::from_args(app, &argv.into_iter().skip(1).collect::<Vec<_>>(), false);
            show_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os = "linux"))]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])));

    let rollback = interfaces.clone();
    let app = builder
        .manage(interfaces.clone())
        .manage(Queue::default())
        .manage(AppUpdate::default())
        .invoke_handler(tauri::generate_handler![
            connection_read, connection_save, connection_forget, credential_store, device_name, app_version,
            open_external, save_file, notify, set_badge, take_incoming,
            files_download, files_cancel, files_list, files_write_text, files_read_text, files_read_bytes, files_remove,
            files_media_base, files_folder, files_choose_folder, files_show_folder,
            interface_builtin, interface_current, interface_install, interface_list, interface_remove, interface_apply,
            interface_failed, interface_ready,
            app_update_state, app_update_restart, autostart_get, autostart_set,
        ])
        // An interface switched to must report that it started; otherwise the previous one comes back (plan/39).
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished || !rollback.on_trial() {
                return;
            }
            let interfaces = rollback.clone();
            let webview = webview.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(interfaces::READY_WITHIN_SECS)).await;
                if interfaces.roll_back() {
                    let _ = webview.eval("location.replace('/')");
                }
            });
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let data = app.path().app_data_dir()?;
            let config = app.path().app_config_dir()?;
            interfaces.open(data.join("interfaces"), &app.package_info().version.to_string());
            app.manage(ConnectionStore::new(config.clone()));
            let default_parent = app.path().download_dir().unwrap_or_else(|_| data.clone());
            let files = Arc::new(Files::new(&config, default_parent));
            files.serve()?;
            app.manage(files);

            let menu = tray_menu(app, None)?;
            let mut tray = TrayIconBuilder::with_id(MAIN).tooltip("PURSS").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, e| match e.id.as_ref() {
                "open" => show_window(app),
                "quit" => quit(app),
                "restart" => {
                    let _ = app_update_restart(app.clone());
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show_window(tray.app_handle());
                }
            })
            .build(app)?;

            // Links (and, on macOS, opened files) while running; on Windows and Linux, the ones that started the app come as arguments.
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if url.scheme() == "file" {
                        if let Some(file) = url.to_file_path().ok().and_then(|p| incoming::as_file(&p.display().to_string())) {
                            incoming::deliver(&links, file);
                        }
                    } else if let Some(link) = incoming::as_link(url.as_str()) {
                        incoming::deliver(&links, Incoming::Url { url: link });
                    }
                }
            });
            #[cfg(any(target_os = "linux", windows))]
            {
                // An AppImage (and a development build) registers its link schemes itself; the installers do it otherwise.
                if cfg!(debug_assertions) || appimage().is_some() {
                    let _ = app.deep_link().register_all();
                }
                incoming::from_args(&handle, &args, true);
            }
            if !hidden {
                show_window(&handle);
            }
            watch_updates(handle);
            Ok(())
        })
        .build(ctx)
        .expect("the desktop app couldn't start");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_window(app);
        }
        let _ = (app, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_dir_drops_only_the_mount() {
        let dir = "/tmp/.mount_PURSS.ab12";
        assert_eq!(without_dir("/tmp/.mount_PURSS.ab12/usr/bin/:/usr/local/bin:/usr/bin", dir), Some("/usr/local/bin:/usr/bin".into()));
        assert_eq!(without_dir("/tmp/.mount_PURSS.ab12/usr/lib/:/tmp/.mount_PURSS.ab12/usr/lib32/", dir), None);
        assert_eq!(without_dir("/tmp/.mount_PURSS.ab12", dir), None);
        assert_eq!(without_dir("/tmp/.mount_PURSS.ab12x/usr/lib:/opt/lib", dir), Some("/tmp/.mount_PURSS.ab12x/usr/lib:/opt/lib".into()), "another mount whose name starts the same");
        assert_eq!(without_dir("/usr/share::/tmp/.mount_PURSS.ab12/usr/share", dir), Some("/usr/share".into()));
    }

    #[test]
    fn pending_file_takes_only_plain_versions() {
        let dir = std::path::Path::new("/cache/update");
        assert_eq!(pending_file(dir, "26.315.32"), Some(dir.join("26.315.32.bin")));
        assert_eq!(pending_file(dir, "1.0.0-rc.1+b2"), Some(dir.join("1.0.0-rc.1+b2.bin")));
        assert_eq!(pending_file(dir, "../26.315.32"), None);
        assert_eq!(pending_file(dir, "26/315"), None);
        assert_eq!(pending_file(dir, ""), None);
    }

    #[test]
    fn a_kept_version_replaces_the_others_and_up_to_date_removes_it() {
        let dir = std::env::temp_dir().join(format!("purss-pending-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let old = pending_file(&dir, "26.315.24").unwrap();
        keep_pending(&dir, &old, b"old").unwrap();
        let new = pending_file(&dir, "26.315.32").unwrap();
        keep_pending(&dir, &new, b"new").unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("26.315.32.bin")]);
        assert_eq!(std::fs::read(&new).unwrap(), b"new");
        tidy_pending(&dir, None);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
