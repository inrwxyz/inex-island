// P2P file I/O and Native Drag-Drop Helpers (Windows).

// ======================================================================================
// P2P file I/O: real file paths (no copy), raw bytes over IPC (no base64), streamed to disk.
// Also: native drag-out of a file from the tray, and detection of Windows password prompts.
// ======================================================================================
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const RECV_BUF_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize)]
pub struct FileMeta {
    name: String,
    size: u64,
    path: String,
}

// Dropped paths -> name + size (folders are skipped)
#[tauri::command]
pub fn file_info(paths: Vec<String>) -> Vec<FileMeta> {
    let mut out = Vec::new();
    for p in paths {
        let pb = PathBuf::from(&p);
        if let Ok(md) = std::fs::metadata(&pb) {
            if md.is_file() {
                let name = pb
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".to_string());
                out.push(FileMeta { name, size: md.len(), path: p });
            }
        }
    }
    out
}

static READ_CACHE: OnceLock<Mutex<Option<(String, File)>>> = OnceLock::new();

fn read_block_sync(path: &str, offset: u64, len: u32) -> Result<Vec<u8>, String> {
    let want = (len as usize).min(8 * 1024 * 1024);
    let cache = READ_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().map_err(|e| e.to_string())?;
    let reuse = guard.as_ref().map(|(p, _)| p == path).unwrap_or(false);
    if !reuse {
        let f = File::open(path).map_err(|e| e.to_string())?;
        *guard = Some((path.to_string(), f));
    }
    let f = &mut guard.as_mut().unwrap().1;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; want];
    let mut filled = 0usize;
    while filled < want {
        let n = f.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    if filled < want {
        // Reached EOF for this file; release the cached handle promptly.
        *guard = None;
    }
    buf.truncate(filled);
    Ok(buf)
}

// Sender: read one block of a file off the async runtime thread (returned to JS as raw bytes)
#[tauri::command]
pub async fn read_file_chunk(
    path: String,
    offset: u64,
    len: u32,
) -> Result<tauri::ipc::Response, String> {
    let buf = tauri::async_runtime::spawn_blocking(move || read_block_sync(&path, offset, len))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(buf))
}

struct RecvFile {
    file: BufWriter<File>,
    part: PathBuf,
    dir: PathBuf,
    name: String,
}

static RECV: OnceLock<Mutex<HashMap<u64, RecvFile>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn recv_map() -> &'static Mutex<HashMap<u64, RecvFile>> {
    RECV.get_or_init(|| Mutex::new(HashMap::new()))
}

fn downloads_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Downloads"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn clean_name(n: &str) -> String {
    let s: String = n
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        "Inex_Shared_File.bin".to_string()
    } else {
        s.chars().take(150).collect()
    }
}

pub(crate) fn unique_dest_path(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    let mut dest = dir.join(name);
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("{} ({}){}", stem, n, ext));
        n += 1;
    }
    dest
}

fn recv_begin_in(dir: PathBuf, file_name: &str) -> Result<String, String> {
    let name = clean_name(file_name);
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let part = dir.join(format!("{}.inexpart{}", name, id));
    let raw_file = File::create(&part).map_err(|e| e.to_string())?;
    let file = BufWriter::with_capacity(RECV_BUF_BYTES, raw_file);
    recv_map()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, RecvFile { file, part, dir, name });
    Ok(id.to_string())
}

// Receiver step 1: open "<name>.inexpartN" in Downloads, returns an id
#[tauri::command]
pub fn recv_begin(file_name: String) -> Result<String, String> {
    recv_begin_in(downloads_dir(), &file_name)
}

// Receiver step 2 (repeated): raw bytes in the request body, id in the "x-id" header
#[tauri::command]
pub fn recv_chunk(request: tauri::ipc::Request) -> Result<(), String> {
    let id: u64 = request
        .headers()
        .get("x-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "missing id".to_string())?;
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(d) => d,
        _ => return Err("expected raw bytes".to_string()),
    };
    let mut map = recv_map().lock().map_err(|e| e.to_string())?;
    let rf = map.get_mut(&id).ok_or_else(|| "unknown id".to_string())?;
    rf.file.write_all(data).map_err(|e| e.to_string())
}

