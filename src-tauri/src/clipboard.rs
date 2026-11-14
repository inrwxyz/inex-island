//! Clipboard helpers & zero-polling OS screenshot watcher for the island shelf.
//!
//! Only copied text (handled via `get_clipboard_text`) and screenshots (tracked strictly by file
//! path) are kept in shelf history:
//!   - `start_screenshot_watch(app)`   : `ReadDirectoryChangesW` kernel notification (0% idle CPU)
//!   - `filter_screenshot_paths(paths)`: retains only existing image files inside the Screenshots dir
//!   - `filter_existing_paths(paths)`  : drops paths that no longer exist on disk
//!   - `read_screenshot_bytes(path)`   : raw image bytes for on-demand thumbnail preview (no base64)
//!   - `get_clipboard_files()`         : reads `CF_HDROP` file paths (used to filter screenshots)
//!   - `set_clipboard_files(paths)`    : writes `CF_HDROP` path reference to clipboard if file exists

use std::path::{Path, PathBuf};

const MAX_SCREENSHOT_PREVIEW_BYTES: u64 = 30 * 1024 * 1024;

pub(crate) fn is_screenshot_ext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp"
    )
}

pub(crate) fn norm_path_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    s.trim_end_matches('\\').to_ascii_lowercase()
}

pub(crate) fn is_under_dir(file: &Path, dir: &Path) -> bool {
    let Some(parent) = file.parent() else {
        return false;
    };
    norm_path_key(parent) == norm_path_key(dir)
}

#[cfg(windows)]
pub(crate) fn screenshots_dir() -> Option<PathBuf> {
    use windows::Win32::System::Com::{CoTaskMemFree, CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{FOLDERID_Screenshots, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Ok(raw) = SHGetKnownFolderPath(&FOLDERID_Screenshots, KF_FLAG_DEFAULT, None) {
            let s = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0 as *const _));
            if let Some(dir) = s.filter(|d| !d.is_empty()) {
                return Some(PathBuf::from(dir));
            }
        }
    }
    std::env::var_os("USERPROFILE").map(|u| PathBuf::from(u).join("Pictures").join("Screenshots"))
}

#[cfg(not(windows))]
pub(crate) fn screenshots_dir() -> Option<PathBuf> {
    None
}

pub(crate) fn is_screenshot_path_in_dir(path: &Path, dir: &Path) -> bool {
    is_screenshot_ext(path) && is_under_dir(path, dir)
}

#[cfg(windows)]
mod imp {
    use super::{is_screenshot_ext, is_screenshot_path_in_dir, norm_path_key, screenshots_dir};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HWND, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_ACTION_ADDED, FILE_ACTION_MODIFIED,
        FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW_NAME, FILE_ACTION_RENAMED_OLD_NAME,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_FILE_NAME,
        FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE, FILE_NOTIFY_INFORMATION,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_HDROP: u32 = 15;

