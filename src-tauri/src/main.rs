#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bluetooth;
mod clipboard;
mod audio;
mod brightness;
mod live;
mod locker_bridge;
mod net;
mod privacy;
mod shelf;
mod visualizer;
mod wifi;
pub mod quick_share;
pub use quick_share::{console, crypto, events, mdns, protos};
#[cfg(target_os = "windows")]
mod native_events;
#[cfg(target_os = "windows")]
mod audio_events;

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

// ---- Startup log: %LOCALAPPDATA%\\InexIsland\\startup.log (shows what happened at boot) ----
fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let d = base.join("InexIsland");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn log(msg: &str) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = data_dir().join("startup.log");
    // keep the file small
    if std::fs::metadata(&path).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {}", t, msg);
    }
}

// True while Windows is logging off / shutting down (SM_SHUTTINGDOWN)
fn system_shutting_down() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SYSTEM_METRICS_INDEX};
        // SM_SHUTTINGDOWN, or WM_QUERYENDSESSION already seen by native_events.rs
        return GetSystemMetrics(SYSTEM_METRICS_INDEX(0x2000)) != 0
            || native_events::SHUTTING_DOWN.load(std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(not(target_os = "windows"))]
    false
}

// Opens a file, folder, URL or ms-settings: page the way Explorer would (ShellExecuteW).
// No cmd.exe / powershell / helper process is started, and nothing is run through a shell,
// so a URL can never be taken for a command (no injection). Returns true when Windows took it.
#[cfg(target_os = "windows")]
pub(crate) fn shell_open(target: &str) -> bool {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let t = HSTRING::from(target);
    unsafe {
        let r = ShellExecuteW(None, w!("open"), PCWSTR(t.as_ptr()), None, None, SW_SHOWNORMAL);
        (r.0 as isize) > 32 // ShellExecute reports success with a value above 32
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn shell_open(_target: &str) -> bool {
    false
}

// Windows' own registry API (advapi32) for the HKCU keys the app needs. Replaces reg.exe.
#[cfg(target_os = "windows")]
mod winreg {
    use std::ffi::c_void;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegCreateKeyExW(
            hkey: isize,
            sub_key: *const u16,
            reserved: u32,
            class: *const u16,
            options: u32,
            sam: u32,
            security: *const c_void,
            result: *mut isize,
            disposition: *mut u32,
        ) -> i32;
        fn RegOpenKeyExW(hkey: isize, sub_key: *const u16, options: u32, sam: u32, result: *mut isize) -> i32;
        fn RegSetValueExW(hkey: isize, name: *const u16, reserved: u32, kind: u32, data: *const u8, len: u32) -> i32;
        fn RegQueryValueExW(
            hkey: isize,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            len: *mut u32,
        ) -> i32;
        fn RegDeleteValueW(hkey: isize, name: *const u16) -> i32;
        fn RegCloseKey(hkey: isize) -> i32;
    }

    // HKEY_CURRENT_USER is the sign-extended 0x80000001
    const HKCU: isize = 0x8000_0001u32 as i32 as isize;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    const REG_BINARY: u32 = 3;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn set_raw(subkey: &str, name: &str, kind: u32, data: &[u8]) -> bool {
        unsafe {
            let sk = wide(subkey);
            let nm = wide(name);
            let mut h: isize = 0;
            if RegCreateKeyExW(HKCU, sk.as_ptr(), 0, std::ptr::null(), 0, KEY_SET_VALUE, std::ptr::null(), &mut h, std::ptr::null_mut())
                != ERROR_SUCCESS
            {
                return false;
            }
            let rc = RegSetValueExW(h, nm.as_ptr(), 0, kind, data.as_ptr(), data.len() as u32);
            RegCloseKey(h);
            rc == ERROR_SUCCESS
        }
    }

    /// Writes a REG_SZ value (the key is created when it does not exist yet).
    pub fn set_string(subkey: &str, name: &str, value: &str) -> bool {
        let w = wide(value);
        let bytes: Vec<u8> = w.iter().flat_map(|c| c.to_le_bytes()).collect();
        set_raw(subkey, name, REG_SZ, &bytes)
    }

    /// Writes a REG_BINARY value.
    pub fn set_binary(subkey: &str, name: &str, data: &[u8]) -> bool {
        set_raw(subkey, name, REG_BINARY, data)
    }

    /// Reads a REG_SZ / REG_EXPAND_SZ value. None when the key or the value is missing.
    pub fn get_string(subkey: &str, name: &str) -> Option<String> {
        unsafe {
            let sk = wide(subkey);
            let nm = wide(name);
            let mut h: isize = 0;
            if RegOpenKeyExW(HKCU, sk.as_ptr(), 0, KEY_QUERY_VALUE, &mut h) != ERROR_SUCCESS {
                return None;
            }
            let mut kind: u32 = 0;
            let mut len: u32 = 0;
            let mut out = None;
            if RegQueryValueExW(h, nm.as_ptr(), std::ptr::null_mut(), &mut kind, std::ptr::null_mut(), &mut len) == ERROR_SUCCESS
                && (kind == REG_SZ || kind == REG_EXPAND_SZ)
            {
                let mut buf = vec![0u8; len as usize + 2];
                let mut len2 = len;
                if RegQueryValueExW(h, nm.as_ptr(), std::ptr::null_mut(), &mut kind, buf.as_mut_ptr(), &mut len2) == ERROR_SUCCESS {
                    let u: Vec<u16> = buf[..len2 as usize]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .take_while(|&c| c != 0)
                        .collect();
                    out = Some(String::from_utf16_lossy(&u));
                }
            }
            RegCloseKey(h);
            out
        }
    }

    /// Deletes a value. A value (or key) that is already gone counts as success.
    pub fn delete_value(subkey: &str, name: &str) -> bool {
        unsafe {
            let sk = wide(subkey);
            let nm = wide(name);
            let mut h: isize = 0;
            let rc = RegOpenKeyExW(HKCU, sk.as_ptr(), 0, KEY_SET_VALUE, &mut h);
            if rc == ERROR_FILE_NOT_FOUND {
                return true;
            }
            if rc != ERROR_SUCCESS {
                return false;
            }
            let rc = RegDeleteValueW(h, nm.as_ptr());
            RegCloseKey(h);
            rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND
        }
    }
}

#[derive(Serialize, Clone)]
struct MediaInfo {
    playing: bool,
    title: String,
    artist: String,
    position: f64,
    duration: f64,
    updated_at: u64,
}

#[derive(Serialize)]
struct SysStats {
    ram_pct: u32,
    cpu_pct: u32,
    gpu_pct: u32,
    disk_pct: u32,
    battery_pct: i32,
    charging: bool,
    wifi_name: String,
    wifi_signal: u32,
    wifi_on: bool,
    is_fullscreen: bool,
}

// Windows bumps this number every time anything is copied (any app): the island polls it to show the "Copied" popup.
#[tauri::command]
fn clipboard_seq() -> u32 {
    #[cfg(windows)]
    {
        unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[tauri::command]
fn get_clipboard_text() -> String {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
        use windows::Win32::Foundation::{HGLOBAL, HWND};
        const CF_UNICODETEXT: u32 = 13;
        for _ in 0..5 {
            if OpenClipboard(HWND::default()).is_ok() {
                let mut result = String::new();
                if let Ok(h) = GetClipboardData(CF_UNICODETEXT) {
                    if !h.0.is_null() {
                        let ptr = GlobalLock(HGLOBAL(h.0)) as *const u16;
                        if !ptr.is_null() {
                            let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
                            let slice = std::slice::from_raw_parts(ptr, len);
                            result = String::from_utf16_lossy(slice);
                            let _ = GlobalUnlock(HGLOBAL(h.0));
                        }
                    }
                }
                let _ = CloseClipboard();
                if !result.is_empty() {
                    return result;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    String::new()
}

#[tauri::command]
fn resize_island(window: WebviewWindow, width: f64, height: f64) {
    place_island(&window, width, height);
}

// Centers the island at the top of its monitor. Returns false if no monitor is known yet
// (can happen right after boot), so the caller can retry.
fn place_island(window: &WebviewWindow, width: f64, height: f64) -> bool {
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

// 1. Real Windows Media Status (Universal Media Detection across all Windows players)
#[cfg(target_os = "windows")]
fn get_best_media_session(
    manager: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
) -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
    if let Ok(sessions) = manager.GetSessions() {
        let mut first_valid = None;
        for s in sessions {
            if let Ok(info) = s.GetPlaybackInfo() {
                if let Ok(status) = info.PlaybackStatus() {
                    if status == Status::Playing {
                        return Some(s);
                    }
                    if first_valid.is_none() && status != Status::Closed && status != Status::Stopped {
                        first_valid = Some(s);
                    }
                }
            }
        }
        if first_valid.is_some() {
            return first_valid;
        }
    }
    manager.GetCurrentSession().ok()
}

#[tauri::command]
async fn get_media_status() -> MediaInfo {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::{
            GlobalSystemMediaTransportControlsSessionManager,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus,
        };
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    let status = session
                        .GetPlaybackInfo()
                        .and_then(|info| info.PlaybackStatus())
                        .unwrap_or(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed);

                    let playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;

                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    // If closed or stopped, media is not active
                    if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed
                        || status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped
                    {
                        return MediaInfo {
                            playing: false,
                            title: String::new(),
                            artist: String::new(),
                            position: 0.0,
                            duration: 0.0,
                            updated_at: now_ms,
                        };
                    }

                    if let Ok(props_op) = session.TryGetMediaPropertiesAsync() {
                        if let Ok(props) = props_op.get() {
                            let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
                            let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
                            if !title.is_empty() {
                                let (position, duration) = session
                                    .GetTimelineProperties()
                                    .map(|t| {
                                        let pos = t
                                            .Position()
                                            .map(|d| d.Duration as f64 / 1e7)
                                            .unwrap_or(0.0);
                                        let end = t
                                            .EndTime()
                                            .map(|d| d.Duration as f64 / 1e7)
                                            .unwrap_or(0.0);
                                        (pos, end)
                                    })
                                    .unwrap_or((0.0, 0.0));
                                return MediaInfo {
                                    playing,
                                    title,
                                    artist,
                                    position,
                                    duration,
                                    updated_at: now_ms,
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    MediaInfo {
        playing: false,
        title: String::new(),
        artist: String::new(),
        position: 0.0,
        duration: 0.0,
        updated_at: now_ms,
    }
}

// Seek media timeline to a specific second (for draggable progress bar)
#[tauri::command]
async fn seek_media(position_sec: f64) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    let ticks = (position_sec.max(0.0) * 10_000_000.0) as i64;
                    if let Ok(seek_op) = session.TryChangePlaybackPositionAsync(ticks) {
                        return seek_op.get().unwrap_or(false);
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = position_sec;
    false
}

#[cfg(target_os = "windows")]
fn media_art_inner() -> Option<String> {
    use windows::core::Interface;
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    use windows::Storage::Streams::{DataReader, IInputStream};

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;
    let session = get_best_media_session(&manager)?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    let input: IInputStream = stream.cast().ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;

    // Reject Windows ICO format (starts with \x00\x00\x01\x00) - browser/app executable icon, not media artwork
    if buf.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return None;
    }

    // Check PNG format: if PNG is smaller than 3.5KB or dimensions <= 64x64, it's a browser placeholder/favicon
    if buf.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        if buf.len() < 3500 {
            return None;
        }
        if buf.len() >= 24 {
            let width = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
            let height = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
            if width <= 64 && height <= 64 {
                return None;
            }
        }
    }

    // Detect proper image mime type
    let mime = if buf.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if buf.len() > 12 && buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    };

    Some(format!("data:{};base64,{}", mime, base64_encode(&buf)))
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}


#[tauri::command]
async fn get_media_art() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(art) = media_art_inner() {
            return art;
        }
    }
    String::new()
}


#[tauri::command]
async fn media_play_pause() {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        let mut handled = false;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    if let Ok(toggle_op) = session.TryTogglePlayPauseAsync() {
                        let _ = toggle_op.get();
                        handled = true;
                    }
                }
            }
        }
        if !handled {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_PLAY_PAUSE,
                };
                keybd_event(VK_MEDIA_PLAY_PAUSE.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MEDIA_PLAY_PAUSE.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }
}

#[tauri::command]
async fn media_next() {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        let mut handled = false;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    if let Ok(next_op) = session.TrySkipNextAsync() {
                        let _ = next_op.get();
                        handled = true;
                    }
                }
            }
        }
        if !handled {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_NEXT_TRACK,
                };
                keybd_event(VK_MEDIA_NEXT_TRACK.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MEDIA_NEXT_TRACK.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }
}

