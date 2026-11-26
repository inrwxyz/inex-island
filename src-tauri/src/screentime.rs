//! Screen Time tracker for Inex Island (Session-only, zero disk bloat).
//!
//! Accurate foreground window tracker using GA_ROOT, idle detection, and in-memory session time.
//! Resets fresh every time the app/PC starts. Zero disk I/O, zero database overhead.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const MIN_SECS: u64 = 2; // only 2 seconds to appear
const TICK_SECS: u64 = 5; // check every 5 seconds for snappy updates
const IDLE_LIMIT_MS: u32 = 120_000; // 2 min without mouse/keyboard = idle

static TOTAL_SECS: AtomicU64 = AtomicU64::new(0);
static CUR_APP: Mutex<Option<String>> = Mutex::new(None);
static LAST_INSTANT: Mutex<Option<Instant>> = Mutex::new(None);
static ENABLED: AtomicBool = AtomicBool::new(true);

fn apps_lock() -> MutexGuard<'static, HashMap<String, u64>> {
    static LOCK: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    let m = LOCK.get_or_init(|| Mutex::new(HashMap::new()));
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// exe name -> full path of the executable (for icon extraction)
fn paths_lock() -> MutexGuard<'static, HashMap<String, String>> {
    static LOCK: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let m = LOCK.get_or_init(|| Mutex::new(HashMap::new()));
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn history_path() -> std::path::PathBuf {
    crate::startup::data_dir().join("screentime_30d.json")
}

fn read_disk_history() -> Vec<DayTime> {
    let path = history_path();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(days) = serde_json::from_slice::<Vec<DayTime>>(&bytes) {
            return days;
        }
    }
    Vec::new()
}

fn write_disk_history(days: &[DayTime]) {
    let path = history_path();
    if let Ok(json) = serde_json::to_vec(days) {
        let _ = std::fs::write(path, json);
    }
}

fn sync_and_prune(today_data: DayTime) -> Vec<DayTime> {
    let mut days = read_disk_history();
    if let Some(pos) = days.iter().position(|d| d.date == today_data.date) {
        days[pos] = today_data;
    } else {
        days.push(today_data);
    }
    days.sort_by(|a, b| a.date.cmp(&b.date));
    if days.len() > 30 {
        days = days.split_off(days.len() - 30);
    }
    write_disk_history(&days);
    days
}

pub fn save() {
    accrue();
    let today_data = get_screen_time_today();
    let _ = sync_and_prune(today_data);
}

// ---------------------------------------------------------------- Windows bits
#[cfg(target_os = "windows")]
fn today() -> String {
    #[repr(C)]
    #[derive(Default)]
    struct SysTime {
        year: u16,
        month: u16,
        dow: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        ms: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(t: *mut SysTime);
    }
    let mut t = SysTime::default();
    unsafe { GetLocalTime(&mut t) };
    format!("{:04}-{:02}-{:02}", t.year, t.month, t.day)
}

#[cfg(not(target_os = "windows"))]
fn today() -> String {
    "1970-01-01".to_string()
}

#[cfg(target_os = "windows")]
fn idle_ms() -> u32 {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(p: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    unsafe {
        let mut i = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            time: 0,
        };
        if GetLastInputInfo(&mut i) == 0 {
            return 0;
        }
        GetTickCount().saturating_sub(i.time)
    }
}

#[cfg(not(target_os = "windows"))]
fn idle_ms() -> u32 {
    0
}

