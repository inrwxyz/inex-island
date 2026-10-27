// P2P file I/O and Native Drag-Drop Helpers (Windows).

// ======================================================================================
// P2P file I/O: real file paths (no copy), raw bytes over IPC (no base64), streamed to disk.
// Also: native drag-out of a file from the tray, and detection of Windows password prompts.
// ======================================================================================
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

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

// Sender: read one block of a file (returned to JS as an ArrayBuffer)
#[tauri::command]
pub async fn read_file_chunk(path: String, offset: u64, len: u32) -> Result<tauri::ipc::Response, String> {
    let want = (len as usize).min(8 * 1024 * 1024);
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
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
    buf.truncate(filled);
    Ok(tauri::ipc::Response::new(buf))
}

struct RecvFile {
    file: File,
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

fn clean_name(n: &str) -> String {
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

// Receiver step 1: open "<name>.inexpartN" in Downloads, returns an id
#[tauri::command]
pub fn recv_begin(file_name: String) -> Result<String, String> {
    let name = clean_name(&file_name);
    let dir = downloads_dir();
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let part = dir.join(format!("{}.inexpart{}", name, id));
    let file = File::create(&part).map_err(|e| e.to_string())?;
    recv_map()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, RecvFile { file, part, dir, name });
    Ok(id.to_string())
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

// Receiver step 3: finish -> rename to the final name (adds " (1)", " (2)" if it already exists)
#[tauri::command]
pub fn recv_end(id: String) -> Result<String, String> {
    let id: u64 = id.parse().map_err(|_| "bad id".to_string())?;
    let rf = recv_map()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or_else(|| "unknown id".to_string())?;
    let RecvFile { mut file, part, dir, name } = rf;
    let _ = file.flush();
    drop(file);

    let p = std::path::Path::new(&name);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    let mut dest = dir.join(&name);
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("{} ({}){}", stem, n, ext));
        n += 1;
    }
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

// Is a Windows password / PIN / credential prompt in front? ("password" or "")
#[tauri::command]
pub async fn native_prompt() -> String {
    #[cfg(target_os = "windows")]
    {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::{CloseHandle, HWND};
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId};
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == HWND::default() {
                return String::new();
            }
            let mut class_buf = [0u16; 128];
            let cn = GetClassNameW(hwnd, &mut class_buf);
            let class = String::from_utf16_lossy(&class_buf[..cn.max(0) as usize]).to_lowercase();

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut exe = String::new();
            if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 520];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                }
                let _ = CloseHandle(h);
            }
            let is_prompt = exe.ends_with("credentialuibroker.exe")
                || exe.ends_with("credwiz.exe")
                || exe.ends_with("consent.exe")
                || class.contains("credential dialog");
            return if is_prompt { "password".to_string() } else { String::new() };
        }
    }
    #[cfg(not(target_os = "windows"))]
    String::new()
}

// ---- tray staging: temp copy of a dropped file, so it can be dragged out again ----
fn stage_root() -> PathBuf {
    std::env::temp_dir().join("InexTray")
}

pub fn clean_stage() {
    let _ = std::fs::remove_dir_all(stage_root());
}

#[tauri::command]
pub fn stage_begin(file_name: String) -> Result<String, String> {
    let name = clean_name(&file_name);
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let dir = stage_root().join(id.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(&name);
    let file = File::create(&part).map_err(|e| e.to_string())?;
    recv_map()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, RecvFile { file, part, dir, name });
    Ok(id.to_string())
}

#[tauri::command]
pub fn stage_end(id: String) -> Result<String, String> {
    let id: u64 = id.parse().map_err(|_| "bad id".to_string())?;
    let rf = recv_map()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or_else(|| "unknown id".to_string())?;
    let RecvFile { mut file, part, .. } = rf;
    let _ = file.flush();
    drop(file);
    Ok(part.to_string_lossy().to_string())
}
