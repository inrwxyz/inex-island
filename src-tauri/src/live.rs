// Event-driven system watchers:
// Native Windows listeners notify Inex Island when states change:
//   * radio_watcher : Wi-Fi / Bluetooth radio switched on/off  -> "radio-changed"
//   * media_watcher : track, play/pause or player changed      -> "media-changed"
// Current Wi-Fi name + signal are retrieved directly via the native WLAN API with 0% idle CPU.

use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[allow(unused_imports)]
use tauri::Emitter;

static RADIO_WIFI: AtomicI8 = AtomicI8::new(-1); // -1 unknown, 0 off, 1 on
static RADIO_BT: AtomicI8 = AtomicI8::new(-1);
static RADIO_AT: AtomicU64 = AtomicU64::new(0); // unix seconds of the last known state

// Which control-panel slots are switched on (set from the island's slot registry).
// A slot that is swapped away stops emitting events and its commands return at once.
static ACT_WIFI: AtomicBool = AtomicBool::new(false);
static ACT_BT: AtomicBool = AtomicBool::new(false);

pub fn set_radio_active(kind: &str, on: bool) {
    match kind {
        "wifi" => ACT_WIFI.store(on, Ordering::Relaxed),
        "bt" => ACT_BT.store(on, Ordering::Relaxed),
        _ => {}
    }
}

fn radio_active(kind: &str) -> bool {
    match kind {
        "wifi" => ACT_WIFI.load(Ordering::Relaxed),
        "bt" => ACT_BT.load(Ordering::Relaxed),
        _ => false,
    }
}

pub fn bt_active() -> bool {
    ACT_BT.load(Ordering::Relaxed)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn slot(kind: &str) -> Option<&'static AtomicI8> {
    match kind {
        "wifi" => Some(&RADIO_WIFI),
        "bt" => Some(&RADIO_BT),
        _ => None,
    }
}

/// Last radio state Windows reported, if it is fresh (the watcher keeps it current;
/// the 30 s limit is only a safety net if an event was ever missed).
pub fn radio_cached(kind: &str) -> Option<bool> {
    let v = slot(kind)?.load(Ordering::Relaxed);
    if v >= 0 && now_secs().saturating_sub(RADIO_AT.load(Ordering::Relaxed)) < 30 {
        Some(v == 1)
    } else {
        None
    }
}

pub fn radio_store(kind: &str, on: bool) {
    if let Some(s) = slot(kind) {
        s.store(on as i8, Ordering::Relaxed);
        RADIO_AT.store(now_secs(), Ordering::Relaxed);
    }
}

/// Connected Wi-Fi network: (name, signal 0-100). None while not connected.
/// Native WLAN API, a few microseconds, no helper process.
#[cfg(target_os = "windows")]
pub fn wifi_now() -> Option<(String, u32)> {
    crate::wifi::current_connection().filter(|(name, _)| !name.is_empty())
}

#[cfg(not(target_os = "windows"))]
pub fn wifi_now() -> Option<(String, u32)> {
    None
}

#[cfg(target_os = "windows")]
fn radio_watcher(app: AppHandle) {
    use windows::Devices::Radios::{Radio, RadioKind, RadioState};
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let radios = match Radio::GetRadiosAsync().ok().and_then(|op| op.get().ok()) {
        Some(r) => r,
        None => return,
    };
    let mut keep: Vec<Radio> = Vec::new();
    for r in radios {
        let kind = match r.Kind() {
            Ok(k) => k,
            Err(_) => continue,
        };
        let name = if kind == RadioKind::WiFi {
            "wifi"
        } else if kind == RadioKind::Bluetooth {
            "bt"
        } else {
            continue;
        };
        if let Ok(st) = r.State() {
            radio_store(name, st == RadioState::On);
        }
        let r2 = r.clone();
        let app2 = app.clone();
        let _ = r.StateChanged(&TypedEventHandler::new(move |_, _| {
            if let Ok(st) = r2.State() {
                radio_store(name, st == RadioState::On);
            }
            if radio_active(name) {
                let _ = app2.emit("radio-changed", ());
            }
            Ok(())
        }));
        keep.push(r); // the watcher thread owns them for the whole run
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
        let _ = &keep;
    }
}

#[cfg(target_os = "windows")]
fn attach_media(
    app: &AppHandle,
    m: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
) {
    use windows::Foundation::TypedEventHandler;
    if let Ok(s) = m.GetCurrentSession() {
        let a = app.clone();
        let _ = s.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
            let _ = a.emit("media-changed", ());
            Ok(())
        }));
        let b = app.clone();
        let _ = s.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
            let _ = b.emit("media-changed", ());
            Ok(())
        }));
    }
}

#[cfg(target_os = "windows")]
fn media_watcher(app: AppHandle) {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Mgr;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let manager = match Mgr::RequestAsync().ok().and_then(|op| op.get().ok()) {
        Some(m) => m,
        None => return,
    };
    attach_media(&app, &manager);
    let m2 = manager.clone();
    let a2 = app.clone();
    let _ = manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
        attach_media(&a2, &m2); // the player changed: listen to the new one
        let _ = a2.emit("media-changed", ());
        Ok(())
    }));
    let m3 = manager.clone();
    let a3 = app.clone();
    let _ = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
        attach_media(&a3, &m3); // a player opened or closed
        let _ = a3.emit("media-changed", ());
        Ok(())
    }));
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(target_os = "windows")]
fn fullscreen_watcher(app: AppHandle) {
    let mut prev_fs: Option<bool> = None;
    loop {
        let is_fs = crate::foreground_is_fullscreen();
        if prev_fs != Some(is_fs) {
            prev_fs = Some(is_fs);
            let _ = app.emit("fullscreen-changed", serde_json::json!({ "is_fullscreen": is_fs }));
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
}

#[cfg(target_os = "windows")]
fn power_watcher(app: AppHandle) {
    let mut prev_power: Option<(i32, bool)> = None;
    loop {
        let current = crate::battery_info();
        if prev_power != Some(current) {
            prev_power = Some(current);
            let _ = app.emit("power-changed", serde_json::json!({
                "battery_pct": current.0,
                "charging": current.1
            }));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Start the watchers (Windows only). Called once from setup().
pub fn start(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let a = app.clone();
        std::thread::spawn(move || radio_watcher(a));
        let b = app.clone();
        std::thread::spawn(move || media_watcher(b));
        let c = app.clone();
        std::thread::spawn(move || fullscreen_watcher(c));
        let d = app;
        std::thread::spawn(move || power_watcher(d));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