#[cfg(target_os = "windows")]
mod sys {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct IconInfo {
        pub f_icon: i32,
        pub x_hotspot: u32,
        pub y_hotspot: u32,
        pub hbm_mask: isize,
        pub hbm_color: isize,
    }
    #[repr(C)]
    pub struct Bitmap {
        pub bm_type: i32,
        pub width: i32,
        pub height: i32,
        pub width_bytes: i32,
        pub planes: u16,
        pub bits_pixel: u16,
        pub bits: *mut c_void,
    }
    #[repr(C)]
    pub struct BmpInfoHeader {
        pub size: u32,
        pub width: i32,
        pub height: i32,
        pub planes: u16,
        pub bit_count: u16,
        pub compression: u32,
        pub size_image: u32,
        pub x_ppm: i32,
        pub y_ppm: i32,
        pub clr_used: u32,
        pub clr_important: u32,
    }
    #[repr(C)]
    pub struct BmpInfo {
        pub header: BmpInfoHeader,
        pub colors: [u32; 1],
    }
    #[repr(C)]
    pub struct ShFileInfo {
        pub icon: isize,
        pub icon_index: i32,
        pub attributes: u32,
        pub display_name: [u16; 260],
        pub type_name: [u16; 80],
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn GetWindowThreadProcessId(h: isize, pid: *mut u32) -> u32;
        pub fn GetForegroundWindow() -> isize;
        pub fn GetAncestor(h: isize, flags: u32) -> isize;
        pub fn IsWindowVisible(h: isize) -> i32;
        pub fn GetWindowLongW(h: isize, index: i32) -> i32;
        pub fn GetWindow(h: isize, cmd: u32) -> isize;
        pub fn EnumWindows(
            f: Option<unsafe extern "system" fn(isize, isize) -> i32>,
            lparam: isize,
        ) -> i32;
        pub fn EnumChildWindows(
            parent: isize,
            f: Option<unsafe extern "system" fn(isize, isize) -> i32>,
            lparam: isize,
        ) -> i32;
        pub fn GetIconInfo(icon: isize, info: *mut IconInfo) -> i32;
        pub fn DestroyIcon(icon: isize) -> i32;
        pub fn GetDC(h: isize) -> isize;
        pub fn ReleaseDC(h: isize, dc: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        pub fn QueryFullProcessImageNameW(h: isize, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
        pub fn CloseHandle(h: isize) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        pub fn GetObjectW(h: isize, c: i32, pv: *mut c_void) -> i32;
        pub fn GetDIBits(
            hdc: isize,
            hbm: isize,
            start: u32,
            lines: u32,
            bits: *mut c_void,
            bmi: *mut BmpInfo,
            usage: u32,
        ) -> i32;
        pub fn DeleteObject(h: isize) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        pub fn SHGetFileInfoW(path: *const u16, attrs: u32, psfi: *mut ShFileInfo, cb: u32, flags: u32) -> usize;
        pub fn ExtractIconExW(path: *const u16, index: i32, large: *mut isize, small: *mut isize, n: u32) -> u32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegGetValueW(
            hkey: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        pub fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> i32;
        pub fn CoUninitialize();
    }
}

#[cfg(target_os = "windows")]
fn exe_of(hwnd: isize) -> Option<String> {
    if hwnd == 0 {
        return None;
    }
    unsafe {
        let mut pid = 0u32;
        sys::GetWindowThreadProcessId(hwnd, &mut pid);
        path_of_pid(pid)
    }
}

#[cfg(target_os = "windows")]
unsafe fn path_of_pid(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let h = sys::OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if h == 0 {
        return None;
    }
    let mut buf = [0u16; 1040];
    let mut len = buf.len() as u32;
    let ok = sys::QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
    sys::CloseHandle(h);
    if ok == 0 || len == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

#[cfg(not(target_os = "windows"))]
fn exe_of(_hwnd: isize) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct ChildScan {
    host_pid: u32,
    found_pid: u32,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_child(h: isize, lparam: isize) -> i32 {
    let st = &mut *(lparam as *mut ChildScan);
    let mut pid = 0u32;
    sys::GetWindowThreadProcessId(h, &mut pid);
    if pid != 0 && pid != st.host_pid {
        st.found_pid = pid;
        return 0; // stop
    }
    1
}

#[cfg(target_os = "windows")]
fn uwp_app_path(hwnd: isize) -> Option<String> {
    unsafe {
        let mut host = 0u32;
        sys::GetWindowThreadProcessId(hwnd, &mut host);
        let mut st = ChildScan { host_pid: host, found_pid: 0 };
        sys::EnumChildWindows(hwnd, Some(enum_child), &mut st as *mut ChildScan as isize);
        if st.found_pid == 0 {
            None
        } else {
            path_of_pid(st.found_pid)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn uwp_app_path(_hwnd: isize) -> Option<String> {
    None
}

fn file_name_lc(path: &str) -> String {
    path.rsplit(|c: char| c == '\\' || c == '/').next().unwrap_or("").to_lowercase()
}

fn win_dir() -> &'static str {
    static WD: OnceLock<String> = OnceLock::new();
    WD.get_or_init(|| {
        let d = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .unwrap_or_else(|_| "C:\\Windows".to_string())
            .to_lowercase()
            .replace('/', "\\");
        d.trim_end_matches(|c: char| c == '\\').to_string()
    })
}

fn under_windows(path: &str) -> bool {
    let l = path.to_lowercase().replace('/', "\\");
    let wd = win_dir();
    l.starts_with(wd) && l[wd.len()..].starts_with('\\')
}

#[cfg(target_os = "windows")]
fn resolve(hwnd: isize) -> Option<String> {
    if hwnd == 0 {
        return None;
    }
    // Climb to root window so Electron/Discord child frames are not missed!
    let root = unsafe {
        let r = sys::GetAncestor(hwnd, 2); // GA_ROOT = 2
        if r != 0 { r } else { hwnd }
    };
    if !is_real_window(root) {
        return None;
    }
    let mut path = exe_of(root)?;
    if file_name_lc(&path) == "applicationframehost.exe" {
        path = uwp_app_path(root)?;
    }
    track_name(&path)
}

#[cfg(not(target_os = "windows"))]
fn resolve(_hwnd: isize) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn is_real_window(hwnd: isize) -> bool {
    if hwnd == 0 {
        return false;
    }
    unsafe {
        if sys::IsWindowVisible(hwnd) == 0 {
            return false;
        }
        let ex = sys::GetWindowLongW(hwnd, -20) as u32; // GWL_EXSTYLE
        // Must not be a toolwindow or noactivate popup
        if (ex & 0x0000_0080) != 0 || (ex & 0x0800_0000) != 0 {
            return false;
        }
        true
    }
}

fn track_name(path: &str) -> Option<String> {
    if under_windows(path) {
        return None; // Drop C:\Windows\**
    }
    let name = file_name_lc(path);
    if name.is_empty() || ignored(&name) || denied(&name) || junk_name(&name) {
        return None;
    }
    let mut g = paths_lock();
    if g.get(&name).map(|p| p.as_str()) != Some(path) {
        g.insert(name.clone(), path.to_string());
    }
    Some(name)
}

#[cfg(target_os = "windows")]
fn foreground_exe() -> Option<String> {
    let h = unsafe { sys::GetForegroundWindow() };
    resolve(h)
}

#[cfg(not(target_os = "windows"))]
fn foreground_exe() -> Option<String> {
    None
}

// Background hosts, brokers, daemons, overlays and helper tools: never an app the user "uses".
fn junk_name(exe: &str) -> bool {
    let n = exe.to_lowercase();
    n.ends_with("host.exe")
        || n.ends_with("broker.exe")
        || [
            "experience", "overlay", "daemon", "powertoys", "cmdpal", "quicklook",
            "applicationframehost", "phoneexperiencehost", "systemsettings", "textinputhost",
            "searchhost", "startmenuexperiencehost", "runtimebroker", "widgets",
            "crashpad", "updater", "helper", "taskmgr", "snippingtool", "dwm",
        ]
        .iter()
        .any(|k| n.contains(k))
}

fn ignored(exe: &str) -> bool {
    static OWN: OnceLock<String> = OnceLock::new();
    let own = OWN.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
            .unwrap_or_default()
    });
    exe == own
        || junk_name(exe)
        || matches!(
            exe,
            "logonui.exe"
                | "lockapp.exe"
                | "searchhost.exe"
                | "searchapp.exe"
                | "startmenuexperiencehost.exe"
                | "shellexperiencehost.exe"
                | "textinputhost.exe"
                | "credentialuibroker.exe"
                | "consent.exe"
                | "dwm.exe"
        )
}

fn denied(exe: &str) -> bool {
    matches!(
        exe,
        "taskmgr.exe"
            | "snippingtool.exe"
            | "screenclippinghost.exe"
            | "cmd.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "conhost.exe"
            | "openconsole.exe"
            | "explorer.exe"
            | "windowsterminal.exe"
            | "wt.exe"
            | "applicationframehost.exe"
    )
}

// ---------------------------------------------------------------- core
#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_taskbar_window(hwnd: isize, lparam: isize) -> i32 {
    let list = &mut *(lparam as *mut Vec<isize>);
    if sys::IsWindowVisible(hwnd) != 0 {
        let ex = sys::GetWindowLongW(hwnd, -20) as u32; // GWL_EXSTYLE
        if (ex & 0x0000_0080) == 0 { // Not a tool window
            let owner = sys::GetWindow(hwnd, 4); // GW_OWNER = 4
            if owner == 0 || (ex & 0x0004_0000) != 0 {
                list.push(hwnd);
            }
        }
    }
    1
}

#[cfg(target_os = "windows")]
fn get_open_taskbar_apps() -> std::collections::HashSet<String> {
    let mut hwnds: Vec<isize> = Vec::with_capacity(32);
    unsafe {
        sys::EnumWindows(
            Some(enum_taskbar_window),
            &mut hwnds as *mut Vec<isize> as isize,
        );
    }
    let mut set = std::collections::HashSet::new();
    for hwnd in hwnds {
        let root = unsafe {
            let r = sys::GetAncestor(hwnd, 2); // GA_ROOT = 2
            if r != 0 { r } else { hwnd }
        };
        if let Some(mut path) = exe_of(root) {
            if file_name_lc(&path) == "applicationframehost.exe" {
                if let Some(p) = uwp_app_path(root) {
                    path = p;
                }
            }
            if let Some(name) = track_name(&path) {
                set.insert(name);
            }
        }
    }
    set
}

#[cfg(not(target_os = "windows"))]
fn get_open_taskbar_apps() -> std::collections::HashSet<String> {
    std::collections::HashSet::new()
}

fn accrue() {
    if !ENABLED.load(Ordering::Relaxed) {
        let mut last_g = LAST_INSTANT.lock().unwrap_or_else(|e| e.into_inner());
        *last_g = Some(Instant::now());
        return;
    }
    let now = Instant::now();
    let mut last_g = LAST_INSTANT.lock().unwrap_or_else(|e| e.into_inner());
    let last = match *last_g {
        Some(l) => l,
        None => {
            *last_g = Some(now);
            return;
        }
    };
    let el = now.duration_since(last).as_secs();
    if el == 0 {
        return;
    }
    if el > 60 {
        *last_g = Some(now);
        return;
    }
    *last_g = Some(last + Duration::from_secs(el));

    let open_apps = get_open_taskbar_apps();
    if idle_ms() < IDLE_LIMIT_MS {
        TOTAL_SECS.fetch_add(el, Ordering::Relaxed);
        let mut apps = apps_lock();
        for exe in open_apps {
            *apps.entry(exe).or_insert(0) += el;
        }
    }
}

/// Called by native_events.rs when another window becomes the foreground window.
pub fn on_foreground(_hwnd: isize) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    accrue();
}

pub fn start() {
    let enabled_path = crate::startup::data_dir().join("screentime_enabled.txt");
    if let Ok(content) = std::fs::read_to_string(&enabled_path) {
        if content.trim() == "0" {
            ENABLED.store(false, Ordering::Relaxed);
        }
    }

    // Restore today's accumulated times from disk log if present (avoids reset on restart)
    let t_str = today();
    let disk_days = read_disk_history();
    if let Some(today_record) = disk_days.iter().find(|d| d.date == t_str) {
        TOTAL_SECS.store(today_record.total, Ordering::Relaxed);
        let mut apps = apps_lock();
        for app in &today_record.apps {
            apps.entry(app.exe.clone()).or_insert(app.secs);
        }
    }

    // Release the guard BEFORE accrue() below: accrue() locks LAST_INSTANT again and a std Mutex
    // is not re-entrant, so holding it here froze app setup (no island, no tray icon).
    {
        let mut last_g = LAST_INSTANT.lock().unwrap_or_else(|e| e.into_inner());
        *last_g = Some(Instant::now());
    }

    if ENABLED.load(Ordering::Relaxed) {
        accrue();
    }

    let _ = std::thread::Builder::new().name("screentime".into()).spawn(|| {
        let mut ticks = 0u64;
        loop {
            std::thread::sleep(Duration::from_secs(TICK_SECS));
            if ENABLED.load(Ordering::Relaxed) {
                accrue();
                ticks += 1;
                // Periodic flush every 30s so disk log stays up to date with zero RAM footprint
                if ticks % 6 == 0 {
                    save();
                }
            }
        }
    });
}

// ---------------------------------------------------------------- names
fn pretty(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").unwrap_or(exe);
    let known = match stem {
        "code" => "Visual Studio Code",
        "chrome" => "Google Chrome",
        "msedge" => "Microsoft Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "opera" => "Opera",
        "spotify" => "Spotify",
        "discord" => "Discord",
        "whatsapp" | "whatsapp.root" => "WhatsApp",
        "telegram" => "Telegram",
        "slack" => "Slack",
        "steam" | "steamwebhelper" => "Steam",
        "photoshop" => "Adobe Photoshop",
        "illustrator" => "Adobe Illustrator",
        "figma" => "Figma",
        "notion" => "Notion",
        "obsidian" => "Obsidian",
        "devenv" => "Visual Studio",
        "studio64" => "Android Studio",
        "claude" => "Claude",
        "antigravity" => "Antigravity",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    let s = stem.replace(['-', '_'], " ");
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => exe.to_string(),
    }
}

// ---------------------------------------------------------------- commands
#[derive(Serialize, Deserialize, Clone)]
pub struct AppTime {
    pub exe: String,
    pub name: String,
    pub secs: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DayTime {
    pub date: String,
    pub total: u64,
    pub apps: Vec<AppTime>,
}

/// Today's current session time & apps sorted descending by time.
#[tauri::command]
pub fn get_screen_time_today() -> DayTime {
    if !ENABLED.load(Ordering::Relaxed) {
        let history = read_disk_history();
        let today_str = today();
        if let Some(today_record) = history.into_iter().find(|d| d.date == today_str) {
            return today_record;
        }
        return DayTime {
            date: today_str,
            total: 0,
            apps: Vec::new(),
        };
    }
    accrue();
    let tracked_total = TOTAL_SECS.load(Ordering::Relaxed);
    let total = crate::session_history::today_pc_screen_time_secs().unwrap_or(tracked_total);
    let apps_g = apps_lock();
    let mut apps: Vec<AppTime> = apps_g
        .iter()
        .filter(|(exe, secs)| **secs >= MIN_SECS && !ignored(exe) && !denied(exe) && !junk_name(exe))
        .map(|(exe, secs)| AppTime {
            exe: exe.clone(),
            name: pretty(exe),
            secs: *secs,
        })
        .collect();
    apps.sort_by(|a, b| b.secs.cmp(&a.secs));
    DayTime {
        date: today(),
        total,
        apps,
    }
}

#[tauri::command]
pub fn get_screen_time_history() -> Vec<DayTime> {
    if !ENABLED.load(Ordering::Relaxed) {
        return read_disk_history();
    }
    accrue();
    let today_data = get_screen_time_today();
    sync_and_prune(today_data)
}

#[tauri::command]
pub fn set_screen_time_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    let path = crate::startup::data_dir().join("screentime_enabled.txt");
    let _ = std::fs::write(path, if on { "1" } else { "0" });
    if on {
        let mut last_g = LAST_INSTANT.lock().unwrap_or_else(|e| e.into_inner());
        *last_g = Some(Instant::now());
        let mut cur = CUR_APP.lock().unwrap_or_else(|e| e.into_inner());
        *cur = foreground_exe();
    } else {
        save();
        let mut cur = CUR_APP.lock().unwrap_or_else(|e| e.into_inner());
        *cur = None;
    }
}

#[tauri::command]
pub fn clear_screen_time() {
    TOTAL_SECS.store(0, Ordering::Relaxed);
    let mut apps = apps_lock();
    apps.clear();
    let mut cur = CUR_APP.lock().unwrap_or_else(|e| e.into_inner());
    *cur = None;
    let mut last = LAST_INSTANT.lock().unwrap_or_else(|e| e.into_inner());
    *last = Some(Instant::now());
    let _ = std::fs::remove_file(history_path());
}

// ---------------------------------------------------------------- app icons
fn crc32(data: &[u8]) -> u32 {
    let mut c: u32 = 0xFFFF_FFFF;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(4 + data.len());
    body.extend_from_slice(kind);
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
}

fn png_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let row = (w as usize) * 4;
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * row..(y + 1) * row]);
    }
    let mut z: Vec<u8> = vec![0x78, 0x01];
    let mut i = 0usize;
    while i < raw.len() {
        let n = (raw.len() - i).min(65535);
        z.push(if i + n >= raw.len() { 1 } else { 0 });
        z.extend_from_slice(&(n as u16).to_le_bytes());
        z.extend_from_slice(&(!(n as u16)).to_le_bytes());
        z.extend_from_slice(&raw[i..i + n]);
        i += n;
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png_chunk(&mut out, b"IHDR", &ihdr);
    png_chunk(&mut out, b"IDAT", &z);
    png_chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(target_os = "windows")]