#[tauri::command]
async fn media_prev() {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        let mut handled = false;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    if let Ok(prev_op) = session.TrySkipPreviousAsync() {
                        let _ = prev_op.get();
                        handled = true;
                    }
                }
            }
        }
        if !handled {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_PREV_TRACK,
                };
                keybd_event(VK_MEDIA_PREV_TRACK.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MEDIA_PREV_TRACK.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn endpoint_volume() -> Option<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
}

#[tauri::command]
async fn set_system_volume(level: i32) {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Some(vol) = endpoint_volume() {
            let v = (level.clamp(0, 100) as f32) / 100.0;
            let _ = vol.SetMasterVolumeLevelScalar(v, std::ptr::null());
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = level;
}

#[tauri::command]
async fn get_system_volume() -> i32 {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Some(vol) = endpoint_volume() {
            if let Ok(v) = vol.GetMasterVolumeLevelScalar() {
                return (v * 100.0).round() as i32;
            }
        }
    }
    75
}

// Brightness goes through WMI on a worker thread (brightness.rs): no PowerShell.
#[tauri::command]
fn set_system_brightness(level: u32) {
    brightness::set(level);
}

/// Last known brightness, or None when this PC has no controllable panel.
#[tauri::command]
fn get_system_brightness() -> Option<u32> {
    brightness::current()
}

