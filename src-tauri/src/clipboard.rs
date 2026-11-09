//! Clipboard readers for the history shelf (images and copied files).
//!
//!   get_clipboard_image()      -> data URL ("data:image/png;base64,...") or "" when there is no image
//!   get_clipboard_files()      -> file paths of a copied file list (Explorer Ctrl+C) or []
//!   set_clipboard_files(paths) -> puts a file list back on the clipboard (so it can be pasted in Explorer)
//!
//! Text stays in `get_clipboard_text` (main.rs).

/// Biggest image we are willing to pull through the clipboard (raw bytes).
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

#[cfg(windows)]
mod imp {
    use super::MAX_IMAGE_BYTES;
    use windows::core::w;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_DIB: u32 = 8;
    const CF_HDROP: u32 = 15;

    /// Opens the clipboard (another app may hold it for a moment), runs `f`, closes it again.
    unsafe fn with_clipboard<T>(f: impl FnOnce() -> T) -> Option<T> {
        for _ in 0..6 {
            if OpenClipboard(HWND::default()).is_ok() {
                let out = f();
                let _ = CloseClipboard();
                return Some(out);
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        None
    }

    unsafe fn read_hglobal(h: HANDLE) -> Option<Vec<u8>> {
        let hg = HGLOBAL(h.0);
        let size = GlobalSize(hg);
        if size == 0 || size > MAX_IMAGE_BYTES {
            return None;
        }
        let p = GlobalLock(hg) as *const u8;
        if p.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(p, size).to_vec();
        let _ = GlobalUnlock(hg);
        Some(bytes)
    }

    fn le32(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    /// CF_DIB is a BMP without its 14-byte file header: put the header back so a browser can show it.
    fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
        if dib.len() < 40 {
            return None;
        }
        let header_size = le32(dib, 0);
        let bit_count = u16::from_le_bytes([dib[14], dib[15]]) as u32;
        let compression = le32(dib, 16);
        let clr_used = le32(dib, 32);

        let mut offset = 14 + header_size;
        if header_size == 40 {
            if compression == 3 {
                offset += 12; // BI_BITFIELDS: three colour masks follow the header
            } else if compression == 6 {
                offset += 16; // BI_ALPHABITFIELDS
            }
        }
        if bit_count <= 8 {
            let n = if clr_used != 0 { clr_used } else { 1u32 << bit_count };
            offset += n * 4;
        } else if clr_used != 0 {
            offset += clr_used * 4;
        }

        let mut out = Vec::with_capacity(14 + dib.len());
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&((14 + dib.len()) as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(dib);
        Some(out)
    }

    pub fn read_image() -> String {
        unsafe {
            let png_fmt = RegisterClipboardFormatW(w!("PNG"));
            with_clipboard(|| {
                // 1) a real PNG (browsers, Snipping Tool, most editors): keeps transparency
                if png_fmt != 0 && IsClipboardFormatAvailable(png_fmt).is_ok() {
                    if let Ok(h) = GetClipboardData(png_fmt) {
                        if let Some(bytes) = read_hglobal(h) {
                            if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                                return format!("data:image/png;base64,{}", crate::base64_encode(&bytes));
                            }
                        }
                    }
                }
                // 2) plain bitmap (Windows converts any bitmap format to CF_DIB for us)
                if IsClipboardFormatAvailable(CF_DIB).is_ok() {
                    if let Ok(h) = GetClipboardData(CF_DIB) {
                        if let Some(dib) = read_hglobal(h) {
                            if let Some(bmp) = dib_to_bmp(&dib) {
                                return format!("data:image/bmp;base64,{}", crate::base64_encode(&bmp));
                            }
                        }
                    }
                }
                String::new()
            })
            .unwrap_or_default()
        }
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
                                let written = (DragQueryFileW(drop, index, Some(&mut buf)) as usize).min(needed);
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

    pub fn write_files(paths: &[String]) -> bool {
        if paths.is_empty() {
            return false;
        }
        // DROPFILES header (20 bytes): pFiles = 20, pt = (0,0), fNC = 0, fWide = 1; then "a\0b\0\0" in UTF-16.
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(&20u32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        for p in paths {
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
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
            let _ = GlobalUnlock(hg);

            with_clipboard(|| {
                let _ = EmptyClipboard();
                SetClipboardData(CF_HDROP, HANDLE(hg.0)).is_ok()
            })
            .unwrap_or(false)
        }
    }
}

// These run on a worker thread: a screenshot is tens of MB and must not freeze the island.
#[tauri::command]
pub async fn get_clipboard_image() -> String {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(imp::read_image)
            .await
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        String::new()
    }
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

/// Biggest image file we read just to make a small preview.
const MAX_IMAGE_FILE_BYTES: u64 = 30 * 1024 * 1024;

/// Reads a copied picture file (png / jpg / gif / webp / bmp) as a data URL so the shelf can show a preview.
/// Returns "" for anything else (videos, documents ...), for missing files and for very big files.
#[tauri::command]
pub async fn read_image_file(path: String) -> String {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => return String::new(),
        };
        match std::fs::metadata(p) {
            Ok(m) if m.is_file() && m.len() <= MAX_IMAGE_FILE_BYTES => {}
            _ => return String::new(),
        }
        match std::fs::read(p) {
            Ok(bytes) => format!("data:{};base64,{}", mime, crate::base64_encode(&bytes)),
            Err(_) => String::new(),
        }
    })
    .await
    .unwrap_or_default()
}