unsafe fn dib_bits(dc: isize, bmp: isize, w: usize, h: usize) -> Option<Vec<u8>> {
    let mut bi: sys::BmpInfo = std::mem::zeroed();
    bi.header.size = std::mem::size_of::<sys::BmpInfoHeader>() as u32;
    bi.header.width = w as i32;
    bi.header.height = -(h as i32);
    bi.header.planes = 1;
    bi.header.bit_count = 32;
    let mut buf = vec![0u8; w * h * 4];
    let n = sys::GetDIBits(dc, bmp, 0, h as u32, buf.as_mut_ptr() as *mut std::ffi::c_void, &mut bi, 0);
    if n == 0 {
        None
    } else {
        Some(buf)
    }
}

#[cfg(target_os = "windows")]
unsafe fn icon_to_png(icon: isize) -> Option<Vec<u8>> {
    let mut ii: sys::IconInfo = std::mem::zeroed();
    if sys::GetIconInfo(icon, &mut ii) == 0 {
        return None;
    }
    let mut out = None;
    if ii.hbm_color != 0 {
        let mut bm: sys::Bitmap = std::mem::zeroed();
        let got = sys::GetObjectW(
            ii.hbm_color,
            std::mem::size_of::<sys::Bitmap>() as i32,
            &mut bm as *mut sys::Bitmap as *mut std::ffi::c_void,
        );
        if got != 0 && bm.width > 0 && bm.height > 0 && bm.width <= 256 && bm.height <= 256 {
            let (w, h) = (bm.width as usize, bm.height as usize);
            let dc = sys::GetDC(0);
            if dc != 0 {
                if let Some(mut px) = dib_bits(dc, ii.hbm_color, w, h) {
                    if px.chunks(4).all(|c| c[3] == 0) {
                        let mask = if ii.hbm_mask != 0 { dib_bits(dc, ii.hbm_mask, w, h) } else { None };
                        match mask {
                            Some(m) => {
                                for (c, k) in px.chunks_mut(4).zip(m.chunks(4)) {
                                    c[3] = if k[0] == 0 { 255 } else { 0 };
                                }
                            }
                            None => {
                                for c in px.chunks_mut(4) {
                                    c[3] = 255;
                                }
                            }
                        }
                    }
                    for c in px.chunks_mut(4) {
                        c.swap(0, 2);
                    }
                    out = Some(png_rgba(w as u32, h as u32, &px));
                }
                sys::ReleaseDC(0, dc);
            }
        }
    }
    if ii.hbm_color != 0 {
        sys::DeleteObject(ii.hbm_color);
    }
    if ii.hbm_mask != 0 {
        sys::DeleteObject(ii.hbm_mask);
    }
    out
}

