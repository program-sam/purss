//! Windows makes a window's taskbar button again each time the window is shown from the tray, and announces it with
//! the `TaskbarButtonCreated` message; only then can the button take an overlay. The window's messages pass through
//! here first, and that one puts the new items' overlay back on the button.

use crate::{Badge, MAIN};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW;

static BUTTON_CREATED: OnceLock<u32> = OnceLock::new();

pub fn watch(app: &AppHandle) {
    let Some(hwnd) = app.get_window(MAIN).and_then(|w| w.hwnd().ok()) else { return };
    // SAFETY: registering a message name has no preconditions.
    let message = *BUTTON_CREATED.get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) });
    if message == 0 {
        return;
    }
    // The handle lives as long as the window, which is as long as the app: it is never freed.
    let data = Box::into_raw(Box::new(app.clone())) as usize;
    // SAFETY: the window belongs to this thread (setup runs on the main thread), and `data` stays valid forever.
    unsafe {
        let _ = SetWindowSubclass(HWND(hwnd.0), Some(on_message), 1, data);
    }
}

unsafe extern "system" fn on_message(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, data: usize) -> LRESULT {
    if Some(&message) == BUTTON_CREATED.get() {
        // SAFETY: `data` is the AppHandle `watch` leaked for this purpose.
        let app = unsafe { &*(data as *const AppHandle) };
        if let (Some(w), Some(badge)) = (app.get_window(MAIN), app.try_state::<Badge>()) {
            badge.apply(&w);
        }
    }
    // SAFETY: passes the message on unchanged.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
