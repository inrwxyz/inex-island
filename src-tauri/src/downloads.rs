// Download watcher: lists unfinished browser downloads (.crdownload / .part / ...) and freshly
// finished files in the user's Downloads folder. The island polls this once a second and draws the HUD.
// Browsers do not publish the total size, so progress is "bytes so far", not a percentage.

use serde::Serialize;
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Serialize, Clone)]
pub struct DlFile {
    pub name: String,
    pub size: u64,
    pub age_secs: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct DlScan {
    pub partials: Vec<DlFile>,
    pub recent: Vec<DlFile>,
}

const PARTIAL_EXT: [&str; 5] = ["crdownload", "part", "opdownload", "download", "partial"];

fn downloads_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
        unsafe {
            if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, windows::Win32::Foundation::HANDLE::default()) {
                let s = p.to_string().ok();
                windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
                if let Some(s) = s {
                    let pb = PathBuf::from(s);
                    if pb.is_dir() {
                        return Some(pb);
                    }
                }
            }
        }
        let pb = PathBuf::from(std::env::var("USERPROFILE").ok()?).join("Downloads");
        return if pb.is_dir() { Some(pb) } else { None };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pb = PathBuf::from(std::env::var("HOME").ok()?).join("Downloads");
        if pb.is_dir() { Some(pb) } else { None }
    }
}

#[tauri::command]
pub fn downloads_scan() -> DlScan {
    let mut out = DlScan::default();
    let dir = match downloads_dir() {
        Some(d) => d,
        None => return out,
    };
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return out,
    };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let age_secs = md
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|d| d.as_secs())
            .unwrap_or(u64::MAX);
        let f = DlFile { name, size: md.len(), age_secs };
        if PARTIAL_EXT.contains(&ext.as_str()) {
            // a stale partial (paused / abandoned for a day) is not "downloading"
            if f.age_secs < 86_400 {
                out.partials.push(f);
            }
        } else if f.age_secs <= 30 && !f.name.starts_with('~') && !f.name.eq_ignore_ascii_case("desktop.ini") {
            out.recent.push(f);
        }
    }
    out.partials.truncate(20);
    out.recent.sort_by_key(|f| f.age_secs);
    out.recent.truncate(20);
    out
}

// Show a finished download in Explorer (file selected).
#[tauri::command]
pub fn open_download(name: String) {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Some(dir) = downloads_dir() {
            let path = dir.join(&name);
            if path.exists() {
                let _ = std::process::Command::new("explorer.exe")
                    .raw_arg(format!("/select,\"{}\"", path.display()))
                    .creation_flags(0x0800_0000)
                    .spawn();
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = name;
}

pub fn start_downloads_watcher(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use tauri::Emitter;
        std::thread::spawn(move || {
            use windows::core::HSTRING;
            use windows::Win32::Storage::FileSystem::{
                FindFirstChangeNotificationW, FindNextChangeNotification,
                FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
            };
            use windows::Win32::System::Threading::WaitForSingleObject;
            use windows::Win32::Foundation::WAIT_OBJECT_0;

            let dir = match downloads_dir() {
                Some(d) => d,
                None => return,
            };
            let dir_str = dir.to_string_lossy().to_string();
            let h_path = HSTRING::from(dir_str);

            unsafe {
                let handle = match FindFirstChangeNotificationW(
                    &h_path,
                    false,
                    FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_SIZE,
                ) {
                    Ok(h) => h,
                    Err(_) => return,
                };

                loop {
                    let wait = WaitForSingleObject(handle, 3600_000);
                    if wait == WAIT_OBJECT_0 {
                        let scan = downloads_scan();
                        let _ = app.emit("downloads-changed", scan);
                        let _ = FindNextChangeNotification(handle);
                        std::thread::sleep(std::time::Duration::from_millis(600));
                    }
                }
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}