#[cfg(target_os = "windows")]
static CPU_PREV: std::sync::Mutex<(u64, u64)> = std::sync::Mutex::new((0, 0));

// ---- Net speed for the "Net Speed" hover widget -------------------------------------------
// Bytes in/out of the real (hardware) adapters that are up, from the native IP Helper API.
// The island only calls get_net_speed while that widget is selected, so it costs nothing otherwise.
#[cfg(target_os = "windows")]
static NET_PREV: std::sync::Mutex<Option<(std::time::Instant, u64, u64)>> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
fn net_octets() -> (u64, u64) {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    let (mut rx, mut tx) = (0u64, 0u64);
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        let _ = GetIfTable2(&mut table);
        if table.is_null() {
            return (0, 0);
        }
        let n = (*table).NumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), n);
        for r in rows {
            // OperStatus 1 = up. The first flag bit is HardwareInterface: it skips VPN, Hyper-V, WSL and loopback
            // adapters, so the same traffic is never counted twice.
            let hardware = (*(&r.InterfaceAndOperStatusFlags as *const _ as *const u8)) & 1 != 0;
            if r.OperStatus.0 == 1 && hardware {
                rx += r.InOctets;
                tx += r.OutOctets;
            }
        }
        FreeMibTable(table as *const core::ffi::c_void);
    }
    (rx, tx)
}

// (download, upload) in bytes per second, averaged since the previous call.
#[tauri::command]
async fn get_net_speed() -> (u64, u64) {
    #[cfg(target_os = "windows")]
    {
        let (rx, tx) = net_octets();
        let now = std::time::Instant::now();
        let mut prev = NET_PREV.lock().unwrap();
        let out = match *prev {
            Some((t, prx, ptx)) => {
                let dt = now.duration_since(t).as_secs_f64();
                if dt >= 0.5 && dt <= 10.0 {
                    (
                        (rx.saturating_sub(prx) as f64 / dt) as u64,
                        (tx.saturating_sub(ptx) as f64 / dt) as u64,
                    )
                } else {
                    (0, 0) // first call or a long pause: no usable baseline yet
                }
            }
            None => (0, 0),
        };
        *prev = Some((now, rx, tx));
        return out;
    }
    #[cfg(not(target_os = "windows"))]
    (0, 0)
}

#[cfg(target_os = "windows")]
fn cpu_percent() -> u32 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;
    let (mut idle, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe {
        let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));
    }
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    let (i, total) = (ft(idle), ft(kernel) + ft(user));
    let mut prev = CPU_PREV.lock().unwrap();
    let (prev_i, prev_total) = *prev;
    *prev = (i, total);
    if prev_total == 0 || total <= prev_total {
        return 0;
    }
    let dt = total - prev_total;
    let di = i.saturating_sub(prev_i);
    (100 * dt.saturating_sub(di) / dt) as u32
}

