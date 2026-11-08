//! Native Windows Event Watcher for Inex Island.
//!
//! Replaces all polling with 100% native Windows event-driven callbacks:
//!   1. WTSRegisterSessionNotification -> WM_WTSSESSION_CHANGE (Lock / Unlock)
//!   2. AddClipboardFormatListener    -> WM_CLIPBOARDUPDATE   (Clipboard Copy)
//!   3. WM_POWERBROADCAST             -> Power / Battery / Charger events
//!   4. WH_KEYBOARD_LL                -> Caps Lock & Num Lock key events
//!   5. SetWinEventHook               -> Fullscreen (Smart Mode) & PIN/Password prompts
//!
//! Result: 0.0% CPU when idle!

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CAPITAL, VK_NUMLOCK};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetClassNameW, GetWindowThreadProcessId,
    HHOOK, KBDLLHOOKSTRUCT, WH_KEYBOARD_LL, WM_KEYUP,
};

#[link(name = "wtsapi32")]
extern "system" {
    fn WTSRegisterSessionNotification(hwnd: isize, flags: u32) -> i32;
    #[allow(dead_code)]
    fn WTSUnRegisterSessionNotification(hwnd: isize) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn AddClipboardFormatListener(hwnd: isize) -> i32;
    #[allow(dead_code)]
    fn RemoveClipboardFormatListener(hwnd: isize) -> i32;
    fn SetWindowsHookExW(
        id_hook: i32,
        lpfn: unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT,
        hmod: isize,
        dw_thread_id: u32,
    ) -> isize;
    fn UnhookWindowsHookEx(hhk: isize) -> i32;
    fn SetWinEventHook(
        event_min: u32,
        event_max: u32,
        hmod_win_event_proc: isize,
        pfn_win_event_proc: unsafe extern "system" fn(isize, u32, HWND, i32, i32, u32, u32),
        id_process: u32,
        id_thread: u32,
        dw_flags: u32,
    ) -> isize;
    fn UnhookWinEvent(h_win_event_hook: isize) -> i32;
}

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(
        hwnd: HWND,
        pfn_subclass: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM, usize, usize) -> LRESULT,
        u_id_subclass: usize,
        dw_ref_data: usize,
    ) -> BOOL;
    fn DefSubclassProc(hwnd: HWND, u_msg: u32, w_param: WPARAM, l_param: LPARAM) -> LRESULT;
}

const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;
const NOTIFY_FOR_THIS_SESSION: u32 = 0;

const WM_CLIPBOARDUPDATE: u32 = 0x031D;
const WM_POWERBROADCAST: u32 = 0x0218;
const PBT_APMPOWERSTATUSCHANGE: usize = 0x000A;
const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
const PBT_APMRESUMESUSPEND: usize = 0x0007;

const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
const WINEVENT_SKIPOWNPROCESS: u32 = 2;

static GLOBAL_APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static KBD_HOOK: AtomicIsize = AtomicIsize::new(0);
static WIN_HOOK: AtomicIsize = AtomicIsize::new(0);

