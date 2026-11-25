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

    fn load_image_as_hbitmap(path: &Path) -> Option<isize> {
        use std::ffi::c_void;
        use windows::Win32::Foundation::FreeLibrary;
        use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

        #[repr(C)]
        struct GdiplusStartupInput {
            gdiplus_version: u32,
            debug_event_callback: usize,
            suppress_background_thread: i32,
            suppress_external_codecs: i32,
        }

        let dll_name: Vec<u16> = "gdiplus.dll".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let hmodule = LoadLibraryW(windows::core::PCWSTR(dll_name.as_ptr())).ok()?;
            if hmodule.is_invalid() {
                return None;
            }

            let startup: Option<unsafe extern "system" fn(*mut usize, *const GdiplusStartupInput, *mut c_void) -> i32> =
                std::mem::transmute(GetProcAddress(hmodule, windows::core::s!("GdiplusStartup")));
            let shutdown: Option<unsafe extern "system" fn(usize)> =
                std::mem::transmute(GetProcAddress(hmodule, windows::core::s!("GdiplusShutdown")));
            let create_bitmap: Option<unsafe extern "system" fn(*const u16, *mut *mut c_void) -> i32> =
                std::mem::transmute(GetProcAddress(hmodule, windows::core::s!("GdipCreateBitmapFromFile")));
            let create_hbitmap: Option<unsafe extern "system" fn(*mut c_void, *mut isize, u32) -> i32> =
                std::mem::transmute(GetProcAddress(hmodule, windows::core::s!("GdipCreateHBITMAPFromBitmap")));
            let dispose: Option<unsafe extern "system" fn(*mut c_void) -> i32> =
                std::mem::transmute(GetProcAddress(hmodule, windows::core::s!("GdipDisposeImage")));

            let mut token: usize = 0;
            let input = GdiplusStartupInput {
                gdiplus_version: 1,
                debug_event_callback: 0,
                suppress_background_thread: 0,
                suppress_external_codecs: 0,
            };

            if let (Some(startup_fn), Some(shutdown_fn), Some(create_bitmap_fn), Some(create_hbitmap_fn), Some(dispose_fn)) =
                (startup, shutdown, create_bitmap, create_hbitmap, dispose)
            {
                if startup_fn(&mut token, &input, std::ptr::null_mut()) == 0 {
                    let wide_path: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
                    let mut gp_bitmap: *mut c_void = std::ptr::null_mut();
                    let mut hbitmap: isize = 0;

                    if create_bitmap_fn(wide_path.as_ptr(), &mut gp_bitmap) == 0 && !gp_bitmap.is_null() {
                        let _ = create_hbitmap_fn(gp_bitmap, &mut hbitmap, 0);
                        let _ = dispose_fn(gp_bitmap);
                    }
                    shutdown_fn(token);
                    let _ = FreeLibrary(hmodule);

                    if hbitmap != 0 {
                        return Some(hbitmap);
                    }
                } else {
                    let _ = FreeLibrary(hmodule);
                }
            } else {
                let _ = FreeLibrary(hmodule);
            }
        }
        None
    }

    /// Places existing file paths and image bitmap on the Windows clipboard (`CF_HDROP` + `CF_BITMAP`).
    pub fn write_files(paths: &[String]) -> bool {
        let existing: Vec<&String> = paths.iter().filter(|p| Path::new(p.as_str()).is_file()).collect();
        if existing.is_empty() {
            return false;
        }

        // If the first file is an image, load it as HBITMAP so CF_BITMAP is set on the clipboard
        let first_path = Path::new(existing[0].as_str());
        let hbm_opt = if is_screenshot_ext(first_path) {
            load_image_as_hbitmap(first_path)
        } else {
            None
        };

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
                Err(_) => {
                    if let Some(hbm) = hbm_opt {
                        use windows::Win32::Graphics::Gdi::DeleteObject;
                        use windows::Win32::Graphics::Gdi::HGDIOBJ;
                        let _ = DeleteObject(HGDIOBJ(hbm as *mut _));
                    }
                    return false;
                }
            };
            let dst = GlobalLock(hg) as *mut u8;
            if dst.is_null() {
                let _ = GlobalFree(hg);
                if let Some(hbm) = hbm_opt {
                    use windows::Win32::Graphics::Gdi::DeleteObject;
                    use windows::Win32::Graphics::Gdi::HGDIOBJ;
                    let _ = DeleteObject(HGDIOBJ(hbm as *mut _));
                }
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
            let _ = GlobalUnlock(hg);

            let ok = with_clipboard(|| {
                let _ = EmptyClipboard();
                let mut success = SetClipboardData(CF_HDROP, HANDLE(hg.0)).is_ok();
                if let Some(hbm) = hbm_opt {
                    const CF_BITMAP: u32 = 2;
                    let b_ok = SetClipboardData(CF_BITMAP, HANDLE(hbm as *mut _)).is_ok();
                    if b_ok {
                        success = true;
                    } else {
                        use windows::Win32::Graphics::Gdi::DeleteObject;
                        use windows::Win32::Graphics::Gdi::HGDIOBJ;
                        let _ = DeleteObject(HGDIOBJ(hbm as *mut _));
                    }
                }
                success
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

/// Raw bytes of an image file (png / jpg / webp / bmp / gif, max 12 MB) so the P2P menu can read a QR that was
/// dropped on it or copied as a file. Nothing else is readable through this.
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pb = Path::new(&path);
        let ext_ok = pb
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif"))
            .unwrap_or(false);
        if !ext_ok {
            return Err("not an image".to_string());
        }
        let meta = std::fs::metadata(pb).map_err(|_| "missing".to_string())?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > 12 * 1024 * 1024 {
            return Err("unreadable size".to_string());
        }
        let bytes = std::fs::read(pb).map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Windows bumps this number every time anything is copied (any app): the island polls it to show the "Copied" popup.
#[tauri::command]
pub fn clipboard_seq() -> u32 {
    #[cfg(windows)]
    {
        unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
    }
    #[cfg(not(windows))]
    {
        0
    }
}

#[tauri::command]
pub fn get_clipboard_text() -> String {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{HGLOBAL, HWND};
        use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
        const CF_UNICODETEXT: u32 = 13;
        for _ in 0..5 {
            if OpenClipboard(HWND::default()).is_ok() {
                let mut result = String::new();
                if let Ok(h) = GetClipboardData(CF_UNICODETEXT) {
                    if !h.0.is_null() {
                        let ptr = GlobalLock(HGLOBAL(h.0)) as *const u16;
                        if !ptr.is_null() {
                            let len = (0..).take_while(|&i| *ptr.add(i) != 0).count();
                            let slice = std::slice::from_raw_parts(ptr, len);
                            result = String::from_utf16_lossy(slice);
                            let _ = GlobalUnlock(HGLOBAL(h.0));
                        }
                    }
                }
                let _ = CloseClipboard();
                if !result.is_empty() {
                    return result;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    String::new()
}

#[tauri::command]
pub fn set_clipboard_text(window: tauri::WebviewWindow, text: String) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        const CF_UNICODETEXT: u32 = 13;

        // Use our own window as the clipboard owner (a NULL owner can make some apps' right-click Paste ignore the text).
        let owner = match window.hwnd() {
            Ok(h) => HWND(h.0 as *mut core::ffi::c_void),
            Err(_) => HWND::default(),
        };
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes_len = wide.len() * 2;
        let hg = match GlobalAlloc(GMEM_MOVEABLE, bytes_len) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let dst = GlobalLock(hg) as *mut u16;
        if dst.is_null() {
            let _ = GlobalFree(hg);
            return false;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
        let _ = GlobalUnlock(hg);

        for _ in 0..5 {
            if OpenClipboard(owner).is_ok() {
                let _ = EmptyClipboard();
                let res = SetClipboardData(CF_UNICODETEXT, HANDLE(hg.0));
                let _ = CloseClipboard();
                return res.is_ok();
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = GlobalFree(hg);
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, text);
        false
    }
}

/// Converts raw RGBA pixels into a bottom-up 32bpp BGRA BITMAPINFOHEADER DIB buffer (`CF_DIB`).
#[cfg(any(windows, test))]
pub(crate) fn rgba_to_dib(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return None;
    }
    let expected = (width as usize).checked_mul(height as usize)?.checked_mul(4)?;
    if rgba.len() != expected {
        return None;
    }
    let row_bytes = (width as usize) * 4;
    let mut dib = Vec::with_capacity(40 + expected);
    // BITMAPINFOHEADER (40 bytes, little-endian)
    dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
    dib.extend_from_slice(&(width as i32).to_le_bytes()); // biWidth
    dib.extend_from_slice(&(height as i32).to_le_bytes()); // biHeight (>0 => bottom-up)
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    dib.extend_from_slice(&(expected as u32).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    dib.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    for y in (0..height as usize).rev() {
        let row = &rgba[y * row_bytes..(y + 1) * row_bytes];
        for px in row.chunks_exact(4) {
            dib.push(px[2]); // B
            dib.push(px[1]); // G
            dib.push(px[0]); // R
            dib.push(px[3]); // A
        }
    }
    Some(dib)
}

#[tauri::command]
pub fn set_clipboard_image(
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request,
) -> Result<bool, String> {
    let hdr = request.headers();
    let width: u32 = hdr
        .get("x-width")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "missing x-width".to_string())?;
    let height: u32 = hdr
        .get("x-height")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "missing x-height".to_string())?;
    let rgba = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("expected raw RGBA bytes".to_string()),
    };

    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        const CF_DIB: u32 = 8;

        let Some(dib) = rgba_to_dib(rgba, width, height) else {
            return Ok(false);
        };
        let owner = match window.hwnd() {
            Ok(h) => HWND(h.0 as *mut core::ffi::c_void),
            Err(_) => HWND::default(),
        };
        let hg = match GlobalAlloc(GMEM_MOVEABLE, dib.len()) {
            Ok(h) => h,
            Err(_) => return Ok(false),
        };
        let dst = GlobalLock(hg) as *mut u8;
        if dst.is_null() {
            let _ = GlobalFree(hg);
            return Ok(false);
        }
        std::ptr::copy_nonoverlapping(dib.as_ptr(), dst, dib.len());
        let _ = GlobalUnlock(hg);

        for _ in 0..5 {
            if OpenClipboard(owner).is_ok() {
                let _ = EmptyClipboard();
                let res = SetClipboardData(CF_DIB, HANDLE(hg.0));
                let _ = CloseClipboard();
                return Ok(res.is_ok());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _ = GlobalFree(hg);
        Ok(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, width, height, rgba);
        Ok(false)
    }
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

    #[cfg(windows)]
    #[test]
    fn write_files_with_image_sets_bitmap_format() {
        use windows::Win32::System::DataExchange::{IsClipboardFormatAvailable, OpenClipboard, CloseClipboard};
        use windows::Win32::Foundation::HWND;
        let shot = Path::new(r"C:\Users\inrwx\Pictures\Screenshots\Screenshot 2026-11-19 233638.png");
        if shot.is_file() {
            let paths = vec![shot.to_string_lossy().to_string()];
            let ok = imp::write_files(&paths);
            assert!(ok);
            unsafe {
                assert!(OpenClipboard(HWND::default()).is_ok());
                const CF_BITMAP: u32 = 2;
                const CF_HDROP: u32 = 15;
                assert!(IsClipboardFormatAvailable(CF_BITMAP).is_ok());
                assert!(IsClipboardFormatAvailable(CF_HDROP).is_ok());
                let _ = CloseClipboard();
            }
        }
    }

    #[test]
    fn rgba_to_dib_builds_valid_bottom_up_header() {
        // 2x2: top row red/green, bottom row blue/white
        let rgba = [
            255, 0, 0, 255,   0, 255, 0, 255,
            0, 0, 255, 255,   255, 255, 255, 255,
        ];
        let dib = rgba_to_dib(&rgba, 2, 2).expect("valid dib");
        assert_eq!(dib.len(), 40 + 16);
        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
        // Bottom row comes first in bottom-up DIB: blue (BGRA = 255,0,0,255)
        assert_eq!(&dib[40..44], &[255, 0, 0, 255]);
        // Top row comes second: red (BGRA = 0,0,255,255)
        assert_eq!(&dib[48..52], &[0, 0, 255, 255]);
        assert!(rgba_to_dib(&[0; 4], 2, 2).is_none());
        assert!(rgba_to_dib(&[], 0, 2).is_none());
    }
}
