// Native Bluetooth for INEX Island (Windows). No PowerShell, no helper process.
//
//   * DeviceWatchers (WinRT) tell us when a paired device is added / removed or connects /
//     disconnects  -> "bluetooth-changed". They run only while the Bluetooth slot is shown
//     (bt_backend(true) -> start(), bt_backend(false) -> stop()), so a swapped-away slot uses 0 %.
//   * Discovery of NEW devices runs only while the Bluetooth list is open (bt_discovery).
//   * Pairing uses DeviceInformationCustomPairing: confirm / show PIN / type PIN are answered
//     inside the island through the "bt-pairing" event and the bt_pair_answer command.
//   * Connect / disconnect: BluetoothSetServiceState on the device's audio services.
//   * Battery: the PnP property Windows Settings shows, read through SetupAPI.
//
// Written for INEX from the public Windows API documentation.

use serde::Serialize;
#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{mpsc, Arc, Mutex};
use tauri::AppHandle;
#[allow(unused_imports)]
use tauri::Emitter;

#[derive(Serialize)]
pub struct BtDev {
    pub name: String,
    pub connected: bool,
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct BtBatt {
    pub name: String,
    pub pct: i32,
}

#[derive(Serialize, Clone)]
pub struct BtNearby {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Serialize, Clone)]
struct PairingPrompt {
    id: String,
    name: String,
    kind: String, // "confirm_pin" | "display_pin" | "provide_pin"
    pin: String,
}

// Device type from the name (works for most mice, keyboards, earbuds ...)
fn bt_kind_from_name(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["keyboard", "keychron", "mx keys", "k380", "k480"]) {
        "keyboard"
    } else if has(&["mouse", "mx master", "mx anywhere", "trackball", "trackpad", "pebble"]) {
        "mouse"
    } else if has(&[
        "headphone", "headset", "earbud", "buds", "airpods", "earphone", "neckband", "tws",
        "airdopes", "rockerz", "wh-", "wf-", "earpods",
    ]) {
        "headphones"
    } else if has(&["speaker", "soundbar", "boom", "megaboom", "party"]) {
        "speaker"
    } else if has(&["iphone", "phone", "galaxy", "pixel", "redmi", "oneplus", "realme", "poco", "vivo", "oppo"]) {
        "phone"
    } else if has(&["watch", "band"]) {
        "watch"
    } else if has(&["controller", "gamepad", "xbox", "dualshock", "dualsense"]) {
        "gamepad"
    } else {
        ""
    }
}

// Classic Bluetooth "class of device" -> kind
fn bt_kind_classic(major: i32, minor: i32) -> &'static str {
    match major {
        4 => match minor {
            5 | 7 | 8 | 10 | 15 => "speaker",
            _ => "headphones",
        },
        2 => "phone",
        1 => "computer",
        7 => "watch",
        _ => "",
    }
}

// Bluetooth LE appearance -> kind
fn bt_kind_le(category: u16, sub: u16) -> &'static str {
    match category {
        1 => "phone",
        2 => "computer",
        3 => "watch",
        15 => match sub {
            1 => "keyboard",
            2 => "mouse",
            3 | 4 => "gamepad",
            _ => "",
        },
        _ => "",
    }
}

