// Screen brightness through WMI (the same system Windows uses for laptop panels).
// No PowerShell: a small worker thread keeps one WMI connection open and sleeps
// (0 % CPU) until the slider is moved. Windows also tells us when the brightness
// changes by itself (Fn keys, Windows quick settings, auto-brightness), so the
// slider can follow it with no polling.
//
//   brightness::start(app)   once at startup (two parked threads)
//   brightness::set(level)   slider moved
//   brightness::current()    last known level, None on PCs without a controllable panel
//
// Event: "brightness-changed" with the new level (0-100).

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{mpsc, OnceLock};
use tauri::AppHandle;
#[allow(unused_imports)]
use tauri::Emitter;

const UNKNOWN: u32 = u32::MAX;
static CURRENT: AtomicU32 = AtomicU32::new(UNKNOWN);
static LAST_SET_MS: AtomicI64 = AtomicI64::new(0);
static TX: OnceLock<mpsc::Sender<u32>> = OnceLock::new();

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
#[derive(Deserialize, Debug)]
#[serde(rename = "WmiMonitorBrightness")]
#[serde(rename_all = "PascalCase")]
struct MonitorBrightness {
    current_brightness: u8,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize, Debug)]
#[serde(rename = "WmiMonitorBrightnessEvent")]
#[serde(rename_all = "PascalCase")]
struct BrightnessEvent {
    brightness: u8,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize, Debug)]
#[serde(rename = "WmiMonitorBrightnessMethods")]
struct MonitorMethods {
    #[serde(rename = "__Path")]
    path: String,
}

#[cfg(target_os = "windows")]
#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct SetBrightnessIn {
    timeout: u32,
    brightness: u8,
}

#[cfg(target_os = "windows")]
#[derive(Deserialize, Debug)]
struct NoOut {}

/// Last known brightness (0-100). None when this PC has no WMI-controllable panel.
pub fn current() -> Option<u32> {
    let v = CURRENT.load(Ordering::Relaxed);
    if v == UNKNOWN {
        None
    } else {
        Some(v)
    }
}

/// Ask for a new brightness. Returns at once; the worker thread applies it.
pub fn set(level: u32) {
    let level = level.min(100);
    CURRENT.store(level, Ordering::Relaxed);
    LAST_SET_MS.store(now_ms(), Ordering::Relaxed);
    if let Some(tx) = TX.get() {
        let _ = tx.send(level);
    }
}

#[cfg(target_os = "windows")]
fn connect() -> Option<wmi::WMIConnection> {
    let com = wmi::COMLibrary::new().ok()?;
    wmi::WMIConnection::with_namespace_path("root\\WMI", com).ok()
}

#[cfg(target_os = "windows")]
fn apply_hardware_brightness(level: u32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, HDC};

    extern "system" {
        fn SetDeviceGammaRamp(
            hdc: HDC,
            lp_ramp: *const std::ffi::c_void,
        ) -> windows::Win32::Foundation::BOOL;
    }

    unsafe {
        let dc = GetDC(HWND::default());
        if !dc.is_invalid() {
            // Level is 0 to 100.
            // Minimum visible brightness factor is 0.15 (so screen doesn't go pitch black at 0)
            let factor = 0.15 + (level.min(100) as f64 / 100.0) * 0.85;
            let mut ramp = [0u16; 768];
            for i in 0..256 {
                let v = ((i as f64) * 256.0 * factor).min(65535.0) as u16;
                ramp[i] = v;          // Red
                ramp[256 + i] = v;    // Green
                ramp[512 + i] = v;    // Blue
            }
            let _ = SetDeviceGammaRamp(dc, ramp.as_ptr() as *const _);
            let _ = ReleaseDC(HWND::default(), dc);
        }
    }
}

#[cfg(target_os = "windows")]
fn worker(rx: mpsc::Receiver<u32>) {
    let mut con: Option<wmi::WMIConnection> = None;
    while let Ok(first) = rx.recv() {
        // the slider sends many values while dragging: wait a moment and keep only the last
        std::thread::sleep(std::time::Duration::from_millis(30));
        let mut level = first;
        while let Ok(v) = rx.try_recv() {
            level = v;
        }

        // 1. Direct hardware display gamma ramp (works on 100% laptops & desktop monitors)
        apply_hardware_brightness(level);

        // 2. Also try WMI for native laptop panel firmware brightness
        if con.is_none() {
            con = connect();
        }
        if let Some(c) = con.as_ref() {
            let items: Vec<MonitorMethods> = c
                .raw_query("SELECT * FROM WmiMonitorBrightnessMethods")
                .unwrap_or_default();
            for m in items {
                let _ = c.exec_instance_method::<MonitorMethods, SetBrightnessIn, NoOut>(
                    &m.path,
                    "WmiSetBrightness",
                    SetBrightnessIn { timeout: 0, brightness: level as u8 },
                );
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn event_thread(app: AppHandle) {
    let Some(c) = connect() else { return };
    if let Ok(list) = c.query::<MonitorBrightness>() {
        if let Some(b) = list.first() {
            CURRENT.store(b.current_brightness as u32, Ordering::Relaxed);
            let _ = app.emit("brightness-changed", b.current_brightness as u32);
        }
    }
    loop {
        match c.raw_notification::<BrightnessEvent>("SELECT * FROM WmiMonitorBrightnessEvent") {
            Ok(events) => {
                for ev in events.flatten() {
                    let level = ev.brightness as u32;
                    // ignore the echo of our own change
                    if now_ms() - LAST_SET_MS.load(Ordering::Relaxed) < 2000 {
                        continue;
                    }
                    if CURRENT.swap(level, Ordering::Relaxed) != level {
                        let _ = app.emit("brightness-changed", level);
                    }
                }
            }
            Err(_) => {}
        }
        // the subscription ended or could not start: try again later (a sleeping thread costs nothing)
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

pub fn start(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = mpsc::channel::<u32>();
        if TX.set(tx).is_ok() {
            std::thread::spawn(move || worker(rx));
        }
        std::thread::spawn(move || event_thread(app));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
