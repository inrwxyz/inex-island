//! Wi-Fi backend for INEX Island.
//!
//! Talks straight to the Windows WLAN service (wlanapi.dll). Nothing here
//! polls: Windows pushes "ACM" notifications (scan finished, connected,
//! disconnected, adapter plugged/unplugged, profile changed) and we forward
//! them to the UI as one debounced `wifi-changed` event.
//!
//! The Win32 bindings are declared by hand in the `extern` block below, so the
//! only thing this file takes from the `windows` crate is two reason-code
//! constants.

use serde::Serialize;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use windows::Win32::NetworkManagement::WiFi::{
    WLAN_REASON_CODE_MSMSEC_BASE, WLAN_REASON_CODE_MSMSEC_PSK_MISMATCH_SUSPECTED,
};

// ───────────────────────────── JSON shapes (UI contract) ─────────────────────────────

#[derive(Clone, Serialize)]
pub struct WifiNet {
    pub ssid: String,
    pub signal: u32,
    pub bars: u8,
    pub secure: bool,
    pub security: String,
    pub connected: bool,
    pub saved: bool,
}

#[derive(Clone, Serialize)]
pub struct WifiScan {
    pub networks: Vec<WifiNet>,
    pub location_denied: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct WifiStatus {
    pub name: String,
    pub signal: u32,
}

// ───────────────────────────── raw wlanapi bindings ─────────────────────────────

type Handle = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}

#[repr(C)]
struct Dot11Ssid {
    len: u32,
    bytes: [u8; 32],
}

#[repr(C)]
struct InterfaceInfo {
    guid: Guid,
    description: [u16; 256],
    state: i32,
}

#[repr(C)]
struct InterfaceList {
    count: u32,
    index: u32,
    items: [InterfaceInfo; 1],
}

#[repr(C)]
struct AvailableNetwork {
    profile_name: [u16; 256],
    ssid: Dot11Ssid,
    bss_type: i32,
    num_bssids: u32,
    connectable: i32,
    not_connectable_reason: u32,
    num_phy_types: u32,
    phy_types: [i32; 8],
    more_phy_types: i32,
    signal_quality: u32,
    security_enabled: i32,
    default_auth: i32,
    default_cipher: i32,
    flags: u32,
    reserved: u32,
}

#[repr(C)]
struct NetworkList {
    count: u32,
    index: u32,
    items: [AvailableNetwork; 1],
}

/// Leading part of WLAN_CONNECTION_ATTRIBUTES (everything we read).
#[repr(C)]
struct ConnAttrs {
    state: i32,
    mode: i32,
    profile_name: [u16; 256],
    ssid: Dot11Ssid,
    bss_type: i32,
    bssid: [u8; 6],
    phy_type: i32,
    phy_index: u32,
    signal: u32,
    rx_rate: u32,
    tx_rate: u32,
}

/// Leading part of WLAN_CONNECTION_NOTIFICATION_DATA.
#[repr(C)]
struct ConnNotif {
    mode: i32,
    profile_name: [u16; 256],
    ssid: Dot11Ssid,
    bss_type: i32,
    security_enabled: i32,
    reason: u32,
    flags: u32,
}