#[cfg(target_os = "windows")]
fn bt_paired_winrt() -> Option<Vec<BtDev>> {
    use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice};
    use windows::Devices::Enumeration::DeviceInformation;
    let mut out: Vec<BtDev> = Vec::new();
    let mut any_ok = false;

    // 1) classic Bluetooth (headphones, speakers, phones ...)
    if let Ok(sel) = BluetoothDevice::GetDeviceSelectorFromPairingState(true) {
        if let Some(devs) = DeviceInformation::FindAllAsyncAqsFilter(&sel)
            .ok()
            .and_then(|o| o.get().ok())
        {
            any_ok = true;
            for i in 0..devs.Size().unwrap_or(0) {
                let Ok(info) = devs.GetAt(i) else { continue };
                let name = info.Name().map(|s| s.to_string()).unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let dev = info
                    .Id()
                    .ok()
                    .and_then(|id| BluetoothDevice::FromIdAsync(&id).ok())
                    .and_then(|op| op.get().ok());
                let connected = dev
                    .as_ref()
                    .and_then(|d| d.ConnectionStatus().ok())
                    .map(|st| st == BluetoothConnectionStatus::Connected)
                    .unwrap_or(false);
                let mut kind = bt_kind_from_name(&name).to_string();
                if kind.is_empty() {
                    if let Some(d) = &dev {
                        if let Ok(c) = d.ClassOfDevice() {
                            let major = c.MajorClass().map(|m| m.0).unwrap_or(0);
                            let minor = c.MinorClass().map(|m| m.0).unwrap_or(0);
                            kind = bt_kind_classic(major, minor).to_string();
                        }
                    }
                }
                out.push(BtDev { name, connected, kind });
            }
        }
    }

    // 2) Bluetooth LE (most modern mice / keyboards / some earbuds are LE only)
    if let Ok(sel) = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true) {
        if let Some(devs) = DeviceInformation::FindAllAsyncAqsFilter(&sel)
            .ok()
            .and_then(|o| o.get().ok())
        {
            any_ok = true;
            for i in 0..devs.Size().unwrap_or(0) {
                let Ok(info) = devs.GetAt(i) else { continue };
                let name = info.Name().map(|s| s.to_string()).unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let dev = info
                    .Id()
                    .ok()
                    .and_then(|id| BluetoothLEDevice::FromIdAsync(&id).ok())
                    .and_then(|op| op.get().ok());
                let connected = dev
                    .as_ref()
                    .and_then(|d| d.ConnectionStatus().ok())
                    .map(|st| st == BluetoothConnectionStatus::Connected)
                    .unwrap_or(false);
                let mut kind = bt_kind_from_name(&name).to_string();
                if kind.is_empty() {
                    if let Some(d) = &dev {
                        if let Ok(ap) = d.Appearance() {
                            let cat = ap.Category().unwrap_or(0);
                            let sub = ap.SubCategory().unwrap_or(0);
                            kind = bt_kind_le(cat, sub).to_string();
                        }
                    }
                }
                if let Some(ex) = out.iter_mut().find(|x| x.name == name) {
                    ex.connected = ex.connected || connected;
                    if ex.kind.is_empty() {
                        ex.kind = kind;
                    }
                } else {
                    out.push(BtDev { name, connected, kind });
                }
            }
        }
    }

    if !any_ok {
        return None;
    }
    out.sort_by(|a, b| b.connected.cmp(&a.connected).then(a.name.cmp(&b.name)));
    Some(out)
}


// =====================================================================================
// Watchers (event-driven, no polling)
// =====================================================================================

/// A DeviceWatcher plus the handler tokens, so it can be stopped and fully released.
#[cfg(target_os = "windows")]
struct WatchHandle {
    w: windows::Devices::Enumeration::DeviceWatcher,
    added: windows::Foundation::EventRegistrationToken,
    removed: windows::Foundation::EventRegistrationToken,
    updated: windows::Foundation::EventRegistrationToken,
    done: windows::Foundation::EventRegistrationToken,
}

// DeviceWatcher is an agile (free-threaded) WinRT object: it may be used from any thread.
#[cfg(target_os = "windows")]
struct SendBox<T>(T);
#[cfg(target_os = "windows")]
unsafe impl<T> Send for SendBox<T> {}

#[cfg(target_os = "windows")]
fn release(h: WatchHandle) {
    let _ = h.w.Stop();
    let _ = h.w.RemoveAdded(h.added);
    let _ = h.w.RemoveRemoved(h.removed);
    let _ = h.w.RemoveUpdated(h.updated);
    let _ = h.w.RemoveEnumerationCompleted(h.done);
}

