pub mod ble;
pub mod client;
pub mod console;
pub mod crypto;
pub mod engine;
pub mod events;
pub mod mdns;
pub mod protos;
pub mod server;

pub use client::{QuickShareClient, SendItem};
pub use engine::{get_engine, QuickShareEngine};
pub use mdns::{DiscoveredDevice, MdnsAdvertiser};
pub use server::QuickShareServer;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(windows)]
pub fn ensure_firewall() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if let Ok(exe) = std::env::current_exe() {
        let exe_str = exe.to_string_lossy().to_string();
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "add", "rule", "name=InexIsland QuickShare", "dir=in", "action=allow", &format!("program={}", exe_str), "enable=yes", "profile=any"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "add", "rule", "name=InexIsland QuickShare Port 52345", "dir=in", "action=allow", "protocol=TCP", "localport=52345", "enable=yes", "profile=any"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "add", "rule", "name=InexIsland QuickShare Port 5353", "dir=in", "action=allow", "protocol=UDP", "localport=5353", "enable=yes", "profile=any"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}

// -----------------------------------------------------------------------------
// Core Tauri Commands (Matching wquickshare)
// -----------------------------------------------------------------------------

#[tauri::command]
pub fn get_status() -> serde_json::Value {
    let eng = get_engine();
    let mut st = eng.status();
    if let Some(obj) = st.as_object_mut() {
        obj.insert("port".to_string(), serde_json::json!(52345));
    }
    st
}

#[tauri::command]
pub async fn start_server() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    ensure_firewall();
    let eng = get_engine();
    eng.start_server(52345).await
}

#[tauri::command]
pub async fn stop_server() -> Result<(), String> {
    let eng = get_engine();
    eng.stop_server().await
}

#[tauri::command]
pub async fn start_scan() -> Result<(), String> {
    let eng = get_engine();
    eng.start_scan().await
}

#[tauri::command]
pub fn stop_scan() -> Result<(), String> {
    let eng = get_engine();
    eng.stop_scan();
    Ok(())
}

#[tauri::command]
pub fn respond_offer(accept: bool) {
    QuickShareEngine::respond_offer(accept);
}

#[tauri::command]
pub fn control_transfer(cmd: String) {
    if cmd == "p" || cmd == "r" || cmd == "c" {
        console::inject(&cmd);
    }
}

#[tauri::command]
pub async fn pick_files(window: tauri::WebviewWindow) -> Vec<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("pick-files".into())
        .spawn(move || {
            let res = rfd::FileDialog::new()
                .set_title("Quick Share - Choose Files to Send")
                .set_parent(&window)
                .pick_files()
                .map(|paths| {
                    paths
                        .into_iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let _ = tx.send(res);
        })
        .ok();
    rx.await.unwrap_or_default()
}

#[tauri::command]
pub async fn pick_folder(window: tauri::WebviewWindow) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("pick-folder".into())
        .spawn(move || {
            let res = rfd::FileDialog::new()
                .set_title("Quick Share - Choose Folder to Send")
                .set_parent(&window)
                .pick_folder()
                .map(|p| p.to_string_lossy().to_string());
            let _ = tx.send(res);
        })
        .ok();
    rx.await.unwrap_or_default()
}

#[tauri::command]
pub async fn send_files(
    name: String,
    ip: String,
    port: u16,
    dev_type: u8,
    instance: String,
    paths: Vec<String>,
) -> Result<bool, String> {
    let eng = get_engine();
    let parsed_ip: Ipv4Addr = match ip.parse() {
        Ok(i) => i,
        Err(_) => return Err("Invalid IP address".into()),
    };
    if parsed_ip.is_unspecified() || port == 0 || paths.is_empty() {
        return Err("Missing target or paths".into());
    }

    let dev = DiscoveredDevice {
        name,
        ip: parsed_ip,
        port,
        device_type: dev_type,
        instance,
    };

    let pb_paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    eng.send_files(dev, pb_paths).await
}

