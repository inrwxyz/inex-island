// Event-driven system watchers:
// Native Windows listeners notify Inex Island when states change:
//   * radio_watcher : Wi-Fi / Bluetooth radio switched on/off  -> "radio-changed"
//   * media_watcher : track, play/pause or player changed      -> "media-changed"
//                     seek / position changed in the player    -> "media-timeline-changed"
// (fullscreen, power, lock, clipboard ... live in native_events.rs; volume / mic mute in audio_events.rs)
// Current Wi-Fi name + signal are retrieved directly via the native WLAN API with 0% idle CPU.

use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[allow(unused_imports)]
use tauri::Emitter;

static RADIO_WIFI: AtomicI8 = AtomicI8::new(-1); // -1 unknown, 0 off, 1 on
static RADIO_BT: AtomicI8 = AtomicI8::new(-1);
static RADIO_AT: AtomicU64 = AtomicU64::new(0); // unix seconds of the last known state
// Is there such an ADAPTER in the PC at all (dongle plugged in / built-in card present)?  -1 unknown, 0 none, 1 yes.
static PRESENT_WIFI: AtomicI8 = AtomicI8::new(-1);
static PRESENT_BT: AtomicI8 = AtomicI8::new(-1);

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

fn present_slot(kind: &str) -> Option<&'static AtomicI8> {
    match kind {
        "wifi" => Some(&PRESENT_WIFI),
        "bt" => Some(&PRESENT_BT),
        _ => None,
    }
}

/// None = not checked yet.
pub fn radio_present_known(kind: &str) -> Option<bool> {
    let v = present_slot(kind)?.load(Ordering::Relaxed);
    if v >= 0 { Some(v == 1) } else { None }
}

/// "Not checked yet" counts as present, so nothing is ever blocked by mistake.
pub fn radio_present(kind: &str) -> bool {
    radio_present_known(kind).unwrap_or(true)
}

pub fn bt_present() -> bool {
    radio_present("bt")
}

/// Remember whether the adapter exists. Returns the old value (-1 / 0 / 1).
pub fn present_store(kind: &str, present: bool) -> i8 {
    present_slot(kind).map(|s| s.swap(present as i8, Ordering::Relaxed)).unwrap_or(-1)
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

/// Adapter plugged in / removed. Called from the radio watcher only.
#[cfg(target_os = "windows")]
fn adapter_changed(app: &AppHandle, name: &str, present: bool) {
    let old = present_store(name, present);
    if old == present as i8 {
        return;
    }
    if !present {
        // no adapter = no state to show
        if let Some(sl) = slot(name) {
            sl.store(-1, Ordering::Relaxed);
        }
    }
    if name == "bt" && radio_active("bt") {
        if present && old == 0 {
            crate::bluetooth::start(app.clone()); // dongle plugged in: bring the device watchers back
        } else if !present {
            crate::bluetooth::stop(); // dongle gone: nothing left to watch
        }
    }
    let _ = app.emit("radio-changed", ());
}

/// Radio on/off (Wi-Fi, Bluetooth) AND adapter hot-plug, all from Windows events: zero polling.
/// A DeviceWatcher on the radio selector fires when an adapter appears or disappears; each burst of events
/// triggers one re-scan of the radios.
#[cfg(target_os = "windows")]
fn radio_watcher(app: AppHandle) {
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationUpdate, DeviceWatcher};
    use windows::Devices::Radios::{Radio, RadioKind, RadioState};
    use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let (tx, rx) = mpsc::channel::<()>();
    let mut _watcher: Option<DeviceWatcher> = None; // kept alive for the whole run
    if let Ok(sel) = Radio::GetDeviceSelector() {
        if let Ok(w) = DeviceInformation::CreateWatcherAqsFilter(&sel) {
            let t1 = tx.clone();
            let _ = w.Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(move |_, _| {
                let _ = t1.send(());
                Ok(())
            }));
            let t2 = tx.clone();
            let _ = w.Removed(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, _| {
                let _ = t2.send(());
                Ok(())
            }));
            let _ = w.Start();
            _watcher = Some(w);
        }
    }
    let _ = tx.send(()); // first look right now

    let mut hooked: Vec<(Radio, EventRegistrationToken)> = Vec::new();
    while rx.recv().is_ok() {
        // one plug-in produces a burst of events: wait until it is quiet, then look once
        while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}

        for (r, t) in hooked.drain(..) {
            let _ = r.RemoveStateChanged(t);
        }
        let Some(radios) = Radio::GetRadiosAsync().ok().and_then(|op| op.get().ok()) else {
            continue; // cannot tell right now: keep what we knew
        };
        let (mut has_wifi, mut has_bt) = (false, false);
        for r in radios {
            let Ok(kind) = r.Kind() else { continue };
            let name = if kind == RadioKind::WiFi {
                has_wifi = true;
                "wifi"
            } else if kind == RadioKind::Bluetooth {
                has_bt = true;
                "bt"
            } else {
                continue;
            };
            if let Ok(st) = r.State() {
                radio_store(name, st == RadioState::On);
            }
            let r2 = r.clone();
            let app2 = app.clone();
            if let Ok(token) = r.StateChanged(&TypedEventHandler::new(move |_, _| {
                if let Ok(st) = r2.State() {
                    radio_store(name, st == RadioState::On);
                }
                if radio_active(name) {
                    let _ = app2.emit("radio-changed", ());
                }
                Ok(())
            })) {
                hooked.push((r, token));
            }
        }
        adapter_changed(&app, "wifi", has_wifi);
        adapter_changed(&app, "bt", has_bt);
    }
}

#[cfg(target_os = "windows")]
fn hook_session(
    app: &AppHandle,
    s: &windows::Media::Control::GlobalSystemMediaTransportControlsSession,
) {
    use windows::Foundation::TypedEventHandler;
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
    // the player was seeked / its position was corrected (also from another app)
    let c = app.clone();
    let _ = s.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
        let _ = c.emit("media-timeline-changed", ());
        Ok(())
    }));
}

#[cfg(target_os = "windows")]
fn is_self_media_session(s: &windows::Media::Control::GlobalSystemMediaTransportControlsSession) -> bool {
    let raw = s.SourceAppUserModelId().map(|x| x.to_string()).unwrap_or_default().to_ascii_lowercase();
    raw.contains("inex") || raw.contains("island") || raw.contains("tauri")
}

#[cfg(target_os = "windows")]
fn attach_media(
    app: &AppHandle,
    m: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
) {
    if let Ok(sessions) = m.GetSessions() {
        for s in sessions {
            if !is_self_media_session(&s) {
                hook_session(app, &s);
            }
        }
    } else if let Ok(s) = m.GetCurrentSession() {
        if !is_self_media_session(&s) {
            hook_session(app, &s);
        }
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

/// Start the watchers (Windows only). Called once from setup().
pub fn start(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let a = app.clone();
        std::thread::spawn(move || radio_watcher(a));
        let b = app;
        std::thread::spawn(move || media_watcher(b));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