#[cfg(target_os = "windows")]
static MAIN_WATCH: Mutex<Vec<SendBox<WatchHandle>>> = Mutex::new(Vec::new());
#[cfg(target_os = "windows")]
static SCAN_WATCH: Mutex<Vec<SendBox<WatchHandle>>> = Mutex::new(Vec::new());
#[cfg(target_os = "windows")]
static MAIN_GEN: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static SCAN_GEN: AtomicU64 = AtomicU64::new(0);
// unpaired devices found nearby: id -> name
#[cfg(target_os = "windows")]
static NEARBY: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[cfg(target_os = "windows")]
fn com_init() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// Build + start one watcher for an AQS selector. `on_event` runs for every change that
/// happens after the first enumeration has finished.
#[cfg(target_os = "windows")]
fn make_watcher(
    selector: &windows::core::HSTRING,
    on_added: impl Fn(&windows::Devices::Enumeration::DeviceInformation) + Send + Sync + 'static,
    on_removed: impl Fn(&str) + Send + Sync + 'static,
    on_change: impl Fn() + Send + Sync + 'static,
) -> Option<WatchHandle> {
    use windows::Devices::Enumeration::{
        DeviceInformation, DeviceInformationUpdate, DeviceWatcher,
    };
    use windows::Foundation::TypedEventHandler;
    use windows::core::IInspectable;

    let w = DeviceInformation::CreateWatcherAqsFilter(selector).ok()?;
    let ready = Arc::new(AtomicBool::new(false));
    let on_added = Arc::new(on_added);
    let on_removed = Arc::new(on_removed);
    let on_change = Arc::new(on_change);

    let (r1, a1, c1) = (ready.clone(), on_added.clone(), on_change.clone());
    let added = w
        .Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(move |_, info| {
            if let Some(info) = info {
                a1(info);
            }
            if r1.load(Ordering::Relaxed) {
                c1();
            }
            Ok(())
        }))
        .ok()?;

    let (r2, rm2, c2) = (ready.clone(), on_removed.clone(), on_change.clone());
    let removed = w
        .Removed(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, up| {
            if let Some(up) = up {
                if let Ok(id) = up.Id() {
                    rm2(&id.to_string());
                }
            }
            if r2.load(Ordering::Relaxed) {
                c2();
            }
            Ok(())
        }))
        .ok()?;

    let (r3, c3) = (ready.clone(), on_change.clone());
    let updated = w
        .Updated(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, _| {
            if r3.load(Ordering::Relaxed) {
                c3();
            }
            Ok(())
        }))
        .ok()?;

    let r4 = ready.clone();
    let done = w
        .EnumerationCompleted(&TypedEventHandler::<DeviceWatcher, IInspectable>::new(move |_, _| {
            r4.store(true, Ordering::Relaxed);
            Ok(())
        }))
        .ok()?;

    w.Start().ok()?;
    Some(WatchHandle { w, added, removed, updated, done })
}

