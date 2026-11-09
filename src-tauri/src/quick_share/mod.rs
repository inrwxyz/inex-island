pub mod ble;
pub mod client;
pub mod console;
pub mod crypto;
pub mod events;
pub mod mdns;
pub mod protos;
pub mod server;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use self::client::{QuickShareClient, SendItem};
use self::mdns::{DiscoveredDevice, MdnsAdvertiser};
use self::server::QuickShareServer;

pub struct QuickShareEngine {
    pub device_name: String,
    pub endpoint_id: [u8; 4],
    pub downloads_dir: PathBuf,
    pub running: AtomicBool,
    pub busy: AtomicBool,
    pub scan_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub server_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub staged_files: Mutex<Vec<String>>,
}

static ENGINE: OnceLock<Arc<QuickShareEngine>> = OnceLock::new();

pub fn get_engine() -> Arc<QuickShareEngine> {
    ENGINE
        .get_or_init(|| {
            let device_name = std::env::var("COMPUTERNAME")
                .unwrap_or_else(|_| "Inex Island PC".to_string());
            let mut ep = [0u8; 4];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut ep);
            let downloads_dir = std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join("Downloads"))
                .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Public\\Downloads"));
            Arc::new(QuickShareEngine {
                device_name,
                endpoint_id: ep,
                downloads_dir,
                running: AtomicBool::new(false),
                busy: AtomicBool::new(false),
                scan_stop: Mutex::new(None),
                server_stop: Mutex::new(None),
                staged_files: Mutex::new(Vec::new()),
            })
        })
        .clone()
}

fn status_json(eng: &QuickShareEngine) -> serde_json::Value {
    let ip = mdns::current_lan_ip();
    let is_scanning = eng.scan_stop.lock().map(|g| g.is_some()).unwrap_or(false);
    serde_json::json!({
        "running": eng.running.load(Ordering::SeqCst),
        "busy": eng.busy.load(Ordering::SeqCst),
        "device_name": eng.device_name,
        "device": eng.device_name,
        "ip": ip.to_string(),
        "save_dir": eng.downloads_dir.to_string_lossy(),
        "scanning": is_scanning,
        "connected": false,
    })
}

#[tauri::command]
pub async fn start_quick_share(app: AppHandle) -> Result<serde_json::Value, String> {
    let eng = get_engine();
    events::set_app_handle(app.clone());

    if eng.running.load(Ordering::SeqCst) {
        return Ok(status_json(&eng));
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut g) = eng.server_stop.lock() {
        *g = Some(stop_flag.clone());
    }

    let port: u16 = 52345;
    let ip = mdns::current_lan_ip();

    let adv = Arc::new(MdnsAdvertiser::new(
        eng.device_name.clone(),
        eng.endpoint_id,
        port,
        ip,
    ));
    let adv_stop = stop_flag.clone();
    tokio::spawn(async move {
        let _ = adv.start_with_stop(adv_stop).await;
    });

    let srv = QuickShareServer::new(port, eng.downloads_dir.clone());
    let srv_stop = stop_flag.clone();
    tokio::spawn(async move {
        let _ = srv.start_with_stop(srv_stop).await;
    });

    eng.running.store(true, Ordering::SeqCst);
    let val = status_json(&eng);

    let _ = app.emit(
        "quickshare-event",
        serde_json::json!({
            "type": "started",
            "name": eng.device_name,
            "ip": ip.to_string(),
            "save_dir": eng.downloads_dir.to_string_lossy(),
        }),
    );
    let _ = app.emit(
        "inexdrop-event",
        serde_json::json!({
            "type": "started",
            "running": true,
            "device": eng.device_name,
            "ip": ip.to_string(),
        }),
    );
    Ok(val)
}

#[tauri::command]
pub async fn stop_quick_share(app: AppHandle) -> Result<(), String> {
    let eng = get_engine();
    if let Ok(mut g) = eng.server_stop.lock() {
        if let Some(flag) = g.take() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    let _ = stop_quick_share_scan(app.clone());
    eng.running.store(false, Ordering::SeqCst);

    let _ = app.emit("quickshare-event", serde_json::json!({ "type": "stopped" }));
    let _ = app.emit("inexdrop-event", serde_json::json!({ "type": "stopped" }));
    Ok(())
}

#[tauri::command]
pub fn get_quick_share_status() -> serde_json::Value {
    let eng = get_engine();
    status_json(&eng)
}

#[tauri::command]
pub async fn start_quick_share_scan(app: AppHandle) -> Result<(), String> {
    let eng = get_engine();
    events::set_app_handle(app.clone());
    let already = eng.scan_stop.lock().map(|g| g.is_some()).unwrap_or(false);
    if !already {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut g) = eng.scan_stop.lock() {
            *g = Some(flag.clone());
        }
        let eng2 = eng.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app2.emit("quickshare-event", serde_json::json!({ "type": "scan_started" }));
            let ip = mdns::current_lan_ip();
            let _ = mdns::watch_devices(flag.clone(), ip, 52345, eng2.device_name.clone()).await;
            if let Ok(mut g) = eng2.scan_stop.lock() {
                if g.as_ref().map(|f| Arc::ptr_eq(f, &flag)).unwrap_or(false) {
                    *g = None;
                }
            }
            let _ = app2.emit("quickshare-event", serde_json::json!({ "type": "scan_stopped" }));
        });
    }
    Ok(())
}

