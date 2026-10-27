//! Native drop target for the island window (files and plain text).
//!
//! WebView2 builds its child windows lazily, so a drop target registered
//! once at start-up ends up on a window that is later replaced. We therefore
//! register our own `IDropTarget` on the top-level window and on every child
//! window that exists *now*, and repeat that shortly after start-up.
//!
//! Events sent to the UI (unchanged):
//!   shelf-drag-enter  { paths | text, position: { x, y } }
//!   shelf-drag-leave
//!   shelf-drag-drop   { paths | text }

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::implement;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP,
    CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

/// Longest text we accept from a drag (in UTF-16 units).
const TEXT_LIMIT_UNITS: usize = 128 * 1024;

// ───────────────────────────── reading what is being dragged ─────────────────────────────

enum Payload {
    Files(Vec<String>),
    Text(String),
}

impl Payload {
    /// JSON body for the UI.
    fn to_json(&self) -> Value {
        match self {
            Payload::Files(paths) => json!({ "paths": paths }),
            Payload::Text(text) => json!({ "text": text }),
        }
    }
}

fn hglobal_format(clipboard_format: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: clipboard_format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

/// File paths of a CF_HDROP drag.
unsafe fn read_file_list(data: &IDataObject) -> Option<Vec<String>> {
    let mut medium = data.GetData(&hglobal_format(CF_HDROP.0)).ok()?;
    let drop = HDROP(medium.u.hGlobal.0 as _);

    let count = DragQueryFileW(drop, u32::MAX, None);
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let needed = DragQueryFileW(drop, index, None) as usize;
        let mut buf = vec![0u16; needed + 1];
        let written = (DragQueryFileW(drop, index, Some(&mut buf)) as usize).min(needed);
        paths.push(String::from_utf16_lossy(&buf[..written]));
    }

    // The medium owns the memory, so release it the COM way.
    ReleaseStgMedium(&mut medium);
    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

/// Text of a CF_UNICODETEXT drag (None when empty, blank or too long).
unsafe fn read_text(data: &IDataObject) -> Option<String> {
    let mut medium = data.GetData(&hglobal_format(CF_UNICODETEXT.0)).ok()?;
    let handle = medium.u.hGlobal;
    let first = GlobalLock(handle) as *const u16;

    let mut text = None;
    if !first.is_null() {
        let room = (GlobalSize(handle) / 2).min(TEXT_LIMIT_UNITS);
        let mut len = 0usize;
        while len < room && *first.add(len) != 0 {
            len += 1;
        }
        // len == room means there was no terminator inside our limit
        if len < room {
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(first, len));
            if !s.trim().is_empty() {
                text = Some(s);
            }
        }
        let _ = GlobalUnlock(handle);
    }

    ReleaseStgMedium(&mut medium);
    text
}

unsafe fn read_payload(data: &IDataObject) -> Option<Payload> {
    read_file_list(data)
        .map(Payload::Files)
        .or_else(|| read_text(data).map(Payload::Text))
}

unsafe fn to_client(hwnd: HWND, screen: &POINTL) -> POINT {
    let mut p = POINT { x: screen.x, y: screen.y };
    let _ = ScreenToClient(hwnd, &mut p);
    p
}

fn set_effect(slot: *mut DROPEFFECT, accept: bool) {
    if !slot.is_null() {
        unsafe { *slot = if accept { DROPEFFECT_COPY } else { DROPEFFECT_NONE } };
    }
}

// ───────────────────────────── the drop target ─────────────────────────────

#[implement(IDropTarget)]
pub struct IslandDropTarget {
    app: AppHandle,
    hwnd: HWND,
    /// true between a DragEnter that carried something we understand and the matching leave/drop
    armed: AtomicBool,
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for IslandDropTarget_Impl {
    fn DragEnter(
        &self,
        pdata: Option<&IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let payload = pdata.and_then(|d| unsafe { read_payload(d) });
        self.armed.store(payload.is_some(), Ordering::Relaxed);
        set_effect(effect, payload.is_some());

        if let Some(p) = payload {
            let at = unsafe { to_client(self.hwnd, pt) };
            let mut body = p.to_json();
            body["position"] = json!({ "x": at.x, "y": at.y });
            let _ = self.app.emit("shelf-drag-enter", body);
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        set_effect(effect, self.armed.load(Ordering::Relaxed));
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if self.armed.swap(false, Ordering::Relaxed) {
            let _ = self.app.emit("shelf-drag-leave", ());
        }
        Ok(())
    }

    fn Drop(
        &self,
        pdata: Option<&IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let was_armed = self.armed.swap(false, Ordering::Relaxed);
        let payload = if was_armed {
            pdata.and_then(|d| unsafe { read_payload(d) })
        } else {
            None
        };
        set_effect(effect, payload.is_some());
        if let Some(p) = payload {
            let _ = self.app.emit("shelf-drag-drop", p.to_json());
        }
        Ok(())
    }
}

// ───────────────────────────── registration ─────────────────────────────

/// Keeps the COM objects alive between registrations.
struct Registered(#[allow(dead_code)] Vec<IDropTarget>);
unsafe impl Send for Registered {}

static REGISTERED: Mutex<Option<Registered>> = Mutex::new(None);

unsafe extern "system" fn gather_window(hwnd: HWND, list: LPARAM) -> BOOL {
    let all = &mut *(list.0 as *mut Vec<HWND>);
    all.push(hwnd);
    BOOL(1)
}

/// (Re)register the drop target on the main window and all its children.
fn attach(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(raw) = window.hwnd() else { return };
    let top = HWND(raw.0 as _);

    unsafe {
        let _ = OleInitialize(None);

        let mut windows_found: Vec<HWND> = vec![top];
        let _ = EnumChildWindows(
            top,
            Some(gather_window),
            LPARAM(&mut windows_found as *mut Vec<HWND> as isize),
        );

        let mut keep = Vec::with_capacity(windows_found.len());
        for hwnd in windows_found {
            let target: IDropTarget = IslandDropTarget {
                app: app.clone(),
                hwnd,
                armed: AtomicBool::new(false),
            }
            .into();
            // replace whatever (possibly stale) target is there
            let _ = RevokeDragDrop(hwnd);
            if RegisterDragDrop(hwnd, &target).is_ok() {
                keep.push(target);
            }
        }

        if let Ok(mut slot) = REGISTERED.lock() {
            *slot = Some(Registered(keep));
        }
    }
}

/// Register now, then again at +0.6 s and +2.1 s (when WebView2's windows exist).
pub fn setup_shelf_drop(app: AppHandle) {
    let now = app.clone();
    let _ = app.run_on_main_thread(move || attach(&now));

    std::thread::spawn(move || {
        let mut elapsed = 0u64;
        for at_ms in [600u64, 2100] {
            std::thread::sleep(Duration::from_millis(at_ms - elapsed));
            elapsed = at_ms;
            let again = app.clone();
            let _ = app.run_on_main_thread(move || attach(&again));
        }
    });
}