/// Start the paired-device watchers (classic + LE, paired + connected).
pub fn start(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let gen = MAIN_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice};
            com_init();
            stop_main();
            let mut sels = Vec::new();
            if let Ok(s) = BluetoothDevice::GetDeviceSelectorFromPairingState(true) { sels.push(s); }
            if let Ok(s) = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true) { sels.push(s); }
            if let Ok(s) = BluetoothDevice::GetDeviceSelectorFromConnectionStatus(BluetoothConnectionStatus::Connected) { sels.push(s); }
            if let Ok(s) = BluetoothLEDevice::GetDeviceSelectorFromConnectionStatus(BluetoothConnectionStatus::Connected) { sels.push(s); }
            let mut handles = Vec::new();
            for sel in sels {
                let a = app.clone();
                if let Some(h) = make_watcher(&sel, |_| {}, |_| {}, move || {
                    let _ = a.emit("bluetooth-changed", ());
                }) {
                    handles.push(SendBox(h));
                }
            }
            if MAIN_GEN.load(Ordering::SeqCst) != gen {
                // stop() (or a newer start()) came while we were building: release at once
                for h in handles { release(h.0); }
                return;
            }
            if let Ok(mut g) = MAIN_WATCH.lock() {
                g.extend(handles);
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[cfg(target_os = "windows")]
fn stop_main() {
    if let Ok(mut g) = MAIN_WATCH.lock() {
        for h in g.drain(..) {
            release(h.0);
        }
    }
}

/// Stop everything: watchers, discovery, handlers. After this Bluetooth costs nothing.
pub fn stop() {
    #[cfg(target_os = "windows")]
    {
        MAIN_GEN.fetch_add(1, Ordering::SeqCst);
        SCAN_GEN.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(|| {
            stop_main();
            stop_scan();
        });
    }
}

#[cfg(target_os = "windows")]
fn stop_scan() {
    if let Ok(mut g) = SCAN_WATCH.lock() {
        for h in g.drain(..) {
            release(h.0);
        }
    }
    if let Ok(mut n) = NEARBY.lock() {
        *n = None;
    }
}

// =====================================================================================
// Discovery of new (unpaired) devices: only while the Bluetooth list is open
// =====================================================================================

#[tauri::command]
pub fn bt_discovery(app: AppHandle, on: bool) {
    #[cfg(target_os = "windows")]
    {
        if !on || !crate::live::bt_active() {
            SCAN_GEN.fetch_add(1, Ordering::SeqCst);
            std::thread::spawn(stop_scan);
            return;
        }
        let gen = SCAN_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            use windows::Devices::Bluetooth::{BluetoothDevice, BluetoothLEDevice};
            com_init();
            stop_scan();
            if let Ok(mut n) = NEARBY.lock() {
                *n = Some(HashMap::new());
            }
            let mut sels = Vec::new();
            if let Ok(s) = BluetoothDevice::GetDeviceSelectorFromPairingState(false) { sels.push(s); }
            if let Ok(s) = BluetoothLEDevice::GetDeviceSelectorFromPairingState(false) { sels.push(s); }
            let mut handles = Vec::new();
            for sel in sels {
                let a = app.clone();
                let a2 = app.clone();
                let h = make_watcher(
                    &sel,
                    move |info| {
                        let name = info.Name().map(|s| s.to_string()).unwrap_or_default();
                        let id = info.Id().map(|s| s.to_string()).unwrap_or_default();
                        let paired = info.Pairing().and_then(|p| p.IsPaired()).unwrap_or(false);
                        // advertisers without a real name (beacons, trackers) are not shown
                        if name.trim().is_empty() || id.is_empty() || paired {
                            return;
                        }
                        if let Ok(mut n) = NEARBY.lock() {
                            if let Some(m) = n.as_mut() {
                                m.insert(id, name);
                            }
                        }
                        let _ = a.emit("bluetooth-nearby", ());
                    },
                    |id| {
                        if let Ok(mut n) = NEARBY.lock() {
                            if let Some(m) = n.as_mut() {
                                m.remove(id);
                            }
                        }
                    },
                    move || {
                        let _ = a2.emit("bluetooth-nearby", ());
                    },
                );
                if let Some(h) = h {
                    handles.push(SendBox(h));
                }
            }
            if SCAN_GEN.load(Ordering::SeqCst) != gen {
                for h in handles { release(h.0); }
                return;
            }
            if let Ok(mut g) = SCAN_WATCH.lock() {
                g.extend(handles);
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, on);
}

#[tauri::command]
pub fn get_bt_nearby() -> Vec<BtNearby> {
    #[cfg(target_os = "windows")]
    {
        let mut v: Vec<BtNearby> = Vec::new();
        if let Ok(n) = NEARBY.lock() {
            if let Some(m) = n.as_ref() {
                for (id, name) in m.iter() {
                    // LE and classic can both see the same device: keep one row per name
                    if v.iter().any(|x| x.name == *name) {
                        continue;
                    }
                    v.push(BtNearby { id: id.clone(), name: name.clone(), kind: bt_kind_from_name(name).to_string() });
                }
            }
        }
        v.sort_by(|a, b| a.name.cmp(&b.name));
        return v;
    }
    #[cfg(not(target_os = "windows"))]
    Vec::new()
}

// =====================================================================================
// Pairing (confirm / PIN shown / PIN typed) and unpairing
// =====================================================================================

#[cfg(target_os = "windows")]
static ANSWER: Mutex<Option<mpsc::Sender<(bool, String)>>> = Mutex::new(None);

/// The island answers a pairing question: accept / reject, and the PIN when one was asked.
#[tauri::command]
pub fn bt_pair_answer(accept: bool, pin: Option<String>) {
    #[cfg(target_os = "windows")]
    if let Ok(g) = ANSWER.lock() {
        if let Some(tx) = g.as_ref() {
            let _ = tx.send((accept, pin.unwrap_or_default()));
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (accept, pin);
}

#[cfg(target_os = "windows")]
fn answer_request(
    app: &AppHandle,
    id: &str,
    name: &str,
    args: &windows::Devices::Enumeration::DevicePairingRequestedEventArgs,
    rx: &mpsc::Receiver<(bool, String)>,
) -> windows::core::Result<()> {
    use std::time::Duration;
    use windows::core::HSTRING;
    use windows::Devices::Enumeration::DevicePairingKinds;
    let wait = Duration::from_secs(60);
    let kind = args.PairingKind()?;
    let prompt = |k: &str, pin: String| {
        let _ = app.emit(
            "bt-pairing",
            PairingPrompt { id: id.to_string(), name: name.to_string(), kind: k.to_string(), pin },
        );
    };
    if kind == DevicePairingKinds::DisplayPin {
        // the code is shown on this PC and typed on the device
        prompt("display_pin", args.Pin()?.to_string());
        args.Accept()?;
    } else if kind == DevicePairingKinds::ConfirmPinMatch {
        // both sides show the same number: the user confirms it
        prompt("confirm_pin", args.Pin()?.to_string());
        if let Ok((true, _)) = rx.recv_timeout(wait) {
            args.Accept()?;
        }
    } else if kind == DevicePairingKinds::ProvidePin {
        // old headsets / keyboards: the user types the code here (often 0000)
        prompt("provide_pin", String::new());
        if let Ok((true, pin)) = rx.recv_timeout(wait) {
            args.AcceptWithPin(&HSTRING::from(pin.as_str()))?;
        }
    } else {
        // ConfirmOnly: the user already tapped the device, nothing more to ask
        args.Accept()?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn pairing_text(st: windows::Devices::Enumeration::DevicePairingResultStatus) -> &'static str {
    use windows::Devices::Enumeration::DevicePairingResultStatus as S;
    if st == S::Paired || st == S::AlreadyPaired {
        "ok"
    } else if st == S::AuthenticationFailure {
        "wrong_pin"
    } else if st == S::RejectedByHandler || st == S::ConnectionRejected {
        "rejected"
    } else if st == S::AuthenticationTimeout || st == S::AuthenticationNotAllowed {
        "timeout"
    } else if st == S::OperationAlreadyInProgress {
        "busy"
    } else {
        "failed"
    }
}

/// Returns "ok" or a short reason ("wrong_pin", "rejected", "timeout", "busy", "failed").
#[tauri::command]
pub async fn bt_pair(app: AppHandle, id: String, name: String) -> String {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            use windows::core::HSTRING;
            use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationCustomPairing, DevicePairingKinds, DevicePairingRequestedEventArgs};
            use windows::Foundation::TypedEventHandler;
            com_init();
            let run = || -> windows::core::Result<&'static str> {
                let info = DeviceInformation::CreateFromIdAsync(&HSTRING::from(id.as_str()))?.get()?;
                let custom = info.Pairing()?.Custom()?;
                let (tx, rx) = mpsc::channel::<(bool, String)>();
                if let Ok(mut g) = ANSWER.lock() {
                    *g = Some(tx);
                }
                let (app2, id2, name2) = (app.clone(), id.clone(), name.clone());
                let token = custom.PairingRequested(&TypedEventHandler::<
                    DeviceInformationCustomPairing,
                    DevicePairingRequestedEventArgs,
                >::new(move |_, args| {
                    if let Some(args) = args {
                        let _ = answer_request(&app2, &id2, &name2, args, &rx);
                    }
                    Ok(())
                }))?;
                let kinds = DevicePairingKinds::ConfirmOnly
                    | DevicePairingKinds::DisplayPin
                    | DevicePairingKinds::ConfirmPinMatch
                    | DevicePairingKinds::ProvidePin;
                let res = custom.PairAsync(kinds)?.get();
                let _ = custom.RemovePairingRequested(token);
                if let Ok(mut g) = ANSWER.lock() {
                    *g = None;
                }
                Ok(pairing_text(res?.Status()?))
            };
            let out = run().unwrap_or("failed").to_string();
            if out == "ok" {
                if let Ok(mut n) = NEARBY.lock() {
                    if let Some(m) = n.as_mut() {
                        m.retain(|_, v| *v != name);
                    }
                }
                let _ = app.emit("bluetooth-changed", ());
            }
            out
        })
        .await
        .unwrap_or_else(|_| "failed".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, id, name);
        "failed".into()
    }
}