#[repr(C)]
struct NotifData {
    source: u32,
    code: u32,
    guid: Guid,
    data_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct ConnParams {
    mode: i32,
    profile: *const u16,
    ssid: *const Dot11Ssid,
    bssid_list: *const c_void,
    bss_type: i32,
    flags: u32,
}

type NotifyFn = unsafe extern "system" fn(*mut NotifData, *mut c_void);

#[allow(non_snake_case)]
#[link(name = "wlanapi")]
extern "system" {
    fn WlanOpenHandle(version: u32, reserved: *mut c_void, negotiated: *mut u32, handle: *mut Handle) -> u32;
    fn WlanCloseHandle(handle: Handle, reserved: *mut c_void) -> u32;
    fn WlanEnumInterfaces(handle: Handle, reserved: *mut c_void, list: *mut *mut InterfaceList) -> u32;
    fn WlanFreeMemory(memory: *mut c_void);
    fn WlanScan(
        handle: Handle,
        guid: *const Guid,
        ssid: *const Dot11Ssid,
        raw: *const c_void,
        reserved: *mut c_void,
    ) -> u32;
    fn WlanGetAvailableNetworkList(
        handle: Handle,
        guid: *const Guid,
        flags: u32,
        reserved: *mut c_void,
        list: *mut *mut NetworkList,
    ) -> u32;
    fn WlanGetProfile(
        handle: Handle,
        guid: *const Guid,
        name: *const u16,
        reserved: *mut c_void,
        xml: *mut *mut u16,
        flags: *mut u32,
        access: *mut u32,
    ) -> u32;
    fn WlanSetProfile(
        handle: Handle,
        guid: *const Guid,
        flags: u32,
        xml: *const u16,
        all_user_sddl: *const u16,
        overwrite: i32,
        reserved: *mut c_void,
        reason: *mut u32,
    ) -> u32;
    fn WlanDeleteProfile(handle: Handle, guid: *const Guid, name: *const u16, reserved: *mut c_void) -> u32;
    fn WlanConnect(handle: Handle, guid: *const Guid, params: *const ConnParams, reserved: *mut c_void) -> u32;
    fn WlanDisconnect(handle: Handle, guid: *const Guid, reserved: *mut c_void) -> u32;
    fn WlanQueryInterface(
        handle: Handle,
        guid: *const Guid,
        opcode: i32,
        reserved: *mut c_void,
        size: *mut u32,
        data: *mut *mut c_void,
        value_type: *mut i32,
    ) -> u32;
    fn WlanRegisterNotification(
        handle: Handle,
        source: u32,
        ignore_duplicates: i32,
        callback: Option<NotifyFn>,
        context: *mut c_void,
        reserved: *mut c_void,
        previous_source: *mut u32,
    ) -> u32;
}

// WLAN constants (from wlanapi.h)
const CLIENT_VERSION: u32 = 2;
const SOURCE_NONE: u32 = 0;
const SOURCE_ACM: u32 = 0x8;
const OPCODE_CURRENT_CONNECTION: i32 = 7;
const IFACE_STATE_CONNECTED: i32 = 1;
const NET_FLAG_CONNECTED: u32 = 0x1;
const NET_FLAG_HAS_PROFILE: u32 = 0x2;
const PROFILE_USER: u32 = 0x2;
const MODE_PROFILE: i32 = 0;
const BSS_INFRASTRUCTURE: i32 = 1;
const ERROR_ACCESS_DENIED: u32 = 5;

// ACM notification codes
const N_SCAN_COMPLETE: u32 = 7;
const N_CONNECTION_COMPLETE: u32 = 10;
const N_CONNECTION_FAIL: u32 = 11;
const N_IFACE_ARRIVAL: u32 = 13;
const N_IFACE_REMOVAL: u32 = 14;
const N_PROFILE_CHANGE: u32 = 15;
const N_DISCONNECTED: u32 = 21;
const N_SCAN_LIST_REFRESH: u32 = 26;

/// How long we wait for Windows to say whether a connection attempt worked.
const JOIN_WAIT: Duration = Duration::from_secs(30);
/// Minimum gap between two radio scans triggered by the UI.
const SCAN_MIN_GAP_MS: u64 = 10_000;

// ───────────────────────────── small helpers ─────────────────────────────

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

unsafe fn from_pwstr(p: *const u16) -> String {
    let mut n = 0usize;
    while n < (1 << 20) && *p.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}

fn ssid_bytes(s: &Dot11Ssid) -> Vec<u8> {
    let n = (s.len as usize).min(32);
    s.bytes[..n].to_vec()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn xml_escape(s: &str) -> String {
    // '&' first, otherwise the other entities would be escaped twice
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn bars_for(signal: u32) -> u8 {
    match signal {
        75.. => 4,
        50..=74 => 3,
        25..=49 => 2,
        _ => 1,
    }
}

fn security_label(auth: i32, secure: bool) -> &'static str {
    match auth {
        1 if secure => "wep",
        1 => "open",
        2 => "wep",
        3 | 6 => "enterprise",
        8 | 11 => "enterprise", // WPA3 enterprise variants
        4 => "wpa",
        7 => "wpa2",
        9 => "wpa3",
        10 => "owe",
        _ if secure => "wpa2",
        _ => "open",
    }
}

fn passphrase_ok(key: &str) -> bool {
    let n = key.chars().count();
    (8..=63).contains(&n) || (n == 64 && key.chars().all(|c| c.is_ascii_hexdigit()))
}

fn reason_means_bad_key(reason: u32) -> bool {
    reason == WLAN_REASON_CODE_MSMSEC_PSK_MISMATCH_SUSPECTED
        || (reason >= WLAN_REASON_CODE_MSMSEC_BASE && reason - WLAN_REASON_CODE_MSMSEC_BASE < 0x1_0000)
}

// ───────────────────────────── security kinds + profile XML ─────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Auth {
    Open,
    Owe,
    Wpa,
    Wpa2,
    Wpa3,
    Unsupported,
}

impl Auth {
    fn parse(label: &str) -> Auth {
        match label.trim().to_ascii_lowercase().as_str() {
            "open" | "none" => Auth::Open,
            "owe" => Auth::Owe,
            "wpa" => Auth::Wpa,
            "wpa3" | "sae" => Auth::Wpa3,
            "wep" | "enterprise" => Auth::Unsupported,
            _ => Auth::Wpa2,
        }
    }