#[cfg(target_os = "windows")]
mod gpu {
    use std::sync::Mutex;
    use windows::core::w;

    #[repr(C)]
    struct PdhFmtCountervalue {
        c_status: u32,
        _pad: u32,
        double_value: f64,
    }

    #[repr(C)]
    struct PdhFmtCountervalueItemW {
        sz_name: *mut u16,
        fmt_value: PdhFmtCountervalue,
    }

    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(
            szDataSource: *const u16,
            dwUserData: usize,
            phQuery: *mut isize,
        ) -> u32;
        fn PdhAddEnglishCounterW(
            hQuery: isize,
            szFullCounterPath: *const u16,
            dwUserData: usize,
            phCounter: *mut isize,
        ) -> u32;
        fn PdhCollectQueryData(hQuery: isize) -> u32;
        fn PdhGetFormattedCounterArrayW(
            hCounter: isize,
            dwFormat: u32,
            lpdwBufferSize: *mut u32,
            lpdwItemCount: *mut u32,
            ItemBuffer: *mut u8,
        ) -> u32;
        fn PdhCloseQuery(hQuery: isize) -> u32;
    }

    struct GpuQuery {
        query: isize,
        counter: isize,
        last_success: std::time::Instant,
    }

    static GPU_STATE: Mutex<Option<GpuQuery>> = Mutex::new(None);

    const PDH_FMT_DOUBLE: u32 = 0x00000200;

    pub fn percent() -> u32 {
        let mut state = match GPU_STATE.lock() {
            Ok(s) => s,
            Err(_) => return 0,
        };

        let now = std::time::Instant::now();
        let need_reopen = match &*state {
            Some(q) => now.duration_since(q.last_success).as_secs() > 180,
            None => true,
        };

        if need_reopen {
            if let Some(old) = state.take() {
                unsafe { PdhCloseQuery(old.query); }
            }
            let mut q: isize = 0;
            let mut c: isize = 0;
            unsafe {
                if PdhOpenQueryW(std::ptr::null(), 0, &mut q) == 0 {
                    let path = w!("\\GPU Engine(*)\\Utilization Percentage");
                    if PdhAddEnglishCounterW(q, path.as_ptr(), 0, &mut c) == 0 {
                        PdhCollectQueryData(q);
                        *state = Some(GpuQuery {
                            query: q,
                            counter: c,
                            last_success: now,
                        });
                        return 0; // Baseline initialized
                    } else {
                        PdhCloseQuery(q);
                    }
                }
            }
            return 0;
        }

        let q_ref = match state.as_mut() {
            Some(q) => q,
            None => return 0,
        };

        unsafe {
            if PdhCollectQueryData(q_ref.query) != 0 {
                let old = state.take().unwrap();
                PdhCloseQuery(old.query);
                return 0;
            }

            let mut buf_size: u32 = 0;
            let mut item_count: u32 = 0;
            let _ = PdhGetFormattedCounterArrayW(
                q_ref.counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                std::ptr::null_mut(),
            );

            if buf_size == 0 || item_count == 0 {
                return 0;
            }

            let mut buf: Vec<u8> = vec![0u8; buf_size as usize];
            let status = PdhGetFormattedCounterArrayW(
                q_ref.counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                buf.as_mut_ptr(),
            );

            if status != 0 {
                return 0;
            }

            q_ref.last_success = now;

            let item_size = std::mem::size_of::<PdhFmtCountervalueItemW>();
            let mut total_pct = 0.0f64;

            for i in 0..(item_count as usize) {
                let offset = i * item_size;
                if offset + item_size <= buf.len() {
                    let item = &*(buf.as_ptr().add(offset) as *const PdhFmtCountervalueItemW);
                    if item.fmt_value.c_status == 0 {
                        total_pct += item.fmt_value.double_value;
                    }
                }
            }

            total_pct.round().clamp(0.0, 100.0) as u32
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod gpu {
    pub fn percent() -> u32 {
        0
    }
}

#[cfg(target_os = "windows")]
fn disk_percent() -> u32 {
    use windows::core::w;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    unsafe {
        let _ = GetDiskFreeSpaceExW(
            w!("C:\\"),
            Some(&mut avail),
            Some(&mut total),
            Some(&mut free),
        );
    }
    if total == 0 {
        0
    } else {
        (100 - free * 100 / total) as u32
    }
}

#[cfg(target_os = "windows")]
pub fn battery_info() -> (i32, bool) {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st = SYSTEM_POWER_STATUS::default();
    unsafe {
        let _ = GetSystemPowerStatus(&mut st);
    }
    let pct = if st.BatteryLifePercent == 255 {
        -1
    } else {
        st.BatteryLifePercent as i32
    };
    (pct, st.ACLineStatus == 1)
}

// Smart Mode Check: Returns true if the active foreground window is Maximized (IsZoomed) OR Fullscreen!
#[cfg(target_os = "windows")]
pub fn foreground_is_fullscreen() -> bool {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsZoomed,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == HWND::default() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class);
        let name = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if matches!(
            name.as_str(),
            "Progman"
                | "WorkerW"
                | "Shell_TrayWnd"
                | "Shell_SecondaryTrayWnd"
                | "Windows.UI.Core.CoreWindow"
                | "XamlExplorerHostIslandWindow"
                | "Shell_InputSwitchTopLevel"
                | "MultitaskingViewFrame"
        ) {
            return false;
        }
        // Ignore our own Island or Settings window, or screenshot clipping overlays
        let mut title_buf = [0u16; 64];
        let tn = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..tn.max(0) as usize]);
        let title_lower = title.to_lowercase();
        if title.contains("Inex Island")
            || title_lower.contains("snipping")
            || title_lower.contains("screen clipping")
            || title_lower.contains("snip & sketch")
            || title_lower.contains("screenshot")
        {
            return false;
        }

        // Check process image name to never hide during screenshots or for our own app
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            use windows::core::PWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 260];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    let exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                    if exe.ends_with("snippingtool.exe")
                        || exe.ends_with("screenclippinghost.exe")
                        || exe.contains("screensketch")
                        || exe.ends_with("sharex.exe")
                        || exe.ends_with("lightshot.exe")
                        || exe.ends_with("flameshot.exe")
                        || exe.ends_with("inex-island.exe")
                    {
                        let _ = CloseHandle(h);
                        return false;
                    }
                }
                let _ = CloseHandle(h);
            }
        }

        // 1. Check if window is Maximized (like YouTube / Chrome / Explorer in video)
        if IsZoomed(hwnd).as_bool() {
            return true;
        }

        // 2. Check if window covers the full monitor (F11 / game fullscreen)
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return false;
        }
        r.left <= mi.rcMonitor.left
            && r.top <= mi.rcMonitor.top
            && r.right >= mi.rcMonitor.right
            && r.bottom >= mi.rcMonitor.bottom
    }
}