/// Remove (unpair) a paired device by name. Classic and LE entries of the same device are both removed.
#[tauri::command]
pub async fn bt_unpair(app: AppHandle, name: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            use windows::Devices::Bluetooth::{BluetoothDevice, BluetoothLEDevice};
            use windows::Devices::Enumeration::{DeviceInformation, DeviceUnpairingResultStatus as U};
            com_init();
            let mut any = false;
            let mut sels = Vec::new();
            if let Ok(s) = BluetoothDevice::GetDeviceSelectorFromPairingState(true) { sels.push(s); }
            if let Ok(s) = BluetoothLEDevice::GetDeviceSelectorFromPairingState(true) { sels.push(s); }
            for sel in sels {
                let Some(list) = DeviceInformation::FindAllAsyncAqsFilter(&sel).ok().and_then(|o| o.get().ok()) else { continue };
                for i in 0..list.Size().unwrap_or(0) {
                    let Ok(info) = list.GetAt(i) else { continue };
                    if info.Name().map(|n| n.to_string()).unwrap_or_default() != name {
                        continue;
                    }
                    let st = info
                        .Pairing()
                        .and_then(|p| p.UnpairAsync())
                        .and_then(|op| op.get())
                        .and_then(|r| r.Status());
                    if let Ok(st) = st {
                        if st == U::Unpaired || st == U::AlreadyUnpaired {
                            any = true;
                        }
                    }
                }
            }
            if any {
                let _ = app.emit("bluetooth-changed", ());
            }
            any
        })
        .await
        .unwrap_or(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, name);
        false
    }
}