    fn needs_key(self) -> bool {
        matches!(self, Auth::Wpa | Auth::Wpa2 | Auth::Wpa3)
    }
}

fn build_profile(profile_name: &str, ssid: &str, auth: Auth, key: &str, hidden: bool) -> String {
    let (authentication, encryption) = match auth {
        Auth::Open => ("open", "none"),
        Auth::Owe => ("OWE", "AES"),
        Auth::Wpa => ("WPAPSK", "TKIP"),
        Auth::Wpa3 => ("WPA3SAE", "AES"),
        _ => ("WPA2PSK", "AES"),
    };
    let ssid_hex: String = ssid.bytes().map(|b| format!("{:02X}", b)).collect();

    let mut x = String::with_capacity(900);
    x.push_str("<?xml version=\"1.0\"?>\n");
    x.push_str("<WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\">");
    x.push_str(&format!("<name>{}</name>", xml_escape(profile_name)));
    x.push_str(&format!(
        "<SSIDConfig><SSID><hex>{}</hex><name>{}</name></SSID>",
        ssid_hex,
        xml_escape(ssid)
    ));
    if hidden {
        x.push_str("<nonBroadcast>true</nonBroadcast>");
    }
    x.push_str("</SSIDConfig>");
    x.push_str("<connectionType>ESS</connectionType><connectionMode>auto</connectionMode>");
    x.push_str(&format!(
        "<MSM><security><authEncryption><authentication>{}</authentication>\
         <encryption>{}</encryption><useOneX>false</useOneX>",
        authentication, encryption
    ));
    if auth == Auth::Wpa3 {
        x.push_str(
            "<transitionMode xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v4\">true</transitionMode>",
        );
    }
    x.push_str("</authEncryption>");
    if auth.needs_key() {
        let raw_hex_key = key.len() == 64 && auth != Auth::Wpa3;
        x.push_str(&format!(
            "<sharedKey><keyType>{}</keyType><protected>false</protected><keyMaterial>{}</keyMaterial></sharedKey>",
            if raw_hex_key { "networkKey" } else { "passPhrase" },
            xml_escape(key)
        ));
    }
    x.push_str("</security></MSM></WLANProfile>");
    x
}

// ───────────────────────────── WLAN session ─────────────────────────────

struct Found {
    ssid: String,
    profile: String,
    signal: u32,
    secure: bool,
    auth: i32,
    flags: u32,
}

enum Outcome {
    Connected,
    KeyRejected,
    Failed,
}

/// One open client handle. Closed automatically.
struct Session(Handle);

impl Session {
    fn open() -> Result<Session, String> {
        let mut negotiated = 0u32;
        let mut h: Handle = null_mut();
        let rc = unsafe { WlanOpenHandle(CLIENT_VERSION, null_mut(), &mut negotiated, &mut h) };
        if rc != 0 || h.is_null() {
            return Err("wlan_service".to_string());
        }
        Ok(Session(h))
    }

