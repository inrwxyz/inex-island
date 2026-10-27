#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bluetooth;
mod brightness;
mod live;
mod locker_bridge;
mod net;
mod shelf;
mod visualizer;
mod wifi;

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow,
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
        return GetSystemMetrics(SYSTEM_METRICS_INDEX(0x2000)) != 0;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

// Every helper process starts without a console window
fn cmd(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW; PowerShell helpers also run at BELOW_NORMAL priority so they can
        // never make the desktop or the island stutter.
        let flags: u32 = if program.eq_ignore_ascii_case("powershell") {
            0x0800_0000 | 0x0000_4000
        } else {
            0x0800_0000
        };
        c.creation_flags(flags);
    }
    c
}

#[derive(Serialize)]
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
    disk_pct: u32,
    battery_pct: i32,
    charging: bool,
    wifi_name: String,
    wifi_signal: u32,
    wifi_on: bool,
    is_fullscreen: bool,
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
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.set_position(LogicalPosition::new(x, top));
        return true;
    }
    false
}

// 1. Real Windows Media Status (Spotify & YouTube)
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
                if let Ok(session) = manager.GetCurrentSession() {
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
                if let Ok(session) = manager.GetCurrentSession() {
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
    let session = manager.GetCurrentSession().ok()?;
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
                if let Ok(session) = manager.GetCurrentSession() {
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
                if let Ok(session) = manager.GetCurrentSession() {
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
                if let Ok(session) = manager.GetCurrentSession() {
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
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW, IsZoomed,
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
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Windows.UI.Core.CoreWindow"
        ) {
            return false;
        }
        // Ignore our own Island or Settings window
        let mut title_buf = [0u16; 64];
        let tn = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..tn.max(0) as usize]);
        if title.contains("Inex Island") {
            return false;
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

#[allow(unused_assignments)]
#[tauri::command]
async fn get_sys_stats() -> SysStats {
    let mut ram_pct = 0;
    let (mut cpu_pct, mut disk_pct, mut battery_pct, mut charging) = (0, 0, -1, false);
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

#[tauri::command]
fn launch_notepad() {
    #[cfg(target_os = "windows")]
    {
        let _ = cmd("notepad.exe").spawn();
    }
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
fn launch_quick_share() {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
        $paths = @(
            "$env:ProgramFiles\Google\NearbyShare\nearby_share.exe",
            "$env:ProgramFiles\Google\Quick Share\nearby_share.exe",
            "$env:LOCALAPPDATA\Programs\Google\Quick Share\nearby_share.exe"
        )
        $found = $false
        foreach ($p in $paths) {
            if (Test-Path $p) { Start-Process $p; $found = $true; break }
        }
        if (-not $found) {
            $app = Get-StartApps | Where-Object { $_.Name -like '*Quick Share*' } | Select-Object -First 1
            if ($app) { Start-Process "shell:AppsFolder\$($app.AppID)" }
            else { Start-Process "ms-settings:crossdevice" }
        }
        "#;
        let _ = cmd("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script])
            .spawn();
    }
}

#[tauri::command]
fn open_bt_settings() {
    #[cfg(target_os = "windows")]
    {
        let _ = cmd("cmd")
            .args(["/C", "start", "ms-settings:bluetooth"])
            .spawn();
    }
}

#[tauri::command]
fn open_location_settings() {
    #[cfg(target_os = "windows")]
    {
        let _ = cmd("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-location"])
            .spawn();
    }
}

// Where this PC is, from the Windows Location service (Windows.Devices.Geolocation).
// One short call, no helper process; the island remembers the answer for hours.
// Returns "lat,lon|" or None when Location is off / not allowed for desktop apps
// (the island then falls back to the place of the internet connection).
#[tauri::command]
async fn get_location() -> Option<String> {
    None
}

#[tauri::command]
fn open_wifi_settings() {
    #[cfg(target_os = "windows")]
    {
        let _ = cmd("cmd")
            .args(["/C", "start", "ms-settings:network-wifi"])
            .spawn();
    }
}

#[tauri::command]
fn open_url(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = cmd("cmd")
            .args(["/C", "start", "", &url])
            .spawn();
    }
}

#[tauri::command]
fn lock_screen() {
    #[cfg(target_os = "windows")]
    {
        let _ = cmd("rundll32.exe")
            .args(["user32.dll,LockWorkStation"])
            .spawn();
    }
}

#[tauri::command]
fn take_snip() {
    #[cfg(target_os = "windows")]
    {
        let _ = cmd("cmd")
            .args(["/C", "start", "ms-screenclip:"])
            .spawn();
    }
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

// True while the Windows lock screen is up (Win+L, Dynamic Lock, idle lock, sign-in screen).
#[tauri::command]
fn is_session_locked() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "wtsapi32")]
        extern "system" {
            fn WTSQuerySessionInformationW(
                h: isize,
                session: u32,
                class: i32,
                buf: *mut *mut u16,
                len: *mut u32,
            ) -> i32;
            fn WTSFreeMemory(p: *mut core::ffi::c_void);
        }
        #[link(name = "user32")]
        extern "system" {
            fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> isize;
            fn CloseDesktop(h: isize) -> i32;
        }
        // 1) Session info: SessionFlags == 0 means locked (not fooled by UAC prompts)
        let mut p: *mut u16 = std::ptr::null_mut();
        let mut n: u32 = 0;
        if WTSQuerySessionInformationW(0, 0xFFFF_FFFF, 25, &mut p, &mut n) != 0 && !p.is_null() {
            let flags = if n >= 16 {
                Some(*((p as *const u8).add(12) as *const i32))
            } else {
                None
            };
            WTSFreeMemory(p as *mut core::ffi::c_void);
            if let Some(f) = flags {
                return f == 0;
            }
        }
        // 2) Fallback: the input desktop can not be opened while the lock screen is up
        let h = OpenInputDesktop(0, 0, 0x0100);
        if h == 0 {
            return true;
        }
        CloseDesktop(h);
        return false;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[tauri::command]
fn island_visible(window: WebviewWindow) -> bool {
    window.is_visible().unwrap_or(true)
}

#[tauri::command]
fn focus_island(window: WebviewWindow) {
    let _ = window.set_focus();
}

#[tauri::command]
fn setup_shelf_drop(app: AppHandle) {
    shelf::setup_shelf_drop(app);
}

fn show_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.hide();
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

const APPROVED_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

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
    let ok = cmd("reg")
        .args(["add", RUN_KEY, "/v", "Inex Island", "/t", "REG_SZ", "/d", value.as_str(), "/f"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    // 02 00 00 00 ... = enabled (Windows writes 03 when the user/Windows disabled it)
    let _ = cmd("reg")
        .args([
            "add", APPROVED_KEY, "/v", "Inex Island", "/t", "REG_BINARY", "/d",
            "020000000000000000000000", "/f",
        ])
        .output();
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
            let _ = cmd("reg")
                .args(["delete", RUN_KEY, "/v", "Inex Island", "/f"])
                .output();
            let _ = cmd("reg")
                .args(["delete", APPROVED_KEY, "/v", "Inex Island", "/f"])
                .output();
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
        if let Ok(out) = cmd("reg")
            .args(["query", RUN_KEY, "/v", "Inex Island"])
            .output()
        {
            return out.status.success();
        }
    }
    false
}

// If an earlier dev build registered itself for startup, remove that dead entry
#[cfg(target_os = "windows")]
fn drop_stale_autostart() {
    if let Ok(out) = cmd("reg").args(["query", RUN_KEY, "/v", "Inex Island"]).output() {
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("\\target\\debug\\") {
            let _ = cmd("reg")
                .args(["delete", RUN_KEY, "/v", "Inex Island", "/f"])
                .output();
        }
    }
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" && !system_shutting_down() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_decorations(false);
                // The window starts hidden (tauri.conf.json). Place it first, then show it,
                // so it never appears in the wrong spot. The page plays the intro animation.
                let w = window.clone();
                std::thread::spawn(move || {
                    let mut placed = place_island(&w, 290.0, 44.0);
                    let mut tries = 0;
                    while !placed && tries < 20 {
                        std::thread::sleep(Duration::from_millis(500));
                        placed = place_island(&w, 290.0, 44.0);
                        tries += 1;
                    }
                    log(&format!("island placed={} tries={}", placed, tries));
                    std::thread::sleep(Duration::from_millis(250)); // let the page finish loading
                    let _ = w.show();
                });
            }

            // Windows is shutting down / logging off: stop at once so no helper process
            // (netsh, powershell...) is started while the system is closing. Starting
            // processes at that moment is what shows "The application was unable to
            // start correctly (0xc0000142)".
            let exit_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(300));
                if system_shutting_down() {
                    log("system shutting down, exiting");
                    exit_handle.exit(0);
                    break;
                }
            });

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
                    "settings" => show_settings_window(app),
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
                        show_settings_window(tray.app_handle());
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
            focus_island,
            island_visible,
            is_session_locked,
            open_settings,
            close_settings,
            drag_settings,
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
            wifi::get_wifi_networks,
            wifi::wifi_scan,
            wifi::connect_wifi_network,
            wifi::wifi_join,
            wifi::wifi_forget,
            wifi::get_wifi_status,
            wifi::disconnect_wifi,
            wifi_backend,
            bt_backend,
            get_mic_muted,
            set_mic_muted,
            launch_notepad,
            set_keep_awake,
            bluetooth::get_bt_devices,
            visualizer::set_visualizer_active,
            launch_quick_share,
            open_bt_settings,
            open_wifi_settings,
            open_location_settings,
            open_url,
            get_location,
            lock_screen,
            take_snip,
            bluetooth::bt_set_connection,
            net::file_info,
            net::read_file_chunk,
            net::recv_begin,
            net::recv_chunk,
            net::recv_end,
            net::recv_abort,
            net::drag_out_file,
            net::native_prompt,
            net::stage_begin,
            net::stage_end,
            setup_shelf_drop,
            apply_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}