// =====================================================================================
// Connect / disconnect (audio devices) with the Win32 Bluetooth API
// =====================================================================================

/// Returns "ok" | "notfound" | "noradio" | "error"
#[tauri::command]
pub async fn bt_set_connection(name: String, on: bool) -> String {
    #[cfg(target_os = "windows")]
    {
        let n: String = name.chars().take(80).collect();
        if n.trim().is_empty() {
            return "notfound".into();
        }
        return tauri::async_runtime::spawn_blocking(move || set_connection_blocking(&n, on))
            .await
            .unwrap_or_else(|_| "error".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (name, on);
        "error".into()
    }
}

#[cfg(target_os = "windows")]
fn send_audio_oneshot_by_name(name: &str, connect: bool) -> bool {
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return false;
        };
        let Ok(endpoints) = enumerator.EnumAudioEndpoints(
            eAll,
            DEVICE_STATE(DEVICE_STATE_ACTIVE.0 | DEVICE_STATE_UNPLUGGED.0),
        ) else {
            return false;
        };

        let wanted = name.to_lowercase();
        let total = endpoints.GetCount().unwrap_or(0);
        // first matching endpoint that accepts the request wins
        (0..total)
            .filter_map(|i| endpoints.Item(i).ok())
            .filter(|ep| endpoint_label(ep).map_or(false, |label| labels_overlap(&label, &wanted)))
            .any(|ep| ks_audio_oneshot(&enumerator, &ep, connect).is_some())
    }
}

/// Lower-case friendly name of an audio endpoint ("Headphones (WH-1000XM4 Stereo)").
#[cfg(target_os = "windows")]
unsafe fn endpoint_label(endpoint: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
    use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
    use windows::Win32::System::Com::*;
    // PKEY_Device_FriendlyName
    let key = windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };
    let store = endpoint.OpenPropertyStore(STGM_READ).ok()?;
    let value = store.GetValue(&key).ok()?;
    let wide = PropVariantToStringAlloc(&value).ok()?;
    let text = wide.to_string().ok();
    CoTaskMemFree(Some(wide.0 as *const _));
    text.map(|t| t.to_lowercase()).filter(|t| !t.is_empty())
}

#[cfg(target_os = "windows")]
fn labels_overlap(a: &str, b: &str) -> bool {
    a == b || a.contains(b) || b.contains(a)
}

