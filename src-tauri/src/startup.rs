use std::io::Write;
use std::path::PathBuf;

// ---- Startup log: %LOCALAPPDATA%\com.inex.island\startup.log (shows what happened at boot) ----
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let d = base.join("com.inex.island");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn log(msg: &str) {
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
pub fn system_shutting_down() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SYSTEM_METRICS_INDEX};
        // SM_SHUTTINGDOWN, or WM_QUERYENDSESSION already seen by native_events.rs
        GetSystemMetrics(SYSTEM_METRICS_INDEX(0x2000)) != 0
            || crate::native_events::SHUTTING_DOWN.load(std::sync::atomic::Ordering::SeqCst)
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