#[tauri::command]
pub fn open_downloads() {
    let eng = get_engine();
    let dir = eng.get_downloads_dir();
    let _ = std::process::Command::new("explorer").arg(dir).spawn();
}

#[tauri::command]
pub fn set_quick_share_save_dir(path: String) -> bool {
    let p = PathBuf::from(&path);
    if p.exists() || std::fs::create_dir_all(&p).is_ok() {
        let eng = get_engine();
        eng.set_downloads_dir(p);
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn get_quick_share_save_dir() -> String {
    let eng = get_engine();
    eng.get_downloads_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub async fn choose_quick_share_save_dir(window: tauri::WebviewWindow) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("pick-save-dir".into())
        .spawn(move || {
            let res = rfd::FileDialog::new()
                .set_title("Quick Share - Choose Download Folder")
                .set_parent(&window)
                .pick_folder()
                .map(|p| p.to_string_lossy().to_string());
            let _ = tx.send(res);
        })
        .ok();
    let picked = rx.await.unwrap_or_default();
    if let Some(ref path_str) = picked {
        let p = PathBuf::from(path_str);
        let eng = get_engine();
        eng.set_downloads_dir(p);
    }
    picked
}

// -----------------------------------------------------------------------------
// Inex Island Compatibility Commands
// -----------------------------------------------------------------------------

#[tauri::command]
pub fn get_quick_share_status() -> serde_json::Value {
    get_status()
}

#[tauri::command]
pub async fn start_quick_share() -> Result<serde_json::Value, String> {
    start_server().await
}

#[tauri::command]
pub async fn stop_quick_share() -> Result<(), String> {
    stop_server().await
}

#[tauri::command]
pub async fn start_quick_share_scan() -> Result<(), String> {
    start_scan().await
}

#[tauri::command]
pub fn stop_quick_share_scan() -> Result<(), String> {
    stop_scan()
}

#[tauri::command]
pub async fn send_quick_share_files(
    name: String,
    ip: String,
    port: u16,
    dev_type: u8,
    instance: String,
    paths: Vec<String>,
) -> Result<bool, String> {
    send_files(name, ip, port, dev_type, instance, paths).await
}

#[tauri::command]
pub fn respond_quick_share_offer(accept: bool) {
    respond_offer(accept);
}

#[tauri::command]
pub fn control_quick_share(cmd: String) {
    control_transfer(cmd);
}

#[tauri::command]
pub fn open_quick_share_downloads() {
    open_downloads();
}

#[tauri::command]
pub async fn pick_quick_share_files(window: tauri::WebviewWindow) -> Vec<String> {
    pick_files(window).await
}

#[tauri::command]
pub async fn pick_quick_share_folder(window: tauri::WebviewWindow) -> Option<String> {
    pick_folder(window).await
}

// Staged files for drag-and-drop
static STAGED_FILES: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[tauri::command]
pub fn stage_quick_share_files(paths: Vec<String>) -> usize {
    let mut g = STAGED_FILES.lock().unwrap();
    for p in paths {
        if !g.contains(&p) {
            g.push(p);
        }
    }
    g.len()
}

#[tauri::command]
pub fn get_staged_quick_share_files() -> Vec<String> {
    STAGED_FILES.lock().unwrap().clone()
}

#[tauri::command]
pub fn clear_staged_quick_share_files() {
    STAGED_FILES.lock().unwrap().clear();
}

// Legacy Inex Drop Aliases
#[tauri::command]
pub async fn start_inex_drop() -> Result<serde_json::Value, String> {
    start_server().await
}

#[tauri::command]
pub async fn stop_inex_drop() -> Result<(), String> {
    stop_server().await
}

#[tauri::command]
pub fn get_inex_drop_status() -> serde_json::Value {
    get_status()
}

#[tauri::command]
pub fn respond_inex_transfer(_id: String, accept: bool) {
    respond_offer(accept);
}

#[tauri::command]
pub fn stage_file_for_phone(path: String) -> usize {
    stage_quick_share_files(vec![path])
}

#[tauri::command]
pub fn clear_staged_files() {
    clear_staged_quick_share_files();
}