/// Ask the Bluetooth audio driver behind `endpoint` to reconnect / disconnect the headset.
#[cfg(target_os = "windows")]
unsafe fn ks_audio_oneshot(
    enumerator: &windows::Win32::Media::Audio::IMMDeviceEnumerator,
    endpoint: &windows::Win32::Media::Audio::IMMDevice,
    connect: bool,
) -> Option<()> {
    use windows::core::HSTRING;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::KernelStreaming::*;
    use windows::Win32::System::Com::*;

    // endpoint -> topology -> connector -> id of the kernel-streaming filter behind it
    let topology = endpoint.Activate::<IDeviceTopology>(CLSCTX_ALL, None).ok()?;
    let filter_ptr = topology.GetConnector(0).ok()?.GetDeviceIdConnectedTo().ok()?;
    let filter_id = filter_ptr.to_string().ok();
    CoTaskMemFree(Some(filter_ptr.0 as *const _));
    let filter_id = filter_id.filter(|s| !s.is_empty())?;

    let filter = enumerator.GetDevice(&HSTRING::from(filter_id.as_str())).ok()?;
    let control = filter.Activate::<IKsControl>(CLSCTX_ALL, None).ok()?;

    let verb = if connect {
        KSPROPERTY_ONESHOT_RECONNECT
    } else {
        KSPROPERTY_ONESHOT_DISCONNECT
    };
    let request = KSIDENTIFIER {
        Anonymous: KSIDENTIFIER_0 {
            Anonymous: KSIDENTIFIER_0_0 {
                Set: KSPROPSETID_BtAudio,
                Id: verb.0 as u32,
                Flags: KSPROPERTY_TYPE_GET,
            },
        },
    };
    let mut returned = 0u32;
    control
        .KsProperty(
            &request,
            std::mem::size_of::<KSIDENTIFIER>() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
        )
        .ok()
}

#[cfg(target_os = "windows")]
fn set_connection_blocking(name: &str, on: bool) -> String {
    if send_audio_oneshot_by_name(name, on) {
        return "ok".into();
    }
    use std::mem::{size_of, zeroed};
    use windows::core::GUID;
    use windows::Win32::Devices::Bluetooth::{
        BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindFirstRadio,
        BluetoothFindNextDevice, BluetoothFindRadioClose, BluetoothSetServiceState,
        BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS,
    };
    use windows::Win32::Foundation::{CloseHandle, HANDLE};

    unsafe {
        // the first Bluetooth radio
        let fp = BLUETOOTH_FIND_RADIO_PARAMS { dwSize: size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32 };
        let mut radio = HANDLE::default();
        let hf = match BluetoothFindFirstRadio(&fp, &mut radio) {
            Ok(h) => h,
            Err(_) => return "noradio".into(),
        };
        let _ = BluetoothFindRadioClose(hf);

        // look for the device among the remembered / connected ones (no inquiry = no scanning)
        let mut sp: BLUETOOTH_DEVICE_SEARCH_PARAMS = zeroed();
        sp.dwSize = size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32;
        sp.fReturnAuthenticated = true.into();
        sp.fReturnRemembered = true.into();
        sp.fReturnUnknown = false.into();
        sp.fReturnConnected = true.into();
        sp.fIssueInquiry = false.into();
        sp.cTimeoutMultiplier = 0;
        sp.hRadio = radio;
        let mut di: BLUETOOTH_DEVICE_INFO = zeroed();
        di.dwSize = size_of::<BLUETOOTH_DEVICE_INFO>() as u32;
        let h = match BluetoothFindFirstDevice(&sp, &mut di) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseHandle(radio);
                return "notfound".into();
            }
        };

        // A2DP sink, Hands-Free, Headset
        let services = [
            GUID::from_u128(0x0000110b_0000_1000_8000_00805f9b34fb),
            GUID::from_u128(0x0000111e_0000_1000_8000_00805f9b34fb),
            GUID::from_u128(0x00001108_0000_1000_8000_00805f9b34fb),
        ];
        let mut result = String::from("notfound");
        loop {
            let len = di.szName.iter().position(|&c| c == 0).unwrap_or(di.szName.len());
            let dev_name = String::from_utf16_lossy(&di.szName[..len]);
            if dev_name.eq_ignore_ascii_case(name) {
                let mut ok = false;
                for g in services.iter() {
                    if on {
                        // switch off first, then on: this is what makes a stuck link reconnect
                        let _ = BluetoothSetServiceState(radio, &di, g, 0);
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                    if BluetoothSetServiceState(radio, &di, g, if on { 1 } else { 0 }) == 0 {
                        ok = true;
                    }
                }
                result = if ok { "ok".into() } else { "error".into() };
                break;
            }
            if BluetoothFindNextDevice(h, &mut di).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(h);
        let _ = CloseHandle(radio);
        result
    }
}