    unsafe fn with_clipboard<T>(f: impl FnOnce() -> T) -> Option<T> {
        for _ in 0..6 {
            if OpenClipboard(HWND::default()).is_ok() {
                let out = f();
                let _ = CloseClipboard();
                return Some(out);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }

    pub fn read_files() -> Vec<String> {
        unsafe {
            with_clipboard(|| {
                let mut paths: Vec<String> = Vec::new();
                if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
                    if let Ok(h) = GetClipboardData(CF_HDROP) {
                        if !h.0.is_null() {
                            let drop = HDROP(h.0 as _);
                            let count = DragQueryFileW(drop, u32::MAX, None);
                            for index in 0..count {
                                let needed = DragQueryFileW(drop, index, None) as usize;
                                let mut buf = vec![0u16; needed + 1];
                                let written =
                                    (DragQueryFileW(drop, index, Some(&mut buf)) as usize).min(needed);
                                paths.push(String::from_utf16_lossy(&buf[..written]));
                            }
                        }
                    }
                }
                paths
            })
            .unwrap_or_default()
        }
    }

    /// Places only existing file paths on the Windows clipboard (`CF_HDROP`).
    pub fn write_files(paths: &[String]) -> bool {
        let existing: Vec<&String> = paths.iter().filter(|p| Path::new(p.as_str()).is_file()).collect();
        if existing.is_empty() {
            return false;
        }
        // DROPFILES header (20 bytes): pFiles = 20, pt = (0,0), fNC = 0, fWide = 1; then "a\0b\0\0" in UTF-16.
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(&20u32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        for p in &existing {
            for u in p.encode_utf16() {
                bytes.extend_from_slice(&u.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());

        unsafe {
            let hg = match GlobalAlloc(GMEM_MOVEABLE, bytes.len()) {
                Ok(h) => h,
                Err(_) => return false,
            };
            let dst = GlobalLock(hg) as *mut u8;
            if dst.is_null() {
                let _ = GlobalFree(hg);
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
            let _ = GlobalUnlock(hg);

            let ok = with_clipboard(|| {
                let _ = EmptyClipboard();
                SetClipboardData(CF_HDROP, HANDLE(hg.0)).is_ok()
            })
            .unwrap_or(false);

            // Windows only takes ownership of the HGLOBAL when SetClipboardData succeeds.
            if !ok {
                let _ = GlobalFree(hg);
            }
            ok
        }
    }

    pub fn watch_screenshots(app: AppHandle) {
        let Some(dir) = screenshots_dir() else {
            return;
        };
        let _ = std::fs::create_dir_all(&dir);
        let wide: Vec<u16> = dir
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let handle = unsafe {
            CreateFileW(
                windows::core::PCWSTR(wide.as_ptr()),
                FILE_LIST_DIRECTORY.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                None,
            )
        };
        let Ok(dir_handle) = handle else {
            return;
        };
        if dir_handle == INVALID_HANDLE_VALUE {
            return;
        }

        let mut buf = vec![0u8; 16 * 1024];
        let mut last_added: Option<(String, Instant)> = None;

        loop {
            let mut bytes_returned = 0u32;
            let ok = unsafe {
                ReadDirectoryChangesW(
                    dir_handle,
                    buf.as_mut_ptr() as *mut _,
                    buf.len() as u32,
                    false,
                    FILE_NOTIFY_CHANGE_FILE_NAME
                        | FILE_NOTIFY_CHANGE_LAST_WRITE
                        | FILE_NOTIFY_CHANGE_SIZE,
                    Some(&mut bytes_returned),
                    None,
                    None,
                )
            };
            if ok.is_err() || bytes_returned == 0 {
                break;
            }

            let mut offset = 0usize;
            while offset + std::mem::size_of::<FILE_NOTIFY_INFORMATION>() <= bytes_returned as usize {
                let info = unsafe { &*(buf.as_ptr().add(offset) as *const FILE_NOTIFY_INFORMATION) };
                let name_bytes = info.FileNameLength as usize;
                let max_bytes = (bytes_returned as usize).saturating_sub(offset + 12);
                let slice_u16_len = (name_bytes.min(max_bytes)) / 2;
                let file_name = if slice_u16_len > 0 {
                    let ptr = info.FileName.as_ptr();
                    let s = unsafe { std::slice::from_raw_parts(ptr, slice_u16_len) };
                    String::from_utf16_lossy(s)
                } else {
                    String::new()
                };

                if !file_name.is_empty() {
                    let full: PathBuf = dir.join(&file_name);
                    if is_screenshot_ext(&full) && is_screenshot_path_in_dir(&full, &dir) {
                        match info.Action {
                            FILE_ACTION_ADDED | FILE_ACTION_MODIFIED | FILE_ACTION_RENAMED_NEW_NAME => {
                                let ready = std::fs::metadata(&full)
                                    .map(|m| m.is_file() && m.len() > 0)
                                    .unwrap_or(false);
                                if ready {
                                    let key = norm_path_key(&full);
                                    let dup = last_added
                                        .as_ref()
                                        .map(|(k, t)| k == &key && t.elapsed() < Duration::from_secs(2))
                                        .unwrap_or(false);
                                    if !dup {
                                        last_added = Some((key, Instant::now()));
                                        let _ = app.emit(
                                            "screenshot-added",
                                            serde_json::json!({ "path": full.to_string_lossy().to_string() }),
                                        );
                                    }
                                }
                            }
                            FILE_ACTION_REMOVED | FILE_ACTION_RENAMED_OLD_NAME => {
                                let _ = app.emit(
                                    "screenshot-removed",
                                    serde_json::json!({ "path": full.to_string_lossy().to_string() }),
                                );
                            }
                            _ => {}
                        }
                    }
                }

                if info.NextEntryOffset == 0 {
                    break;
                }
                offset += info.NextEntryOffset as usize;
            }
        }
        unsafe {
            let _ = CloseHandle(dir_handle);
        }
    }
}

pub fn start_screenshot_watch(app: AppHandle) {
    #[cfg(windows)]
    {
        let _ = std::thread::Builder::new()
            .name("inex-screenshot-watch".to_string())
            .spawn(move || imp::watch_screenshots(app));
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub async fn get_clipboard_files() -> Vec<String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(imp::read_files)
            .await
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn set_clipboard_files(paths: Vec<String>) -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || imp::write_files(&paths))
            .await
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        false
    }
}

#[tauri::command]
pub fn filter_screenshot_paths(paths: Vec<String>) -> Vec<String> {
    let Some(dir) = screenshots_dir() else {
        return Vec::new();
    };
    paths
        .into_iter()
        .filter(|p| {
            let pb = Path::new(p);
            is_screenshot_path_in_dir(pb, &dir) && pb.is_file()
        })
        .collect()
}

#[tauri::command]
pub fn filter_existing_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect()
}

/// Reads raw bytes of an existing screenshot file for transient preview when Clipboard view is open.
#[tauri::command]
pub async fn read_screenshot_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = screenshots_dir() else {
            return Err("no screenshots folder".to_string());
        };
        let pb = Path::new(&path);
        if !is_screenshot_path_in_dir(pb, &dir) {
            return Err("not a screenshot".to_string());
        }
        let meta = std::fs::metadata(pb).map_err(|_| "missing".to_string())?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_SCREENSHOT_PREVIEW_BYTES {
            return Err("unreadable size".to_string());
        }
        let bytes = std::fs::read(pb).map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

use tauri::AppHandle;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_extension_filter() {
        assert!(is_screenshot_ext(Path::new("C:\\Shots\\shot.png")));
        assert!(is_screenshot_ext(Path::new("shot.JPEG")));
        assert!(is_screenshot_ext(Path::new("shot.webp")));
        assert!(!is_screenshot_ext(Path::new("shot.png.tmp")));
        assert!(!is_screenshot_ext(Path::new("movie.mp4")));
        assert!(!is_screenshot_ext(Path::new("notes.txt")));
    }

    #[test]
    fn screenshot_directory_matching() {
        let dir = Path::new(r"C:\Users\Demo\Pictures\Screenshots");
        assert!(is_screenshot_path_in_dir(
            Path::new(r"c:\users\demo\pictures\screenshots\Screenshot 2026.png"),
            dir
        ));
        assert!(!is_screenshot_path_in_dir(
            Path::new(r"C:\Users\Demo\Desktop\photo.png"),
            dir
        ));
        assert!(!is_screenshot_path_in_dir(
            Path::new(r"C:\Users\Demo\Pictures\Screenshots\sub\nested.png"),
            dir
        ));
    }

    #[test]
    fn existing_paths_drops_missing_files() {
        let tmp = std::env::temp_dir().join("inex_clip_test_exists.txt");
        let missing = std::env::temp_dir().join("inex_clip_test_missing_xyz.txt");
        std::fs::write(&tmp, b"ok").unwrap();
        let _ = std::fs::remove_file(&missing);

        let kept = filter_existing_paths(vec![
            tmp.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ]);
        assert_eq!(kept, vec![tmp.to_string_lossy().to_string()]);
        let _ = std::fs::remove_file(&tmp);
    }

    #[cfg(windows)]
    #[test]
    fn write_files_rejects_empty_or_missing() {
        assert!(!imp::write_files(&[]));
        assert!(!imp::write_files(&[r"C:\__definitely_missing__\nope.png".to_string()]));
    }
}