// Only the figures Windows cannot push (it has no "CPU % changed" event): sampled, and only while
// a load widget is on screen. Battery, Wi-Fi and fullscreen are NOT read here: they arrive as events.
#[derive(Serialize)]
struct SysLoad {
    ram_pct: u32,
    cpu_pct: u32,
    gpu_pct: u32,
    disk_pct: u32,
}

#[allow(unused_assignments)]
#[tauri::command]
async fn get_sys_load() -> SysLoad {
    let (mut ram_pct, mut cpu_pct, mut gpu_pct, mut disk_pct) = (0, 0, 0, 0);
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut mem).is_ok() {
            ram_pct = mem.dwMemoryLoad;
        }
        cpu_pct = cpu_percent();
        gpu_pct = gpu::percent();
        disk_pct = disk_percent();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&mut ram_pct, &mut cpu_pct, &mut gpu_pct, &mut disk_pct);
    SysLoad { ram_pct, cpu_pct, gpu_pct, disk_pct }
}

#[allow(unused_assignments)]
#[tauri::command]
async fn get_sys_stats() -> SysStats {
    let mut ram_pct = 0;
    let (mut cpu_pct, mut gpu_pct, mut disk_pct, mut battery_pct, mut charging) = (0, 0, 0, -1, false);
    let mut is_fullscreen = false;
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut mem).is_ok() {
            ram_pct = mem.dwMemoryLoad;
        }
        cpu_pct = cpu_percent();
        gpu_pct = gpu::percent();
        disk_pct = disk_percent();
        (battery_pct, charging) = battery_info();
        is_fullscreen = foreground_is_fullscreen();
    }

    // Wi-Fi name + signal straight from the native WLAN API (no netsh process any more)
    let mut wifi_name = String::from("Not connected");
    let wifi_on = true;
    let mut wifi_signal: u32 = 0;
    if wifi::is_running() && !system_shutting_down() {
        if let Some((name, sig)) = live::wifi_now() {
            wifi_name = name;
            wifi_signal = sig;
        }
    }

    SysStats {
        ram_pct,
        cpu_pct,
        gpu_pct,
        disk_pct,
        battery_pct,
        charging,
        wifi_name,
        wifi_signal,
        wifi_on,
        is_fullscreen,
    }
}


#[cfg(target_os = "windows")]
fn radio_kind(name: &str) -> Option<windows::Devices::Radios::RadioKind> {
    use windows::Devices::Radios::RadioKind;
    match name {
        "wifi" => Some(RadioKind::WiFi),
        "bt" => Some(RadioKind::Bluetooth),
        _ => None,
    }
}

#[tauri::command]
async fn get_radio_state(kind: String) -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        use windows::Devices::Radios::{Radio, RadioState};
        // The radio watcher (live.rs) keeps this current through Windows events.
        if let Some(on) = live::radio_cached(&kind) {
            return Some(on);
        }
        let wanted = radio_kind(&kind)?;
        let radios = Radio::GetRadiosAsync().ok()?.get().ok()?;
        for i in 0..radios.Size().ok()? {
            let r = radios.GetAt(i).ok()?;
            if r.Kind().ok()? == wanted {
                let on = r.State().ok()? == RadioState::On;
                live::radio_store(&kind, on);
                return Some(on);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = kind;
    None
}

#[tauri::command]
async fn set_radio_state(kind: String, on: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioState};
        let wanted = radio_kind(&kind).ok_or("unknown radio")?;
        let _ = Radio::RequestAccessAsync()
            .ok()
            .and_then(|op| op.get().ok());
        let radios = Radio::GetRadiosAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        let count = radios.Size().map_err(|e| e.to_string())?;
        for i in 0..count {
            let r = radios.GetAt(i).map_err(|e| e.to_string())?;
            if r.Kind().map_err(|e| e.to_string())? == wanted {
                let status = r
                    .SetStateAsync(if on { RadioState::On } else { RadioState::Off })
                    .map_err(|e| e.to_string())?
                    .get()
                    .map_err(|e| e.to_string())?;
                if status == RadioAccessStatus::Allowed {
                    live::radio_store(&kind, on);
                }
                return Ok(status == RadioAccessStatus::Allowed);
            }
        }
        return Err("No such radio on this PC".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (kind, on);
        Err("Windows only".into())
    }
}