// =====================================================================================
// Battery (the value Windows Settings shows) - SetupAPI, no Get-PnpDevice
// =====================================================================================

#[cfg(target_os = "windows")]
fn read_batteries() -> Vec<BtBatt> {
    use std::mem::{size_of, zeroed};
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDevicePropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, SP_DEVINFO_DATA,
    };
    use windows::Win32::Devices::Properties::{DEVPKEY_Device_FriendlyName, DEVPROPKEY, DEVPROPTYPE};
    use windows::Win32::Foundation::HWND;

    let battery_key = DEVPROPKEY {
        fmtid: GUID::from_u128(0x104EA319_6EE2_4701_BD47_8DDBF425BBE5),
        pid: 2,
    };
    let mut out: Vec<BtBatt> = Vec::new();
    for enumerator in ["BTHENUM", "BTHLE"] {
        let wide: Vec<u16> = enumerator.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let Ok(set) = SetupDiGetClassDevsW(None, PCWSTR(wide.as_ptr()), HWND::default(), DIGCF_PRESENT | DIGCF_ALLCLASSES) else {
                continue;
            };
            let mut index = 0u32;
            loop {
                let mut data: SP_DEVINFO_DATA = zeroed();
                data.cbSize = size_of::<SP_DEVINFO_DATA>() as u32;
                if SetupDiEnumDeviceInfo(set, index, &mut data).is_err() {
                    break;
                }
                index += 1;

                let mut ptype = DEVPROPTYPE(0);
                let mut buf = [0u8; 8];
                if SetupDiGetDevicePropertyW(set, &data, &battery_key, &mut ptype, Some(&mut buf[..]), None, 0).is_err() {
                    continue;
                }
                let pct = buf[0] as i32;
                if !(0..=100).contains(&pct) {
                    continue;
                }
                let mut nbuf = [0u8; 512];
                let mut ntype = DEVPROPTYPE(0);
                if SetupDiGetDevicePropertyW(set, &data, &DEVPKEY_Device_FriendlyName, &mut ntype, Some(&mut nbuf[..]), None, 0).is_err() {
                    continue;
                }
                let units: Vec<u16> = nbuf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
                let name = String::from_utf16_lossy(&units);
                if !name.is_empty() && !out.iter().any(|b| b.name == name) {
                    out.push(BtBatt { name, pct });
                }
            }
            let _ = SetupDiDestroyDeviceInfoList(set);
        }
    }
    out
}

#[cfg(target_os = "windows")]
static BATT_CACHE: Mutex<Option<(std::time::Instant, Vec<BtBatt>)>> = Mutex::new(None);

/// Battery of every connected Bluetooth device (remembered for 20 s, the call itself is cheap).
#[tauri::command]
pub async fn get_bt_batteries() -> Vec<BtBatt> {
    if !crate::live::bt_active() {
        return Vec::new();
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(g) = BATT_CACHE.lock() {
            if let Some((at, v)) = g.as_ref() {
                if at.elapsed() < std::time::Duration::from_secs(20) && !v.is_empty() {
                    return v.clone();
                }
            }
        }
        let fresh = tauri::async_runtime::spawn_blocking(read_batteries).await.unwrap_or_default();
        if let Ok(mut g) = BATT_CACHE.lock() {
            *g = Some((std::time::Instant::now(), fresh.clone()));
        }
        return fresh;
    }
    #[cfg(not(target_os = "windows"))]
    Vec::new()
}

/// Battery of one device by name (None when Windows has no value).
#[tauri::command]
pub async fn get_bt_battery(name: String) -> Option<i32> {
    let n = name.to_lowercase();
    get_bt_batteries()
        .await
        .into_iter()
        .find(|b| {
            let x = b.name.to_lowercase();
            x == n || x.contains(&n) || n.contains(&x)
        })
        .map(|b| b.pct)
}

#[tauri::command]
pub async fn get_bt_devices() -> Vec<BtDev> {
    if !crate::live::bt_active() {
        return vec![];
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(Some(list)) = tauri::async_runtime::spawn_blocking(|| {
            com_init();
            bt_paired_winrt()
        })
        .await
        {
            return list;
        }
    }
    vec![]
}