    /// GUID of the first Wi-Fi adapter.
    fn first_adapter(&self) -> Result<Guid, String> {
        let mut list: *mut InterfaceList = null_mut();
        let rc = unsafe { WlanEnumInterfaces(self.0, null_mut(), &mut list) };
        if rc != 0 || list.is_null() {
            return Err("no_adapter".to_string());
        }
        let guid = unsafe {
            let g = if (*list).count > 0 { Some((*list).items[0].guid) } else { None };
            WlanFreeMemory(list as *mut c_void);
            g
        };
        guid.ok_or_else(|| "no_adapter".to_string())
    }

    /// Ask Windows to rescan (async: the result arrives as a notification).
    fn kick_scan(&self, guid: &Guid, min_gap_ms: u64) {
        static LAST_SCAN_MS: AtomicU64 = AtomicU64::new(0);
        let now = now_ms();
        if now.saturating_sub(LAST_SCAN_MS.load(Ordering::Relaxed)) < min_gap_ms {
            return;
        }
        LAST_SCAN_MS.store(now, Ordering::Relaxed);
        unsafe {
            WlanScan(self.0, guid, null(), null(), null_mut());
        }
    }

    /// Visible networks. Err(code) is the raw Win32 error.
    fn list_found(&self, guid: &Guid) -> Result<Vec<Found>, u32> {
        let mut list: *mut NetworkList = null_mut();
        let rc = unsafe { WlanGetAvailableNetworkList(self.0, guid, 0, null_mut(), &mut list) };
        if rc != 0 || list.is_null() {
            return Err(rc);
        }
        let mut out = Vec::new();
        unsafe {
            let count = ((*list).count as usize).min(2048);
            let base = std::ptr::addr_of!((*list).items) as *const AvailableNetwork;
            for i in 0..count {
                let it = &*base.add(i);
                let raw = ssid_bytes(&it.ssid);
                if raw.is_empty() {
                    continue; // hidden network, nothing to show
                }
                out.push(Found {
                    ssid: String::from_utf8_lossy(&raw).into_owned(),
                    profile: from_wide(&it.profile_name),
                    signal: it.signal_quality.min(100),
                    secure: it.security_enabled != 0,
                    auth: it.default_auth,
                    flags: it.flags,
                });
            }
            WlanFreeMemory(list as *mut c_void);
        }
        Ok(out)
    }

    /// Name of the saved profile that belongs to this SSID, if any.
    fn profile_for(&self, guid: &Guid, ssid: &str) -> Option<String> {
        let found = self.list_found(guid).ok()?;
        found
            .into_iter()
            .find(|f| f.ssid == ssid && f.flags & NET_FLAG_HAS_PROFILE != 0 && !f.profile.is_empty())
            .map(|f| f.profile)
    }

    /// (name, signal 0-100) of the current connection.
    fn connection(&self, guid: &Guid) -> Option<(String, u32)> {
        let mut size = 0u32;
        let mut data: *mut c_void = null_mut();
        let mut value_type = 0i32;
        let rc = unsafe {
            WlanQueryInterface(
                self.0,
                guid,
                OPCODE_CURRENT_CONNECTION,
                null_mut(),
                &mut size,
                &mut data,
                &mut value_type,
            )
        };
        if rc != 0 || data.is_null() {
            return None; // not associated
        }
        let result = unsafe {
            let r = if size as usize >= std::mem::size_of::<ConnAttrs>() {
                let a = &*(data as *const ConnAttrs);
                if a.state == IFACE_STATE_CONNECTED {
                    let name = String::from_utf8_lossy(&ssid_bytes(&a.ssid)).into_owned();
                    Some((name, a.signal.min(100)))
                } else {
                    None
                }
            } else {
                None
            };
            WlanFreeMemory(data);
            r
        };
        result
    }

    /// Saved profile XML and its scope flags.
    fn get_profile(&self, guid: &Guid, name: &str) -> Option<(String, u32)> {
        let w = wide(name);
        let mut xml: *mut u16 = null_mut();
        let mut flags = 0u32;
        let mut access = 0u32;
        let rc = unsafe { WlanGetProfile(self.0, guid, w.as_ptr(), null_mut(), &mut xml, &mut flags, &mut access) };
        if rc != 0 || xml.is_null() {
            return None;
        }
        let text = unsafe {
            let t = from_pwstr(xml);
            WlanFreeMemory(xml as *mut c_void);
            t
        };
        Some((text, flags))
    }