// Receiver step 3: flush buffered writes -> rename to the final unique name
#[tauri::command]
pub fn recv_end(id: String) -> Result<String, String> {
    let id: u64 = id.parse().map_err(|_| "bad id".to_string())?;
    let rf = recv_map()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or_else(|| "unknown id".to_string())?;
    let RecvFile { mut file, part, dir, name } = rf;
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    let dest = unique_dest_path(&dir, &name);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

// Cancel / disconnect: delete the half-written file
#[tauri::command]
pub fn recv_abort(id: String) {
    if let Ok(id) = id.parse::<u64>() {
        if let Ok(mut map) = recv_map().lock() {
            if let Some(rf) = map.remove(&id) {
                let RecvFile { file, part, .. } = rf;
                drop(file);
                let _ = std::fs::remove_file(part);
            }
        }
    }
}

// ---- native drag of one file out of the island (Desktop, Explorer, Discord, ...) ----
#[cfg(target_os = "windows")]
unsafe fn do_drag(path: &str) -> windows::core::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{IBindCtx, IDataObject};
    use windows::Win32::System::Ole::{OleInitialize, DROPEFFECT_COPY, IDropSource};
    use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop};

    let _ = OleInitialize(None);
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>)?;
    let data: IDataObject = item.BindToHandler(None::<&IBindCtx>, &BHID_DataObject)?;
    SHDoDragDrop(HWND::default(), &data, None::<&IDropSource>, DROPEFFECT_COPY).map(|_| ())
}

// Returns when the drag is finished (true = started fine)
#[tauri::command]
pub async fn drag_out_file(app: tauri::AppHandle, path: String) -> bool {
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        if app
            .run_on_main_thread(move || {
                let ok = unsafe { do_drag(&path).is_ok() };
                let _ = tx.send(ok);
            })
            .is_err()
        {
            return false;
        }
        return tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
            .await
            .unwrap_or(false);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, path);
        false
    }
}

// ---- tray staging: temp copy of a dropped file, so it can be dragged out again ----
fn stage_root() -> PathBuf {
    std::env::temp_dir().join("InexTray")
}

pub fn clean_stage() {
    let _ = std::fs::remove_dir_all(stage_root());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_name_sanitizes_and_falls_back() {
        assert_eq!(clean_name("..bad:/name?.txt"), "badname.txt");
        assert_eq!(clean_name("..."), "Inex_Shared_File.bin");
        assert_eq!(clean_name("a".repeat(200).as_str()).len(), 150);
    }

    #[test]
    fn unique_dest_appends_counter_on_collision() {
        let dir = std::env::temp_dir().join("inex_net_unique_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("report.pdf");
        std::fs::write(&first, b"1").unwrap();

        let next = unique_dest_path(&dir, "report.pdf");
        assert_eq!(next, dir.join("report (1).pdf"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn buffered_recv_roundtrip_and_abort() {
        let dir = std::env::temp_dir().join("inex_net_recv_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let id = recv_begin_in(dir.clone(), "hello.bin").unwrap();
        let uid: u64 = id.parse().unwrap();
        {
            let mut map = recv_map().lock().unwrap();
            map.get_mut(&uid).unwrap().file.write_all(b"abcdef").unwrap();
        }
        let saved = recv_end(id).unwrap();
        assert_eq!(std::fs::read(&saved).unwrap(), b"abcdef");

        let abort_id = recv_begin_in(dir.clone(), "cancel.bin").unwrap();
        recv_abort(abort_id);
        assert!(std::fs::read_dir(&dir).unwrap().count() == 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_block_reads_across_offsets_and_clears_cache_at_eof() {
        let tmp = std::env::temp_dir().join("inex_net_read_test.bin");
        std::fs::write(&tmp, b"0123456789").unwrap();
        let p = tmp.to_string_lossy().to_string();

        assert_eq!(read_block_sync(&p, 0, 4).unwrap(), b"0123");
        assert_eq!(read_block_sync(&p, 4, 10).unwrap(), b"456789");
        let _ = std::fs::remove_file(&tmp);
    }
}