// ---------------------------------------------------------------------------------------
// Control-panel slot backends (start / stop from the island's slot registry)
// ---------------------------------------------------------------------------------------

/// Start or stop the whole Wi-Fi backend (WLAN notification watcher + radio events).
#[tauri::command]
fn wifi_backend(app: AppHandle, on: bool) {
    live::set_radio_active("wifi", on);
    if on {
        wifi::start(app);
    } else {
        wifi::stop();
    }
}

/// Switch the Bluetooth backend on or off. While off, every Bluetooth command returns at once.
#[tauri::command]
fn bt_backend(app: AppHandle, on: bool) {
    live::set_radio_active("bt", on);
    if on {
        bluetooth::start(app);
    } else {
        bluetooth::stop();
    }
}

#[cfg(target_os = "windows")]
fn capture_endpoint() -> Option<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
}

/// Real mute state of the default microphone. None = no capture device.
#[tauri::command]
async fn get_mic_muted() -> Option<bool> {
    #[cfg(target_os = "windows")]
    unsafe {
        let vol = capture_endpoint()?;
        return vol.GetMute().ok().map(|b| b.as_bool());
    }
    #[cfg(not(target_os = "windows"))]
    None
}

/// Mute / unmute the default microphone for the whole system (IAudioEndpointVolume).
#[tauri::command]
async fn set_mic_muted(muted: bool) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::BOOL;
        if let Some(vol) = capture_endpoint() {
            return vol.SetMute(BOOL::from(muted), std::ptr::null()).is_ok();
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = muted;
    false
}

// Keep the screen awake. SetThreadExecutionState is per thread, so one parked thread owns the
// request. It sleeps on a channel (0 % CPU) and releases the request when the sender is dropped.
static KEEP_AWAKE: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> =
    std::sync::Mutex::new(None);

#[tauri::command]
fn set_keep_awake(on: bool) -> bool {
    let mut g = match KEEP_AWAKE.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if on {
        if g.is_none() {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || {
                #[cfg(target_os = "windows")]
                unsafe {
                    use windows::Win32::System::Power::{
                        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED,
                        ES_SYSTEM_REQUIRED,
                    };
                    let _ = SetThreadExecutionState(
                        ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                    );
                }
                let _ = rx.recv(); // blocks until the sender is dropped
                #[cfg(target_os = "windows")]
                unsafe {
                    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
                    let _ = SetThreadExecutionState(ES_CONTINUOUS);
                }
            });
            *g = Some(tx);
        }
    } else {
        *g = None; // dropping the sender wakes the thread, which clears the request
    }
    g.is_some()
}

#[tauri::command]
fn open_bt_settings() {
    shell_open("ms-settings:bluetooth");
}

#[tauri::command]
fn open_location_settings() {
    shell_open("ms-settings:privacy-location");
}

#[tauri::command]
fn open_wifi_settings() {
    shell_open("ms-settings:network-wifi");
}

#[tauri::command]
fn open_url(url: String) {
    // Only web links, and no control characters. ShellExecuteW never goes through cmd.exe,
    // so the text is handed to the default browser as it is and can not run anything.
    if (url.starts_with("http://") || url.starts_with("https://")) && !url.chars().any(|c| c.is_control()) {
        shell_open(&url);
    }
}

#[tauri::command]
fn lock_screen() {
    // LockWorkStation() locks the session directly (no rundll32)
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "user32")]
        extern "system" {
            fn LockWorkStation() -> i32;
        }
        let _ = LockWorkStation();
    }
}

#[tauri::command]
fn take_snip() {
    shell_open("ms-screenclip:");
}

#[tauri::command]
fn launch_quick_action(id: String) {
    // Only the Calculator tile still opens an outside app (through the shell, no cmd.exe).
    if id == "calc" {
        shell_open("calc.exe");
    }
}


#[tauri::command]
fn focus_island(window: WebviewWindow) {
    let _ = window.set_focus();
}

#[tauri::command]
fn setup_shelf_drop(app: AppHandle) {
    shelf::setup_shelf_drop(app);
}

fn generate_chime_wav() -> Vec<u8> {
    let sample_rate: u32 = 44100;
    let duration = 0.85;
    let total_samples = (sample_rate as f32 * duration) as usize;
    let mut pcm: Vec<i16> = vec![0; total_samples];

    let notes = [
        (523.25, 0.00, 0.28), // C5
        (659.25, 0.08, 0.26), // E5
        (783.99, 0.16, 0.24), // G5
        (1046.50, 0.24, 0.22), // C6
    ];

    for &(freq, delay, vol) in &notes {
        let start_sample = (delay * sample_rate as f32) as usize;
        for i in start_sample..total_samples {
            let t = (i - start_sample) as f32 / sample_rate as f32;
            let decay = (-t * 4.5).exp();
            let sample = (2.0 * std::f32::consts::PI * freq * t).sin() * vol * decay;
            let val = (sample * 32767.0) as i32;
            pcm[i] = pcm[i].saturating_add(val as i16);
        }
    }

    let mut wav = Vec::with_capacity(44 + total_samples * 2);
    let data_size = (total_samples * 2) as u32;
    let file_size = 36 + data_size;

    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());

    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for s in pcm {
        wav.extend_from_slice(&s.to_le_bytes());
    }

    wav
}