    fn set_profile_scope(&self, guid: &Guid, xml: &str, scope: u32) -> Result<(), u32> {
        let w = wide(xml);
        let mut reason = 0u32;
        let rc = unsafe { WlanSetProfile(self.0, guid, scope, w.as_ptr(), null(), 1, null_mut(), &mut reason) };
        if rc == 0 {
            Ok(())
        } else {
            Err(rc)
        }
    }

    /// Save (overwrite) a profile. Tries the requested scope first; a normal
    /// user can't write all-user profiles, so we fall back to a per-user one.
    /// Returns the scope that worked.
    fn put_profile(&self, guid: &Guid, xml: &str, scope: u32) -> Result<u32, u32> {
        match self.set_profile_scope(guid, xml, scope) {
            Ok(()) => Ok(scope),
            Err(ERROR_ACCESS_DENIED) if scope != PROFILE_USER => {
                self.set_profile_scope(guid, xml, PROFILE_USER).map(|_| PROFILE_USER)
            }
            Err(e) => Err(e),
        }
    }

    fn delete_profile(&self, guid: &Guid, name: &str) -> u32 {
        let w = wide(name);
        unsafe { WlanDeleteProfile(self.0, guid, w.as_ptr(), null_mut()) }
    }

    /// Connect with a saved profile and wait for Windows to report the result.
    fn connect_and_wait(&self, guid: &Guid, profile: &str) -> Outcome {
        // one connection attempt at a time
        let _gate = CONNECT_GATE.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel::<(u32, u32)>();
        *CONNECT_TX.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);

        let mut previous = 0u32;
        let reg = unsafe {
            WlanRegisterNotification(
                self.0,
                SOURCE_ACM,
                0,
                Some(on_connect_event),
                null_mut(),
                null_mut(),
                &mut previous,
            )
        };

        let outcome = if reg != 0 {
            Outcome::Failed
        } else {
            let w = wide(profile);
            let params = ConnParams {
                mode: MODE_PROFILE,
                profile: w.as_ptr(),
                ssid: null(),
                bssid_list: null(),
                bss_type: BSS_INFRASTRUCTURE,
                flags: 0,
            };
            let rc = unsafe { WlanConnect(self.0, guid, &params, null_mut()) };
            if rc != 0 {
                Outcome::Failed
            } else {
                match rx.recv_timeout(JOIN_WAIT) {
                    Ok((N_CONNECTION_COMPLETE, 0)) => Outcome::Connected,
                    Ok((_, reason)) if reason_means_bad_key(reason) => Outcome::KeyRejected,
                    _ => Outcome::Failed,
                }
            }
        };

        unsafe {
            WlanRegisterNotification(self.0, SOURCE_NONE, 0, None, null_mut(), null_mut(), null_mut());
        }
        *CONNECT_TX.lock().unwrap_or_else(|e| e.into_inner()) = None;
        outcome
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            WlanCloseHandle(self.0, null_mut());
        }
    }
}

// ───────────────────────────── notification plumbing ─────────────────────────────

static CONNECT_GATE: Mutex<()> = Mutex::new(());
static CONNECT_TX: Mutex<Option<mpsc::Sender<(u32, u32)>>> = Mutex::new(None);

/// Used only while a connect attempt is waiting: forwards (code, reason).
unsafe extern "system" fn on_connect_event(data: *mut NotifData, _ctx: *mut c_void) {
    let Some(d) = data.as_ref() else { return };
    if d.source != SOURCE_ACM || (d.code != N_CONNECTION_COMPLETE && d.code != N_CONNECTION_FAIL) {
        return;
    }
    let mut reason = 0u32;
    if !d.data.is_null() && d.data_size as usize >= std::mem::size_of::<ConnNotif>() {
        reason = (*(d.data as *const ConnNotif)).reason;
    }
    if let Ok(guard) = CONNECT_TX.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send((d.code, reason));
        }
    }
}

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Long-lived listener handle (0 = not running).
static LISTENER: Mutex<usize> = Mutex::new(0);
static LAST_EMIT_MS: AtomicU64 = AtomicU64::new(0);