#[cfg(target_os = "windows")]
fn find_app_path(exe: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    if let Some(p) = paths_lock().get(exe) {
        if std::path::Path::new(p).exists() {
            return Some(p.clone());
        }
    }
    // Check Registry App Paths: HKLM & HKCU
    for &hkey in &[-2147483646isize, -2147483647isize] { // HKLM = 0x80000002, HKCU = 0x80000001
        let subkey: Vec<u16> = std::ffi::OsStr::new(&format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{}", exe))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let r = unsafe {
            sys::RegGetValueW(
                hkey,
                subkey.as_ptr(),
                std::ptr::null(),
                0x00000002 | 0x00000004, // RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                &mut size,
            )
        };
        if r == 0 && size > 2 {
            let len = (size / 2) as usize;
            let raw = String::from_utf16_lossy(&buf[..len]).trim_matches('\0').trim_matches('"').to_string();
            if std::path::Path::new(&raw).exists() {
                return Some(raw);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn extract_icon_png(path: &str) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let mut fi: sys::ShFileInfo = std::mem::zeroed();
        let r = sys::SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut fi,
            std::mem::size_of::<sys::ShFileInfo>() as u32,
            0x100, // SHGFI_ICON (large)
        );
        if r != 0 && fi.icon != 0 {
            let png = icon_to_png(fi.icon);
            sys::DestroyIcon(fi.icon);
            if png.is_some() {
                return png;
            }
        }
        let mut large: isize = 0;
        let mut small: isize = 0;
        let n = sys::ExtractIconExW(wide.as_ptr(), 0, &mut large, &mut small, 1);
        let ico = if large != 0 { large } else { small };
        if n > 0 && ico != 0 {
            let png = icon_to_png(ico);
            if large != 0 { sys::DestroyIcon(large); }
            if small != 0 { sys::DestroyIcon(small); }
            return png;
        }
        None
    }
}

#[cfg(not(target_os = "windows"))]
fn extract_icon_png(_path: &str) -> Option<Vec<u8>> {
    None
}

fn icons_for(exes: Vec<String>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let dir = crate::startup::data_dir().join("icons");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    let com = unsafe { sys::CoInitializeEx(std::ptr::null_mut(), 2) };
    for exe in exes {
        let safe: String = exe
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '_' })
            .collect();
        if safe.is_empty() || safe.starts_with('.') {
            continue;
        }
        let file = dir.join(format!("{}.png", safe));
        let cached = std::fs::read(&file).ok().filter(|b| !b.is_empty());
        let bytes = match cached {
            Some(b) => Some(b),
            None => {
                #[cfg(target_os = "windows")]
                let path = find_app_path(&exe);
                #[cfg(not(target_os = "windows"))]
                let path: Option<String> = None;
                match path.and_then(|p| extract_icon_png(&p)) {
                    Some(b) => {
                        let _ = std::fs::write(&file, &b);
                        Some(b)
                    }
                    None => None,
                }
            }
        };
        if let Some(b) = bytes {
            out.insert(exe, format!("data:image/png;base64,{}", crate::media::base64_encode(&b)));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if com >= 0 {
            unsafe { sys::CoUninitialize() };
        }
    }
    out
}

#[tauri::command]
pub async fn get_app_icons(exes: Vec<String>) -> HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || icons_for(exes)).await.unwrap_or_default()
}