#[tauri::command]
fn play_alarm_sound() {
    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        unsafe {
            #[link(name = "winmm")]
            extern "system" {
                fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
            }
            const SND_ASYNC: u32 = 0x0001;
            const SND_NODEFAULT: u32 = 0x0002;
            const SND_MEMORY: u32 = 0x0004;
            const SND_FILENAME: u32 = 0x00020000;

            let alarm_file = r"C:\Windows\Media\Alarm01.wav";
            if std::path::Path::new(alarm_file).exists() {
                let hstr = HSTRING::from(alarm_file);
                if PlaySoundW(hstr.as_ptr(), 0, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) != 0 {
                    return;
                }
            }

            static CHIME: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
            let wav = CHIME.get_or_init(generate_chime_wav);
            let _ = PlaySoundW(wav.as_ptr() as *const u16, 0, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
        }
    }
}

static SETTINGS_OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn show_settings_window(app: &AppHandle) {
    let _guard = SETTINGS_OPEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.emit("settings-opened", ());
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("settings.html".into()),
    )
    .title("Inex Island Settings")
    .inner_size(860.0, 640.0)
    .center()
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .resizable(false)
    .shadow(false)
    .skip_taskbar(false)
    .visible(true)
    .focused(true)
    .build()
    {
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn open_settings(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.close();
    }
}