/// Long-lived listener: turns Windows notifications into `wifi-changed`.
unsafe extern "system" fn on_wlan_event(data: *mut NotifData, _ctx: *mut c_void) {
    let Some(d) = data.as_ref() else { return };
    if d.source != SOURCE_ACM {
        return;
    }
    match d.code {
        N_SCAN_COMPLETE | N_CONNECTION_COMPLETE | N_CONNECTION_FAIL | N_DISCONNECTED | N_IFACE_ARRIVAL
        | N_IFACE_REMOVAL | N_PROFILE_CHANGE | N_SCAN_LIST_REFRESH => {}
        _ => return,
    }
    // Windows often sends several of these back to back; the UI re-queries
    // after its own short debounce, so one event per burst is enough.
    let now = now_ms();
    if now.saturating_sub(LAST_EMIT_MS.load(Ordering::Relaxed)) < 150 {
        return;
    }
    LAST_EMIT_MS.store(now, Ordering::Relaxed);
    if let Some(app) = APP.get() {
        let _ = app.emit("wifi-changed", ());
    }
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    let mut slot = LISTENER.lock().unwrap_or_else(|e| e.into_inner());
    if *slot != 0 {
        return;
    }
    let mut negotiated = 0u32;
    let mut h: Handle = null_mut();
    let rc = unsafe { WlanOpenHandle(CLIENT_VERSION, null_mut(), &mut negotiated, &mut h) };
    if rc != 0 || h.is_null() {
        return;
    }
    let mut previous = 0u32;
    let reg = unsafe {
        WlanRegisterNotification(h, SOURCE_ACM, 0, Some(on_wlan_event), null_mut(), null_mut(), &mut previous)
    };
    if reg != 0 {
        unsafe {
            WlanCloseHandle(h, null_mut());
        }
        return;
    }
    *slot = h as usize;
}

pub fn stop() {
    let mut slot = LISTENER.lock().unwrap_or_else(|e| e.into_inner());
    if *slot == 0 {
        return;
    }
    let h = *slot as Handle;
    *slot = 0;
    unsafe {
        WlanRegisterNotification(h, SOURCE_NONE, 0, None, null_mut(), null_mut(), null_mut());
        WlanCloseHandle(h, null_mut());
    }
}

pub fn is_running() -> bool {
    *LISTENER.lock().unwrap_or_else(|e| e.into_inner()) != 0
}

// ───────────────────────────── operations ─────────────────────────────

/// (name, signal) of the connected network, None when not connected.
#[allow(dead_code)]
pub fn current_connection() -> Option<(String, u32)> {
    let sess = Session::open().ok()?;
    let guid = sess.first_adapter().ok()?;
    sess.connection(&guid)
}

fn scan_snapshot() -> WifiScan {
    let fail = |code: &str, denied: bool| WifiScan {
        networks: Vec::new(),
        location_denied: denied,
        error: Some(code.to_string()),
    };
    let sess = match Session::open() {
        Ok(s) => s,
        Err(e) => return fail(&e, false),
    };
    let guid = match sess.first_adapter() {
        Ok(g) => g,
        Err(e) => return fail(&e, false),
    };
    // Fresh radio scan at most every few seconds. The result comes back as a
    // notification, which refreshes the UI once; the gap stops that from looping.
    sess.kick_scan(&guid, SCAN_MIN_GAP_MS);

    let found = match sess.list_found(&guid) {
        Ok(f) => f,
        Err(ERROR_ACCESS_DENIED) => return fail("location_denied", true),
        Err(_) => return fail("scan_failed", false),
    };

    let mut nets: Vec<WifiNet> = Vec::new();
    for f in found {
        let connected = f.flags & NET_FLAG_CONNECTED != 0;
        let saved = f.flags & NET_FLAG_HAS_PROFILE != 0;
        if let Some(n) = nets.iter_mut().find(|n| n.ssid == f.ssid) {
            n.connected |= connected;
            n.saved |= saved;
            if f.signal > n.signal {
                n.signal = f.signal;
                n.bars = bars_for(f.signal);
                n.secure = f.secure;
                n.security = security_label(f.auth, f.secure).to_string();
            }
        } else {
            nets.push(WifiNet {
                ssid: f.ssid,
                signal: f.signal,
                bars: bars_for(f.signal),
                secure: f.secure,
                security: security_label(f.auth, f.secure).to_string(),
                connected,
                saved,
            });
        }
    }
    nets.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.signal.cmp(&a.signal)));

    WifiScan { networks: nets, location_denied: false, error: None }
}

