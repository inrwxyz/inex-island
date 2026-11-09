//! Native Windows Event Watcher for Inex Island.
//!
//! Replaces all polling with 100% native Windows event-driven callbacks:
//!   1. WTSRegisterSessionNotification -> WM_WTSSESSION_CHANGE (Lock / Unlock)
//!   2. AddClipboardFormatListener    -> WM_CLIPBOARDUPDATE   (Clipboard Copy)
//!   3. WM_POWERBROADCAST             -> Power / Battery / Charger events
//!   5. SetWinEventHook               -> Fullscreen (Smart Mode) & PIN/Password prompts
//!   6. WM_DISPLAYCHANGE              -> Fullscreen re-check after a resolution / monitor change
//!   7. WM_QUERYENDSESSION/ENDSESSION -> Windows shutting down / logging off
//!   8. RegisterPowerSettingNotification -> exact battery % and AC/DC source changes
//!
//! Result: 0.0% CPU when idle!

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindowThreadProcessId};

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
    fn RegisterPowerSettingNotification(
        h_recipient: isize,
        power_setting_guid: *const windows::core::GUID,
        flags: u32,
    ) -> isize;
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

const PBT_POWERSETTINGCHANGE: usize = 0x8013;
const DEVICE_NOTIFY_WINDOW_HANDLE: u32 = 0;
// GUID_BATTERY_PERCENTAGE_REMAINING / GUID_ACDC_POWER_SOURCE
const GUID_BATTERY_PERCENT: u128 = 0xa7ad8041_b45a_4cae_87a3_eecbb468a9e1;
const GUID_ACDC_SOURCE: u128 = 0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548;

const WM_DISPLAYCHANGE: u32 = 0x007E;
const WM_QUERYENDSESSION: u32 = 0x0011;
const WM_ENDSESSION: u32 = 0x0016;

const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
const EVENT_SYSTEM_MOVESIZESTART: u32 = 0x000A;
const EVENT_SYSTEM_MOVESIZEEND: u32 = 0x000B;
const EVENT_SYSTEM_MINIMIZESTART: u32 = 0x0016;
const EVENT_SYSTEM_MINIMIZEEND: u32 = 0x0017;
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
const OBJID_WINDOW: i32 = 0;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
const WINEVENT_SKIPOWNPROCESS: u32 = 2;

static GLOBAL_APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static WIN_HOOK: AtomicIsize = AtomicIsize::new(0);
// LOCATIONCHANGE hook, bound to the thread of the current foreground window only (see rehook_location)
static LOC_HOOK: AtomicIsize = AtomicIsize::new(0);

static LAST_PROMPT: AtomicBool = AtomicBool::new(false);
static LAST_FS: AtomicBool = AtomicBool::new(false);

/// Set by WM_QUERYENDSESSION (Windows is about to shut down / log off), cleared if it is cancelled.
pub static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Compute the fullscreen state of the foreground window and tell the UI only if it changed.
/// Called from the WinEvent hooks and WM_DISPLAYCHANGE (no timer).
fn recheck_fullscreen() {
    let fs = crate::foreground_is_fullscreen();
    if LAST_FS.swap(fs, Ordering::Relaxed) != fs {
        if let Ok(guard) = GLOBAL_APP.lock() {
            if let Some(ref app) = *guard {
                let _ = app.emit("fullscreen-changed", serde_json::json!({ "is_fullscreen": fs }));
            }
        }
    }
}

fn emit_power() {
    if let Ok(guard) = GLOBAL_APP.lock() {
        if let Some(ref app) = *guard {
            let current = crate::battery_info();
            let _ = app.emit("power-changed", serde_json::json!({
                "battery_pct": current.0,
                "charging": current.1
            }));
        }
    }
}

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
            // PBT_APMPOWERSTATUSCHANGE: coarse change; PBT_POWERSETTINGCHANGE: exact % / AC-DC source
            if wparam.0 == PBT_APMPOWERSTATUSCHANGE || wparam.0 == PBT_POWERSETTINGCHANGE {
                emit_power();
            } else if wparam.0 == PBT_APMRESUMEAUTOMATIC || wparam.0 == PBT_APMRESUMESUSPEND {
                if let Ok(guard) = GLOBAL_APP.lock() {
                    if let Some(ref app) = *guard {
                        let _ = app.emit("system-resumed", ());
                    }
                }
            }
        }
        WM_DISPLAYCHANGE => {
            recheck_fullscreen();
        }
        WM_QUERYENDSESSION => {
            SHUTTING_DOWN.store(true, Ordering::SeqCst);
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                // Windows is really shutting down: stop at once so no helper process starts now
                let app = GLOBAL_APP.lock().ok().and_then(|g| g.clone());
                if let Some(app) = app {
                    app.exit(0);
                }
            } else {
                SHUTTING_DOWN.store(false, Ordering::SeqCst); // the shutdown was cancelled
            }
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// EVENT_OBJECT_LOCATIONCHANGE fires for every window / cursor movement on the whole desktop.
/// A global hook would wake this app for all of them, so it is bound to the thread of the window
/// that is in the foreground and moved to the next one whenever the foreground changes.
unsafe fn rehook_location(hwnd: HWND) {
    let old = LOC_HOOK.swap(0, Ordering::Relaxed);
    if old != 0 {
        let _ = UnhookWinEvent(old);
    }
    if hwnd == HWND::default() {
        return;
    }
    let mut pid = 0u32;
    let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if tid == 0 {
        return;
    }
    let h = SetWinEventHook(
        EVENT_OBJECT_LOCATIONCHANGE,
        EVENT_OBJECT_LOCATIONCHANGE,
        0,
        win_event_proc,
        0,
        tid,
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
    );
    LOC_HOOK.store(h, Ordering::Relaxed);
}