static LAST_CAPS: AtomicBool = AtomicBool::new(false);
static LAST_NUM: AtomicBool = AtomicBool::new(false);
static LAST_FS: AtomicBool = AtomicBool::new(false);
static LAST_PROMPT: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn main_window_subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _ref: usize,
) -> LRESULT {
    match msg {
        WM_WTSSESSION_CHANGE => {
            if let Ok(guard) = GLOBAL_APP.lock() {
                if let Some(ref app) = *guard {
                    let locked = wparam.0 == WTS_SESSION_LOCK;
                    if wparam.0 == WTS_SESSION_LOCK || wparam.0 == WTS_SESSION_UNLOCK {
                        let _ = app.emit("session-lock-changed", serde_json::json!({ "locked": locked }));
                    }
                }
            }
        }
        WM_CLIPBOARDUPDATE => {
            if let Ok(guard) = GLOBAL_APP.lock() {
                if let Some(ref app) = *guard {
                    let _ = app.emit("clipboard-copied", ());
                }
            }
        }
        WM_POWERBROADCAST => {
            if wparam.0 == PBT_APMPOWERSTATUSCHANGE {
                if let Ok(guard) = GLOBAL_APP.lock() {
                    if let Some(ref app) = *guard {
                        let current = crate::battery_info();
                        let _ = app.emit("power-changed", serde_json::json!({
                            "battery_pct": current.0,
                            "charging": current.1
                        }));
                    }
                }
            } else if wparam.0 == PBT_APMRESUMEAUTOMATIC || wparam.0 == PBT_APMRESUMESUSPEND {
                if let Ok(guard) = GLOBAL_APP.lock() {
                    if let Some(ref app) = *guard {
                        let _ = app.emit("system-resumed", ());
                    }
                }
            }
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

unsafe extern "system" fn low_level_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 && w_param.0 as u32 == WM_KEYUP {
        let kbd = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        if kbd.vkCode == VK_CAPITAL.0 as u32 || kbd.vkCode == VK_NUMLOCK.0 as u32 {
            let caps = (GetKeyState(VK_CAPITAL.0 as i32) & 1) != 0;
            let num = (GetKeyState(VK_NUMLOCK.0 as i32) & 1) != 0;
            let old_caps = LAST_CAPS.swap(caps, Ordering::Relaxed);
            let old_num = LAST_NUM.swap(num, Ordering::Relaxed);
            if caps != old_caps || num != old_num {
                if let Ok(guard) = GLOBAL_APP.lock() {
                    if let Some(ref app) = *guard {
                        let _ = app.emit("lock-keys-changed", serde_json::json!({
                            "caps": caps,
                            "num": num,
                            "changed": if caps != old_caps { "caps" } else { "num" }
                        }));
                    }
                }
            }
        }
    }
    let hook_raw = KBD_HOOK.load(Ordering::Relaxed);
    CallNextHookEx(HHOOK(hook_raw as *mut _), n_code, w_param, l_param)
}

unsafe extern "system" fn win_event_proc(
    _h_hook: isize,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    if hwnd == HWND::default() {
        return;
    }

    if let Ok(guard) = GLOBAL_APP.lock() {
        if let Some(ref app) = *guard {
            // 1. Check Fullscreen / Maximized
            let is_fs = crate::foreground_is_fullscreen();
            if LAST_FS.swap(is_fs, Ordering::Relaxed) != is_fs {
                let _ = app.emit("fullscreen-changed", serde_json::json!({ "is_fullscreen": is_fs }));
            }

            // 2. Check Credential / PIN prompt
            let is_prompt = check_is_credential_prompt(hwnd);
            if LAST_PROMPT.swap(is_prompt, Ordering::Relaxed) != is_prompt {
                let _ = app.emit("native-prompt-changed", serde_json::json!({ "active": is_prompt }));
            }
        }
    }
}

unsafe fn check_is_credential_prompt(hwnd: HWND) -> bool {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let mut class_buf = [0u16; 128];
    let cn = GetClassNameW(hwnd, &mut class_buf);
    let class = String::from_utf16_lossy(&class_buf[..cn.max(0) as usize]).to_lowercase();

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let mut exe = String::new();
    if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
            exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        }
        let _ = CloseHandle(h);
    }
    exe.ends_with("credentialuibroker.exe")
        || exe.ends_with("credwiz.exe")
        || exe.ends_with("consent.exe")
        || class.contains("credential dialog")
}

pub fn setup_native_events(app: AppHandle) {
    if let Ok(mut guard) = GLOBAL_APP.lock() {
        *guard = Some(app.clone());
    }

    // Initialize initial keyboard lock states
    unsafe {
        LAST_CAPS.store((GetKeyState(VK_CAPITAL.0 as i32) & 1) != 0, Ordering::Relaxed);
        LAST_NUM.store((GetKeyState(VK_NUMLOCK.0 as i32) & 1) != 0, Ordering::Relaxed);
    }

    // Attach Subclass to Main Window for WTS & Clipboard messages
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Wait briefly for main window to exist
        for _ in 0..30 {
            if let Some(window) = app_clone.get_webview_window("main") {
                if let Ok(raw) = window.hwnd() {
                    let hwnd = HWND(raw.0 as _);
                    unsafe {
                        let _ = WTSRegisterSessionNotification(raw.0 as isize, NOTIFY_FOR_THIS_SESSION);
                        let _ = AddClipboardFormatListener(raw.0 as isize);
                        let _ = SetWindowSubclass(hwnd, main_window_subclass, 1001, 0);
                    }
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });

    // Run Low-Level Keyboard Hook & WinEventHook in a dedicated background thread with message loop
    std::thread::spawn(move || {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, GetMessageW, TranslateMessage, MSG,
            };

            let kbd_hook = SetWindowsHookExW(
                WH_KEYBOARD_LL.0,
                low_level_keyboard_proc,
                0,
                0,
            );
            KBD_HOOK.store(kbd_hook, Ordering::Relaxed);

            let win_hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                0,
                win_event_proc,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            WIN_HOOK.store(win_hook, Ordering::Relaxed);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let kbd = KBD_HOOK.swap(0, Ordering::Relaxed);
            if kbd != 0 {
                let _ = UnhookWindowsHookEx(kbd);
            }
            let win = WIN_HOOK.swap(0, Ordering::Relaxed);
            if win != 0 {
                let _ = UnhookWinEvent(win);
            }
        }
    });
}