#[tauri::command]
pub fn stop_quick_share_scan(_app: AppHandle) -> Result<(), String> {
    let eng = get_engine();
    if let Ok(mut g) = eng.scan_stop.lock() {
        if let Some(f) = g.take() {
            f.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn collect_folder_recursive(dir: &std::path::Path, rel_parent: &str, out: &mut Vec<SendItem>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                out.push(SendItem {
                    path: p,
                    parent_folder: rel_parent.to_string(),
                });
            } else if p.is_dir() {
                let sub = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("sub");
                let next_parent = format!("{}/{}", rel_parent, sub);
                collect_folder_recursive(&p, &next_parent, out);
            }
        }
    }
}

#[tauri::command]
pub async fn send_quick_share_files(
    app: AppHandle,
    name: String,
    ip: String,
    port: u16,
    dev_type: u8,
    instance: String,
    paths: Vec<String>,
) -> Result<bool, String> {
    let eng = get_engine();
    events::set_app_handle(app.clone());

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

    if eng.busy.swap(true, Ordering::SeqCst) {
        return Err("Another transfer is currently in progress".into());
    }

    let _ = stop_quick_share_scan(app.clone());

    let eng2 = eng.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut items: Vec<SendItem> = Vec::new();
        for p in paths {
            let pb = PathBuf::from(&p);
            if pb.is_file() {
                items.push(SendItem {
                    path: pb,
                    parent_folder: String::new(),
                });
            } else if pb.is_dir() {
                let root = pb
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("folder")
                    .to_string();
                collect_folder_recursive(&pb, &root, &mut items);
            }
        }

        if items.is_empty() {
            let _ = app2.emit(
                "quickshare-event",
                serde_json::json!({
                    "type": "error", "message": "No valid files found to send."
                }),
            );
            eng2.busy.store(false, Ordering::SeqCst);
            return;
        }

        let _ = app2.emit(
            "quickshare-event",
            serde_json::json!({
                "type": "send_started", "device": dev.name, "files": items.len()
            }),
        );
        let client = QuickShareClient::new(eng2.device_name.clone(), eng2.endpoint_id);
        if let Err(e) = client.send_files(&dev, &items).await {
            let _ = app2.emit(
                "quickshare-event",
                serde_json::json!({
                    "type": "error", "message": format!("{}", e)
                }),
            );
        }
        let _ = app2.emit(
            "quickshare-event",
            serde_json::json!({ "type": "send_finished" }),
        );
        eng2.busy.store(false, Ordering::SeqCst);
    });

    Ok(true)
}

#[tauri::command]
pub fn respond_quick_share_offer(accept: bool) {
    server::send_consent_decision(accept);
}

#[tauri::command]
pub fn control_quick_share(cmd: String) {
    if cmd == "p" || cmd == "r" || cmd == "c" {
        console::inject(&cmd);
    }
}

#[tauri::command]
pub fn open_quick_share_downloads() {
    let eng = get_engine();
    let _ = std::process::Command::new("explorer")
        .arg(&eng.downloads_dir)
        .spawn();
}

#[tauri::command]
pub async fn pick_quick_share_files() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Quick Share - Choose Files to Send")
            .pick_files()
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn pick_quick_share_folder() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Quick Share - Choose Folder to Send")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn stage_quick_share_files(paths: Vec<String>) -> usize {
    let eng = get_engine();
    let mut g = eng.staged_files.lock().unwrap();
    for p in paths {
        if !g.contains(&p) {
            g.push(p);
        }
    }
    g.len()
}

#[tauri::command]
pub fn get_staged_quick_share_files() -> Vec<String> {
    let eng = get_engine();
    let files = eng.staged_files.lock().unwrap().clone();
    files
}

#[tauri::command]
pub fn clear_staged_quick_share_files() {
    let eng = get_engine();
    eng.staged_files.lock().unwrap().clear();
}

// -------------------------------------------------------------------------------------
// Backward-compatibility Aliases for Inex Island legacy hooks
// -------------------------------------------------------------------------------------
#[tauri::command]
pub async fn start_inex_drop(app: AppHandle) -> Result<serde_json::Value, String> {
    start_quick_share(app).await
}

#[tauri::command]
pub async fn stop_inex_drop(app: AppHandle) -> Result<(), String> {
    stop_quick_share(app).await
}

#[tauri::command]
pub fn get_inex_drop_status() -> serde_json::Value {
    get_quick_share_status()
}

#[tauri::command]
pub fn stage_file_for_phone(path: String) -> usize {
    stage_quick_share_files(vec![path])
}

#[tauri::command]
pub fn clear_staged_files() {
    clear_staged_quick_share_files();
}

#[tauri::command]
pub fn respond_inex_transfer(_id: String, accept: bool) {
    respond_quick_share_offer(accept);
}
