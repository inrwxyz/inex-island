use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, WebviewWindow};

// ---- Fixed window ---------------------------------------------------------------------------------
// The OS window is sized ONCE (big and transparent) at startup and never resized again, so it can not get
// out of step with the CSS animation (that mismatch was the shaking). Clicks outside the island must still
// reach the apps underneath, so a small watcher thread switches the window to "click-through" whenever the
// cursor is outside the island's rectangle (reported by the page through set_island_hit).
pub const FIXED_WIN_W: f64 = 820.0; // 548 x 140% (max UI scale) + room for the spring overshoot
pub const FIXED_WIN_H: f64 = 500.0; // tallest view (292) x 140% + room
static HIT: std::sync::Mutex<(f64, f64)> = std::sync::Mutex::new((316.0, 44.0));

#[tauri::command]
pub fn set_island_hit(width: f64, height: f64) {
    if let Ok(mut h) = HIT.lock() {
        *h = (width, height);
    }
}

// ---- Notch Companion: cursor + idle probe ----------------------------------------------------------------
// Returns [cursor_x, cursor_y, idle_ms]. The cursor is in WINDOW-relative logical px (same space as the page's
// getBoundingClientRect) because the island window is click-through outside the island and the page gets no
// mouse events there. idle_ms = time since the last keyboard / mouse input anywhere in Windows.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn pet_probe(window: tauri::WebviewWindow) -> Option<(f64, f64, u32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()?; }
    let pos = window.outer_position().ok()?;
    let sf = window.scale_factor().ok()?;
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    let _ = unsafe { GetLastInputInfo(&mut li) };
    let idle = if li.dwTime == 0 { 0 } else { unsafe { GetTickCount() }.wrapping_sub(li.dwTime) };
    Some(((p.x - pos.x) as f64 / sf, (p.y - pos.y) as f64 / sf, idle))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn pet_probe() -> Option<(f64, f64, u32)> {
    None
}

#[cfg(target_os = "windows")]
pub fn start_hit_poller(window: WebviewWindow, win_logical_w: f64) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};
    let hwnd_val: isize = match window.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        loop {
            let (hw, hh) = HIT.lock().map(|g| *g).unwrap_or((316.0, 44.0));
            let hwnd = HWND(hwnd_val as *mut core::ffi::c_void);
            let mut p = POINT::default();
            let mut r = RECT::default();
            let ok = unsafe { GetCursorPos(&mut p).is_ok() && GetWindowRect(hwnd, &mut r).is_ok() };
            let mut near = false;
            if ok {
                let phys_w = (r.right - r.left) as f64;
                let scale = if win_logical_w > 0.0 { phys_w / win_logical_w } else { 1.0 };
                let cx = (r.left as f64 + r.right as f64) / 2.0;
                let left = cx - hw * scale / 2.0;
                let right = cx + hw * scale / 2.0;
                let top = r.top as f64;
                let bottom = top + hh * scale;
                let (px, py) = (p.x as f64, p.y as f64);
                let inside = px >= left && px <= right && py >= top && py <= bottom;
                let m = 120.0 * scale;
                near = px >= left - m && px <= right + m && py >= top - m && py <= bottom + m;
                let want_ignore = !inside;
                if ignoring != Some(want_ignore) {
                    if window.set_ignore_cursor_events(want_ignore).is_ok() {
                        ignoring = Some(want_ignore);
                        // a click-through window gets no more mouse events, so tell the page where the pointer is
                        let _ = window.emit("island_pointer", !want_ignore);
                    }
                }
            }
            // fast while the cursor is around the island, relaxed (almost no CPU) everywhere else
            std::thread::sleep(Duration::from_millis(if near { 16 } else { 70 }));
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn start_hit_poller(_window: WebviewWindow, _win_logical_w: f64) {}

// Centers the island at the top of its monitor. Returns false if no monitor is known yet
// (can happen right after boot), so the caller can retry.
pub fn place_island(window: &WebviewWindow, width: f64, height: f64) -> bool {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let screen_width = monitor.size().width as f64 / scale;
        let left = monitor.position().x as f64 / scale;
        let top = monitor.position().y as f64 / scale;
        let x = left + (screen_width - width) / 2.0;
        // Windows: size + position in ONE call. Two separate calls (set_size, then set_position) made the
        // pill jump sideways for a frame on every open/close, which looked like shaking left and right.
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
            };
            if let Ok(h) = window.hwnd() {
                let hwnd = HWND(h.0 as *mut core::ffi::c_void);
                let ok = unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND::default(),
                        (x * scale).round() as i32,
                        (top * scale).round() as i32,
                        (width * scale).round() as i32,
                        (height * scale).round() as i32,
                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    )
                    .is_ok()
                };
                if ok {
                    return true;
                }
            }
        }
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.set_position(LogicalPosition::new(x, top));
        return true;
    }
    false
}

#[tauri::command]
pub fn focus_island(window: WebviewWindow) {
    let _ = window.set_focus();
}

#[tauri::command]
pub fn setup_shelf_drop(app: AppHandle) {
    crate::shelf::setup_shelf_drop(app);
}