#[tauri::command]
fn drag_settings(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn settings_changed(app: AppHandle, json: String) {
    let _ = app.emit("settings-changed", json);
}

// Autostart lives in two HKCU keys: Run (the command) and StartupApproved\Run (the on/off flag
// shown in Windows' Startup Apps list). Both are read and written with the registry API.
#[cfg(target_os = "windows")]
const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const APPROVED_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_NAME: &str = "Inex Island";

// The exe that should start at login. A dev build (target\\debug) can not start alone, so for
// dev the real release exe (made by `npm run build`) is used instead.
#[cfg(target_os = "windows")]
fn autostart_exe() -> Option<String> {
    let cur = std::env::current_exe().ok()?;
    let s = cur.to_string_lossy().to_string();
    if s.to_lowercase().contains("\\target\\debug\\") {
        let rel = cur
            .parent()
            .and_then(|d| d.parent())
            .map(|t| t.join("release").join("inex-island.exe"))?;
        if rel.exists() {
            return Some(rel.to_string_lossy().to_string());
        }
        return None;
    }
    Some(s)
}

// Writes the Run entry AND marks it "enabled" for Windows' own Startup Apps list.
#[cfg(target_os = "windows")]
fn register_autostart() -> bool {
    let exe = match autostart_exe() {
        Some(e) => e,
        None => {
            log("autostart: no release exe found (run `npm run build` first)");
            return false;
        }
    };
    let value = format!("\"{}\" --autostart", exe);
    let ok = winreg::set_string(RUN_SUBKEY, AUTOSTART_NAME, &value);
    // 02 00 00 00 ... = enabled (Windows writes 03 when the user/Windows disabled it)
    let _ = winreg::set_binary(APPROVED_SUBKEY, AUTOSTART_NAME, &[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    log(&format!("autostart: register {} -> {}", value, ok));
    ok
}

#[tauri::command]
fn set_autostart(on: bool) -> bool {
    #[cfg(target_os = "windows")]
    {
        let marker = data_dir().join("autostart.on");
        if on {
            let ok = register_autostart();
            if ok {
                let _ = std::fs::write(&marker, b"1");
            }
            return ok;
        } else {
            let _ = std::fs::remove_file(&marker);
            let _ = winreg::delete_value(RUN_SUBKEY, AUTOSTART_NAME);
            let _ = winreg::delete_value(APPROVED_SUBKEY, AUTOSTART_NAME);
            return true;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = on;
        false
    }
}

#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        winreg::get_string(RUN_SUBKEY, AUTOSTART_NAME).is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

// If an earlier dev build registered itself for startup, remove that dead entry
#[cfg(target_os = "windows")]
fn drop_stale_autostart() {
    if let Some(text) = winreg::get_string(RUN_SUBKEY, AUTOSTART_NAME) {
        if text.to_lowercase().contains("\\target\\debug\\") {
            let _ = winreg::delete_value(RUN_SUBKEY, AUTOSTART_NAME);
        }
    }
}

#[derive(Serialize)]
struct UpdateCheck {
    available: bool,
    current_version: String,
    latest_version: String,
    error: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> UpdateCheck {
    let current_version = app.package_info().version.to_string();
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateCheck {
                available: false,
                current_version,
                latest_version: String::new(),
                error: Some(e.to_string()),
            }
        }
    };
    match updater.check().await {
        Ok(Some(update)) => UpdateCheck {
            available: true,
            current_version,
            latest_version: update.version,
            error: None,
        },
        Ok(None) => UpdateCheck {
            available: false,
            current_version,
            latest_version: String::new(),
            error: None,
        },
        Err(e) => UpdateCheck {
            available: false,
            current_version,
            latest_version: String::new(),
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn apply_update(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_chunk_len, _content_len| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        log(&format!("PANIC: {}", info));
    }));
    let autostarted = std::env::args().any(|a| a == "--autostart");
    log(&format!("start (autostart={})", autostarted));

    // Started by Windows at login: wait a little so the desktop, taskbar and WebView2 are ready
    // (laptops are slower at boot).
    if autostarted {
        std::thread::sleep(Duration::from_secs(5));
    }

    // SINGLE INSTANCE GUARD: only exit if a REAL Inex Island answers. Anything else on this
    // port (or a dead leftover) must not make the app quit silently.
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:49871".parse().unwrap(),
        Duration::from_millis(800),
    ) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
        let _ = stream.write_all(b"OPEN_SETTINGS");
        let mut buf = [0u8; 8];
        let n = stream.read(&mut buf).unwrap_or(0);
        if &buf[..n] == b"INEX" {
            log("another instance is running, exiting");
            return;
        }
        log("port 49871 answered but not Inex Island, starting anyway");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| {
                drop_stale_autostart();
                // Self-heal: if "Launch at Login" is on, rewrite the entry on every start
                // (fixes moved exe, entries Windows disabled, entries deleted by cleaners).
                if data_dir().join("autostart.on").exists() {
                    register_autostart();
                }
                net::clean_stage();
            });

            // Event-driven watchers (radio on/off, now-playing) - replaces fast polling
            live::start(app.handle().clone());
            brightness::start(app.handle().clone());
            shelf::setup_shelf_drop(app.handle().clone());
            visualizer::setup_audio_visualization(app.handle().clone());
            locker_bridge::start(app.handle().clone());

            #[cfg(target_os = "windows")]
            {
                native_events::setup_native_events(app.handle().clone());
                audio_events::start(app.handle().clone());
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_decorations(false);
                // The window starts hidden (tauri.conf.json). Place it first, then show it,
                // so it never appears in the wrong spot. The page plays the intro animation.
                let w = window.clone();
                std::thread::spawn(move || {
                    let mut placed = place_island(&w, 316.0, 44.0);
                    let mut tries = 0;
                    while !placed && tries < 10 {
                        std::thread::sleep(Duration::from_millis(50));
                        placed = place_island(&w, 316.0, 44.0);
                        tries += 1;
                    }
                    let _ = w.show();
                });
            }

            // Windows shutting down / logging off: native_events.rs reacts to WM_ENDSESSION and exits
            // at once, so no helper process (netsh, powershell...) is started while the system closes
            // (that is what shows "The application was unable to start correctly (0xc0000142)").

            // Listen for second-launch signal (when user clicks Desktop Shortcut)
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(listener) = TcpListener::bind("127.0.0.1:49871") {
                    for stream in listener.incoming().flatten() {
                        let mut s = stream;
                        let mut buf = [0u8; 32];
                        let _ = s.read(&mut buf);
                        let _ = s.write_all(b"INEX");
                        show_settings_window(&handle);
                    }
                }
            });

            // System Tray Icon & Menu (Open Settings / Restart / Quit)
            let open_i = MenuItem::with_id(app, "settings", "Open Settings", true, None::<&str>)?;
            let restart_i =
                MenuItem::with_id(app, "restart", "Restart Inex Island", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Inex Island", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &restart_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Inex Island")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        let h = app.clone();
                        std::thread::spawn(move || show_settings_window(&h));
                    }
                    "restart" => app.restart(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let h = tray.app_handle().clone();
                        std::thread::spawn(move || show_settings_window(&h));
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _ = tray_builder.build(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resize_island,
            clipboard_seq,
            get_clipboard_text,
            clipboard::get_clipboard_image,
            clipboard::get_clipboard_files,
            clipboard::set_clipboard_files,
            clipboard::read_image_file,
            get_net_speed,
            privacy::privacy_watch_start,
            focus_island,
            open_settings,
            close_settings,
            drag_settings,
            play_alarm_sound,
            quit_app,
            restart_app,
            settings_changed,
            set_autostart,
            get_autostart,
            bluetooth::get_bt_battery,
            bluetooth::get_bt_batteries,
            bluetooth::bt_discovery,
            bluetooth::get_bt_nearby,
            bluetooth::bt_pair,
            bluetooth::bt_pair_answer,
            bluetooth::bt_unpair,
            get_system_brightness,
            get_media_status,
            seek_media,
            media_play_pause,
            media_next,
            media_prev,
            set_system_volume,
            get_system_volume,
            get_media_art,
            get_radio_state,
            set_radio_state,
            set_system_brightness,
            get_sys_stats,
            get_sys_load,
            wifi::get_wifi_networks,
            wifi::connect_wifi_network,
            wifi::wifi_join,
            wifi::wifi_forget,
            wifi::get_wifi_status,
            wifi::disconnect_wifi,
            wifi_backend,
            bt_backend,
            get_mic_muted,
            set_mic_muted,
            set_keep_awake,
            bluetooth::get_bt_devices,
            visualizer::set_visualizer_active,
            open_bt_settings,
            open_wifi_settings,
            open_location_settings,
            open_url,
            lock_screen,
            take_snip,
            launch_quick_action,
            audio::get_audio_devices,
            audio::set_default_audio_device,
            audio::open_sound_settings,
            bluetooth::bt_set_connection,
            net::file_info,
            net::read_file_chunk,
            net::recv_begin,
            net::recv_chunk,
            net::recv_end,
            net::recv_abort,
            net::drag_out_file,
            setup_shelf_drop,
            quick_share::start_quick_share,
            quick_share::stop_quick_share,
            quick_share::get_quick_share_status,
            quick_share::start_quick_share_scan,
            quick_share::stop_quick_share_scan,
            quick_share::send_quick_share_files,
            quick_share::respond_quick_share_offer,
            quick_share::control_quick_share,
            quick_share::open_quick_share_downloads,
            quick_share::pick_quick_share_files,
            quick_share::pick_quick_share_folder,
            quick_share::stage_quick_share_files,
            quick_share::get_staged_quick_share_files,
            quick_share::clear_staged_quick_share_files,
            quick_share::stage_file_for_phone,
            quick_share::clear_staged_files,
            quick_share::start_inex_drop,
            quick_share::stop_inex_drop,
            quick_share::get_inex_drop_status,
            quick_share::respond_inex_transfer,
            check_update,
            get_app_version,
            apply_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}