unsafe extern "system" fn win_event_proc(
    _h_hook: isize,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    // Fullscreen / maximized state of the foreground window changed (Smart Mode).
    if event == EVENT_OBJECT_LOCATIONCHANGE {
        // very frequent event: only windows matter
        if id_object != OBJID_WINDOW {
            return;
        }
        let fg = GetForegroundWindow();
        if fg == HWND::default() {
            return;
        }
        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};
        if hwnd != fg && GetAncestor(hwnd, GA_ROOT) != fg {
            return;
        }
        recheck_fullscreen();
        return;
    }
    if event == EVENT_SYSTEM_MINIMIZESTART || event == EVENT_SYSTEM_MINIMIZEEND || event == EVENT_SYSTEM_MOVESIZEEND {
        recheck_fullscreen();
        return;
    }

    // EVENT_SYSTEM_FOREGROUND: another window became active
    rehook_location(hwnd);
    recheck_fullscreen();

    if hwnd == HWND::default() {
        return;
    }

    if let Ok(guard) = GLOBAL_APP.lock() {
        if let Some(ref app) = *guard {
            // Check Credential / PIN prompt
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

static ATTACHED_SUBCLASS: AtomicBool = AtomicBool::new(false);

fn attach_main_window_subclass(app: &AppHandle) -> bool {
    if ATTACHED_SUBCLASS.load(Ordering::Relaxed) {
        return true;
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(raw) = window.hwnd() {
            let hwnd_val = raw.0 as isize;
            let hwnd = HWND(hwnd_val as _);
            unsafe {
                let _ = WTSRegisterSessionNotification(hwnd_val, NOTIFY_FOR_THIS_SESSION);
                let _ = AddClipboardFormatListener(hwnd_val);
                let ok = SetWindowSubclass(hwnd, main_window_subclass, 1001, 0);
                for g in [GUID_BATTERY_PERCENT, GUID_ACDC_SOURCE] {
                    let guid = windows::core::GUID::from_u128(g);
                    let _ = RegisterPowerSettingNotification(hwnd_val, &guid, DEVICE_NOTIFY_WINDOW_HANDLE);
                }
                if ok.as_bool() {
                    ATTACHED_SUBCLASS.store(true, Ordering::Relaxed);
                    return true;
                }
            }
        }
    }
    false
}

pub fn setup_native_events(app: AppHandle) {
    if let Ok(mut guard) = GLOBAL_APP.lock() {
        *guard = Some(app.clone());
    }

    LAST_FS.store(crate::foreground_is_fullscreen(), Ordering::Relaxed);

    // Attach Subclass to Main Window for WTS & Clipboard messages on the UI thread
    let app_for_subclass = app.clone();
    let _ = app.run_on_main_thread(move || {
        attach_main_window_subclass(&app_for_subclass);
    });

    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Wait briefly for main window to exist if not already attached
        for _ in 0..30 {
            if ATTACHED_SUBCLASS.load(Ordering::Relaxed) {
                break;
            }
            let app_retry = app_clone.clone();
            let _ = app_clone.run_on_main_thread(move || {
                attach_main_window_subclass(&app_retry);
            });
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });

    // Run Low-Level Keyboard Hook & WinEventHook in a dedicated background thread with message loop
    std::thread::spawn(move || {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, GetMessageW, TranslateMessage, MSG,
            };


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

            // window minimized / restored, and the foreground window moved or resized (F11, game fullscreen, maximize)
            let _ = SetWinEventHook(
                EVENT_SYSTEM_MINIMIZESTART,
                EVENT_SYSTEM_MINIMIZEEND,
                0,
                win_event_proc,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            let _ = SetWinEventHook(
                EVENT_SYSTEM_MOVESIZESTART,
                EVENT_SYSTEM_MOVESIZEEND,
                0,
                win_event_proc,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            // follow the foreground window's position / size (F11, maximize, game fullscreen)
            rehook_location(windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow());

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let win = WIN_HOOK.swap(0, Ordering::Relaxed);
            if win != 0 {
                let _ = UnhookWinEvent(win);
            }
        }
    });
}
