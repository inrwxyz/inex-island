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
fn apply_desktop_monitor_brightness(level: u32) {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
    };
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

    unsafe {
        let hwnd = GetDesktopWindow();
        let hmonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        let mut count = 0u32;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(hmonitor, &mut count).is_ok() && count > 0 {
            let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(hmonitor, &mut monitors).is_ok() {
                for mon in &monitors {
                    let _ = SetMonitorBrightness(mon.hPhysicalMonitor, level);
                }
                let _ = DestroyPhysicalMonitors(&monitors);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn get_desktop_monitor_brightness() -> Option<u32> {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, PHYSICAL_MONITOR,
    };
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

    unsafe {
        let hwnd = GetDesktopWindow();
        let hmonitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        let mut count = 0u32;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(hmonitor, &mut count).is_ok() && count > 0 {
            let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(hmonitor, &mut monitors).is_ok() {
                let mut min = 0u32;
                let mut cur = 0u32;
                let mut max = 0u32;
                let res = GetMonitorBrightness(monitors[0].hPhysicalMonitor, &mut min, &mut cur, &mut max);
                let _ = DestroyPhysicalMonitors(&monitors);
                if res != 0 {
                    return Some(cur);
                }
            }
        }
    }
    None
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

        // 1. Physical desktop monitor hardware brightness via DDC/CI
        apply_desktop_monitor_brightness(level);

        // 2. Direct hardware display gamma ramp (works on 100% laptops & desktop monitors)
        apply_hardware_brightness(level);

        // 3. Also try WMI for native laptop panel firmware brightness
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
    let mut initialized = false;

    // 1. Try native desktop monitor DDC/CI first
    if let Some(cur) = get_desktop_monitor_brightness() {
        CURRENT.store(cur, Ordering::Relaxed);
        let _ = app.emit("brightness-changed", cur);
        initialized = true;
    }

    // 2. Try WMI for laptop panel
    let con = connect();
    if let Some(c) = con.as_ref() {
        if let Ok(list) = c.query::<MonitorBrightness>() {
            if let Some(b) = list.first() {
                CURRENT.store(b.current_brightness as u32, Ordering::Relaxed);
                let _ = app.emit("brightness-changed", b.current_brightness as u32);
                initialized = true;
            }
        }
    }

    // If neither returned a value, default to 100 so slider is initialized
    if !initialized && CURRENT.load(Ordering::Relaxed) == UNKNOWN {
        CURRENT.store(100, Ordering::Relaxed);
        let _ = app.emit("brightness-changed", 100u32);
    }

    let Some(c) = con else { return };
    loop {
        if let Ok(events) = c.raw_notification::<BrightnessEvent>("SELECT * FROM WmiMonitorBrightnessEvent") {
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

// Brightness goes through WMI on a worker thread (brightness.rs): no PowerShell.
#[tauri::command]
pub fn set_system_brightness(level: u32) {
    set(level);
}

/// Last known brightness, or None when this PC has no controllable panel.
#[tauri::command]
pub fn get_system_brightness() -> Option<u32> {
    current()
}