/// Create/overwrite a profile for `ssid`, connect, and undo on failure.
/// Returns the code the UI understands: ok, badssid, badkey, wrong-password, failed, ...
fn join_sync(ssid: &str, password: &str, security: &str, hidden: bool) -> String {
    if ssid.is_empty() || ssid.len() > 32 {
        return "badssid".to_string();
    }
    let auth = Auth::parse(security);
    if auth == Auth::Unsupported {
        return "failed".to_string();
    }
    if auth.needs_key() && !passphrase_ok(password) {
        return "badkey".to_string();
    }
    let Ok(sess) = Session::open() else { return "error".to_string() };
    let Ok(guid) = sess.first_adapter() else { return "no_adapter".to_string() };

    // Reuse the existing profile (name + scope) so we never pile up duplicates.
    let existing = sess.profile_for(&guid, ssid);
    let name = existing.clone().unwrap_or_else(|| ssid.to_string());
    let backup = existing.as_deref().and_then(|n| sess.get_profile(&guid, n));
    let scope = backup.as_ref().map(|b| b.1 & PROFILE_USER).unwrap_or(0);

    let xml = build_profile(&name, ssid, auth, password, hidden);
    let used_scope = match sess.put_profile(&guid, &xml, scope) {
        Ok(s) => s,
        Err(_) => return "failed".to_string(),
    };

    match sess.connect_and_wait(&guid, &name) {
        Outcome::Connected => "ok".to_string(),
        other => {
            match &backup {
                Some((old_xml, _)) => {
                    let _ = sess.put_profile(&guid, old_xml, used_scope);
                }
                None => {
                    sess.delete_profile(&guid, &name);
                }
            }
            if matches!(other, Outcome::KeyRejected) {
                "wrong-password".to_string()
            } else {
                "failed".to_string()
            }
        }
    }
}

/// Connect using an already saved profile. false = no profile or it failed.
fn connect_saved_sync(ssid: &str) -> bool {
    let Ok(sess) = Session::open() else { return false };
    let Ok(guid) = sess.first_adapter() else { return false };
    let Some(name) = sess.profile_for(&guid, ssid) else { return false };
    matches!(sess.connect_and_wait(&guid, &name), Outcome::Connected)
}

// ───────────────────────────── Tauri commands ─────────────────────────────

#[tauri::command]
pub async fn get_wifi_networks() -> WifiScan {
    tauri::async_runtime::spawn_blocking(scan_snapshot)
        .await
        .unwrap_or_else(|_| WifiScan {
            networks: Vec::new(),
            location_denied: false,
            error: Some("internal".to_string()),
        })
}

#[tauri::command]
pub async fn wifi_scan() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
        let sess = Session::open()?;
        let guid = sess.first_adapter()?;
        sess.kick_scan(&guid, 0);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn connect_wifi_network(ssid: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || connect_saved_sync(&ssid))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wifi_join(
    ssid: String,
    password: String,
    security: Option<String>,
    hidden: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        join_sync(
            &ssid,
            &password,
            security.as_deref().unwrap_or("wpa2"),
            hidden.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_wifi() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
        let sess = Session::open()?;
        let guid = sess.first_adapter()?;
        let rc = unsafe { WlanDisconnect(sess.0, &guid, null_mut()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(format!("disconnect_failed:{rc}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wifi_forget(ssid: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let sess = Session::open()?;
        let guid = sess.first_adapter()?;
        let name = sess.profile_for(&guid, &ssid).unwrap_or(ssid);
        let rc = sess.delete_profile(&guid, &name);
        // 1168 = profile not found: already gone, that's fine
        if rc == 0 || rc == 1168 {
            Ok(())
        } else {
            Err(format!("forget_failed:{rc}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_wifi_status() -> WifiStatus {
    match current_connection() {
        Some((name, signal)) => WifiStatus { name, signal },
        None => WifiStatus { name: "Not connected".to_string(), signal: 0 },
    }
}
