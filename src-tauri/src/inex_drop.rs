// Inex Drop: Fast, offline, native local file transfer between Phone and PC (Wi-Fi / Hotspot).
// Uses pure standard library TCP/HTTP streaming with zero polling and zero external dependencies.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MOBILE_PAGE: &str = include_str!("../../src/mobile-drop.html");

#[derive(serde::Serialize, Clone)]
pub struct DropStatus {
    pub running: bool,
    pub connected: bool,
    pub url: String,
    pub ip: String,
    pub port: u16,
    pub pin: String,
    pub device: String,
    pub remaining: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TransferApproval {
    Pending,
    Accepted,
    Declined,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct PendingTransfer {
    pub id: String,
    pub name: String,
    pub size: usize,
    pub device: String,
    pub status: TransferApproval,
}

struct DropServerState {
    running: bool,
    connected: bool,
    ip: String,
    port: u16,
    pin: String,
    device: String,
    remaining: u32,
    staged_files: Vec<String>,
    peer_ip: String,   // the one device (IP) that connected; nobody else is served while it is connected
    bad_pins: u32,     // wrong-PIN requests since start
    pending_transfers: HashMap<String, PendingTransfer>,
}

static SERVER_STATE: OnceLock<Mutex<DropServerState>> = OnceLock::new();
static STOP_FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static COUNTDOWN: OnceLock<Arc<AtomicU32>> = OnceLock::new();

// Session key in the QR link. std-only randomness (RandomState is seeded by the OS), 12 chars, no look-alike letters.
fn random_pin() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    const CH: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out = String::new();
    let mut i: u64 = 0;
    while out.len() < 12 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(nanos);
        i += 1;
        out.push(CH[(h.finish() % CH.len() as u64) as usize] as char);
    }
    out
}

// Compare without stopping at the first different character
fn pin_matches(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// Never overwrite a file that is already in Downloads: "name.ext" -> "name (1).ext"
fn unique_path(dir: &PathBuf, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = std::path::Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 1..1000 {
        let cand = dir.join(format!("{} ({}){}", stem, n, ext));
        if !cand.exists() {
            return cand;
        }
    }
    first
}

fn get_state() -> &'static Mutex<DropServerState> {
    SERVER_STATE.get_or_init(|| {
        Mutex::new(DropServerState {
            running: false,
            connected: false,
            ip: String::new(),
            port: 52410,
            pin: String::new(),
            device: String::new(),
            remaining: 60,
            staged_files: Vec::new(),
            peer_ip: String::new(),
            bad_pins: 0,
            pending_transfers: HashMap::new(),
        })
    })
}

fn get_stop_flag() -> &'static Arc<AtomicBool> {
    STOP_FLAG.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

fn get_countdown() -> &'static Arc<AtomicU32> {
    COUNTDOWN.get_or_init(|| Arc::new(AtomicU32::new(60)))
}

fn downloads_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Downloads"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn get_local_ip() -> String {
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("192.168.0.1:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" && ip != "127.0.0.1" {
                    return ip;
                }
            }
        }
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" && ip != "127.0.0.1" {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

fn clean_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() {
        "Inex_Received_File.bin".to_string()
    } else {
        clean.chars().take(180).collect()
    }
}

fn handle_client(mut stream: TcpStream, app: &AppHandle, valid_pin: &str) {
    if get_stop_flag().load(Ordering::SeqCst) || !get_state().lock().unwrap().running {
        let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
    }

    // a connection that goes silent must not hang a worker thread forever
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(&stream);
    let mut req_line = String::new();
    if reader.read_line(&mut req_line).is_err() || req_line.is_empty() {
        return;
    }

    let parts: Vec<&str> = req_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }

    let method = parts[0];
    let path_and_query = parts[1];
    let (path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_and_query, ""),
    };

    let mut query_params = std::collections::HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            query_params.insert(k, v);
        }
    }

    // Read headers
    let mut content_length: usize = 0;
    loop {
        let mut header_line = String::new();
        if reader.read_line(&mut header_line).is_err() || header_line.trim().is_empty() {
            break;
        }
        let lower = header_line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            if let Some(val) = header_line.split(':').nth(1) {
                content_length = val.trim().parse().unwrap_or(0);
            }
        }
    }

    if get_stop_flag().load(Ordering::SeqCst) || !get_state().lock().unwrap().running {
        let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
    }

    let pin_ok = if valid_pin.is_empty() {
        true
    } else {
        query_params.get("pin").map(|&p| pin_matches(p, valid_pin)).unwrap_or(false)
    };

    // Every route except the page itself needs the session key, and (once a phone is connected) only that phone is served.
    if path != "/" {
        if !pin_ok {
            // only a WRONG key counts (browsers also ask for /favicon.ico without any key)
            let tried_a_key = query_params.contains_key("pin");
            if tried_a_key {
                thread::sleep(Duration::from_millis(300));   // slows guessing down
            }
            let too_many = tried_a_key && {
                let mut st = get_state().lock().unwrap();
                st.bad_pins += 1;
                st.bad_pins >= 8
            };
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            if too_many {
                let _ = stop_inex_drop_internal(app);   // too many wrong keys: shut the session down
            }
            return;
        }
        let peer_ip = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
        let allowed = {
            let st = get_state().lock().unwrap();
            st.peer_ip.is_empty() || st.peer_ip == peer_ip
        };
        if !allowed {
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            return;
        }
    }

    match (method, path) {
        ("GET", "/") => {
            let res = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{}",
                MOBILE_PAGE.len(),
                MOBILE_PAGE
            );
            let _ = stream.write_all(res.as_bytes());
        }
        ("POST", "/register") => {
            if !pin_ok {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            let mut body = vec![0u8; content_length.min(1024)];
            let _ = reader.read_exact(&mut body);
            let dev_name = if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
                json.get("device").and_then(|v| v.as_str()).unwrap_or("Mobile Device").to_string()
            } else {
                "Mobile Device".to_string()
            };

            let ip = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();

            {
                let mut state = get_state().lock().unwrap();
                state.connected = true;
                state.device = dev_name.clone();
                state.peer_ip = ip.clone();
            }

            let _ = app.emit("inexdrop-event", serde_json::json!({
                "type": "connected",
                "device": dev_name,
                "ip": ip
            }));

            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}");
        }
        ("POST", "/request_transfer") => {
            if !pin_ok {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            let mut body = vec![0u8; content_length.min(65536)];
            let _ = reader.read_exact(&mut body);

            // One approval covers the whole batch: phone sends { files: [{name,size}, ...] }.
            // Old single-file shape { name, size } still works.
            let mut names: Vec<String> = Vec::new();
            let mut total_size: usize = 0;
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
                if let Some(arr) = json.get("files").and_then(|v| v.as_array()) {
                    for f in arr {
                        let n = f.get("name").and_then(|v| v.as_str()).unwrap_or("received_file");
                        let sz = f.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        names.push(clean_filename(n));
                        total_size += sz;
                    }
                } else {
                    let n = json.get("name").and_then(|v| v.as_str()).unwrap_or("received_file");
                    names.push(clean_filename(n));
                    total_size = json.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                }
            }
            if names.is_empty() {
                names.push("received_file".to_string());
            }
            let file_count = names.len();
            let clean_name = names[0].clone();
            let file_size = total_size;

            let transfer_id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
            let dev_name = {
                let st = get_state().lock().unwrap();
                if st.device.is_empty() { "Phone".to_string() } else { st.device.clone() }
            };

            {
                let mut state = get_state().lock().unwrap();
                state.pending_transfers.insert(transfer_id.clone(), PendingTransfer {
                    id: transfer_id.clone(),
                    name: clean_name.clone(),
                    size: file_size,
                    device: dev_name.clone(),
                    status: TransferApproval::Pending,
                });
            }

            let _ = app.emit("inexdrop-event", serde_json::json!({
                "type": "transfer_prompt",
                "id": transfer_id,
                "name": clean_name,
                "names": names,
                "count": file_count,
                "size": file_size,
                "device": dev_name
            }));

            let resp = serde_json::json!({
                "ok": true,
                "id": transfer_id,
                "status": "pending"
            }).to_string();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                resp.len(),
                resp
            );
            let _ = stream.write_all(header.as_bytes());
        }
        ("GET", "/check_transfer") => {
            if !pin_ok {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            let transfer_id = query_params.get("id").copied().unwrap_or("");
            let status = {
                let state = get_state().lock().unwrap();
                state.pending_transfers.get(transfer_id).map(|t| match t.status {
                    TransferApproval::Pending => "pending",
                    TransferApproval::Accepted => "accepted",
                    TransferApproval::Declined => "declined",
                }).unwrap_or("unknown")
            };
            let resp = serde_json::json!({ "status": status }).to_string();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                resp.len(),
                resp
            );
            let _ = stream.write_all(header.as_bytes());
        }
        ("POST", "/upload") => {
            if !pin_ok {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }

            let transfer_id = query_params.get("id").copied().unwrap_or("");
            let is_approved = if transfer_id.is_empty() {
                true // fallback for legacy direct uploads
            } else {
                let state = get_state().lock().unwrap();
                state.pending_transfers.get(transfer_id).map(|t| t.status == TransferApproval::Accepted).unwrap_or(false)
            };

            if !is_approved {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nTransfer not accepted by PC");
                return;
            }

            let raw_name = query_params.get("name").copied().unwrap_or("received_file");
            let decoded_name = urlencoding_decode(raw_name);
            let name = clean_filename(&decoded_name);
            let save_path = unique_path(&downloads_dir(), &name);

            let _ = app.emit("inexdrop-event", serde_json::json!({
                "type": "upload_start",
                "name": name,
                "size": content_length
            }));

            if let Ok(raw_file) = File::create(&save_path) {
                let _ = stream.set_nodelay(true);
                let mut out_file = BufWriter::with_capacity(512 * 1024, raw_file);
                let mut buf = vec![0u8; 512 * 1024];
                let mut received: usize = 0;
                let transfer_start = std::time::Instant::now();
                let mut last_emit_time = std::time::Instant::now();
                let mut last_speed_time = std::time::Instant::now();
                let mut last_speed_bytes: usize = 0;
                let mut current_speed = String::from("0 MB/s");

                while received < content_length {
                    if get_stop_flag().load(Ordering::SeqCst) || !get_state().lock().unwrap().running {
                        let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
                        let _ = app.emit("inexdrop-event", serde_json::json!({
                            "type": "upload_cancelled",
                            "name": name
                        }));
                        drop(out_file);
                        let _ = std::fs::remove_file(&save_path);
                        return;
                    }

                    let to_read = (content_length - received).min(buf.len());
                    match reader.read(&mut buf[..to_read]) {
                        Ok(0) => break,
                        Ok(n) => {
                            if out_file.write_all(&buf[..n]).is_err() {
                                break;
                            }
                            received += n;

                            let elapsed_ms = last_speed_time.elapsed().as_millis();
                            if elapsed_ms >= 180 {
                                let elapsed_sec = (elapsed_ms as f64) / 1000.0;
                                let bytes_diff = received.saturating_sub(last_speed_bytes);
                                let mb_s = (bytes_diff as f64) / (1024.0 * 1024.0 * elapsed_sec);
                                current_speed = format!("{:.1} MB/s", mb_s);
                                last_speed_time = std::time::Instant::now();
                                last_speed_bytes = received;
                            }

                            let pct = if content_length > 0 { (received * 100) / content_length } else { 100 };
                            // High performance throttled IPC emission
                            if last_emit_time.elapsed().as_millis() >= 150 || pct == 100 {
                                last_emit_time = std::time::Instant::now();
                                let _ = app.emit("inexdrop-event", serde_json::json!({
                                    "type": "progress",
                                    "pct": pct,
                                    "speed": current_speed,
                                    "name": name,
                                    "bytes": received,
                                    "total": content_length
                                }));
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = out_file.flush();

                let total_elapsed = transfer_start.elapsed().as_secs_f64();
                let avg_speed = if total_elapsed > 0.05 {
                    format!("{:.1} MB/s", (received as f64) / (1024.0 * 1024.0 * total_elapsed))
                } else {
                    format!("{:.1} MB/s", (received as f64) / (1024.0 * 1024.0))
                };

                let _ = app.emit("inexdrop-event", serde_json::json!({
                    "type": "upload_done",
                    "name": name,
                    "path": save_path.to_string_lossy().to_string(),
                    "size": received,
                    "speed": avg_speed
                }));

                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}");
            } else {
                let _ = stream.write_all(b"HTTP/1.1 500 Internal Error\r\nConnection: close\r\n\r\n");
            }
        }
        ("GET", "/files") => {
            if !pin_ok {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            let files_json = {
                let state = get_state().lock().unwrap();
                let items: Vec<serde_json::Value> = state.staged_files.iter().filter_map(|p| {
                    let pb = PathBuf::from(p);
                    let name = pb.file_name()?.to_string_lossy().to_string();
                    let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                    Some(serde_json::json!({ "name": name, "size": size }))
                }).collect();
                serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
            };

            let res = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                files_json.len(),
                files_json
            );
            let _ = stream.write_all(res.as_bytes());
        }
        ("GET", p) if p.starts_with("/download/") => {
            if !pin_ok {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            let file_name = urlencoding_decode(&p["/download/".len()..]);
            let state = get_state().lock().unwrap();
            let matched_path = state.staged_files.iter().find(|sf| {
                PathBuf::from(sf).file_name().map(|n| n.to_string_lossy() == file_name).unwrap_or(false)
            }).cloned();
            drop(state);

            if let Some(path_str) = matched_path {
                if let Ok(mut f) = File::open(&path_str) {
                    let meta = f.metadata().ok();
                    let file_size = meta.map(|m| m.len()).unwrap_or(0);
                    let ext = std::path::Path::new(&file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    let mime = match ext.as_str() {
                        "mp4" => "video/mp4",
                        "mkv" => "video/x-matroska",
                        "mov" => "video/quicktime",
                        "webm" => "video/webm",
                        "avi" => "video/x-msvideo",
                        "mp3" => "audio/mpeg",
                        "wav" => "audio/wav",
                        "flac" => "audio/flac",
                        "aac" => "audio/aac",
                        "m4a" => "audio/mp4",
                        "jpg" | "jpeg" => "image/jpeg",
                        "png" => "image/png",
                        "webp" => "image/webp",
                        "gif" => "image/gif",
                        "pdf" => "application/pdf",
                        "zip" => "application/zip",
                        _ => "application/octet-stream",
                    };
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                        mime,
                        clean_filename(&file_name),
                        file_size
                    );
                    let mut started = false;
                    let mut sent: u64 = 0;
                    if stream.write_all(header.as_bytes()).is_ok() {
                        started = true;
                        let _ = stream.set_nodelay(true);
                        let _ = app.emit("inexdrop-event", serde_json::json!({
                            "type": "download_start",
                            "name": file_name,
                            "size": file_size
                        }));
                        let mut buf = [0u8; 256 * 1024];
                        let mut last_emit = std::time::Instant::now();
                        let mut last_speed_time = std::time::Instant::now();
                        let mut last_speed_bytes: u64 = 0;
                        let mut speed = String::from("0 MB/s");
                        while let Ok(n) = f.read(&mut buf) {
                            if n == 0 || get_stop_flag().load(Ordering::SeqCst) { break; }
                            if stream.write_all(&buf[..n]).is_err() { break; }
                            sent += n as u64;

                            let ms = last_speed_time.elapsed().as_millis();
                            if ms >= 180 {
                                let secs = (ms as f64) / 1000.0;
                                let diff = sent.saturating_sub(last_speed_bytes);
                                speed = format!("{:.1} MB/s", (diff as f64) / (1024.0 * 1024.0 * secs));
                                last_speed_time = std::time::Instant::now();
                                last_speed_bytes = sent;
                            }
                            if last_emit.elapsed().as_millis() >= 150 {
                                last_emit = std::time::Instant::now();
                                let pct = if file_size > 0 { (sent * 100) / file_size } else { 100 };
                                let _ = app.emit("inexdrop-event", serde_json::json!({
                                    "type": "download_progress",
                                    "pct": pct,
                                    "speed": speed,
                                    "name": file_name
                                }));
                            }
                        }
                    }
                    let completed = started && sent >= file_size;
                    if completed {
                        // Remove from staged_files after a finished download so it EXPIRES!
                        {
                            let mut state = get_state().lock().unwrap();
                            state.staged_files.retain(|sf| {
                                PathBuf::from(sf).file_name().map(|n| n.to_string_lossy() != file_name).unwrap_or(true)
                            });
                        }
                        let _ = app.emit("inexdrop-event", serde_json::json!({
                            "type": "pushed_file_downloaded",
                            "name": file_name
                        }));
                    } else if started {
                        // phone cancelled / connection dropped: keep it staged so it can be tried again
                        let _ = app.emit("inexdrop-event", serde_json::json!({
                            "type": "download_cancelled",
                            "name": file_name
                        }));
                    }
                    return;
                }
            }
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        }
        ("POST", "/disconnect") => {
            {
                let mut state = get_state().lock().unwrap();
                state.connected = false;
                state.device.clear();
                state.peer_ip.clear();
            }
            let _ = app.emit("inexdrop-event", serde_json::json!({ "type": "disconnected" }));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
        }
        _ => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        }
    }
}

fn urlencoding_decode(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(b) = u8::from_str_radix(&hex, 16) {
                out.push(b as char);
            }
        } else if c == '+' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

#[tauri::command]
pub fn start_inex_drop(app: AppHandle) -> Result<DropStatus, String> {
    let mut state = get_state().lock().unwrap();
    if state.running {
        let url = format!("http://{}:{}/?pin={}", state.ip, state.port, state.pin);
        return Ok(DropStatus {
            running: true,
            connected: state.connected,
            url,
            ip: state.ip.clone(),
            port: state.port,
            pin: state.pin.clone(),
            device: state.device.clone(),
            remaining: state.remaining,
        });
    }

    let ip = get_local_ip();
    let port = 52410;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let _ = now;
    let pin: String = random_pin();

    let listener = match TcpListener::bind(format!("0.0.0.0:{}", port)) {
        Ok(l) => l,
        Err(_) => {
            TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?
        }
    };

    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    let stop_flag = get_stop_flag();
    stop_flag.store(false, Ordering::SeqCst);

    let countdown = get_countdown();
    countdown.store(60, Ordering::SeqCst);

    state.running = true;
    state.connected = false;
    state.ip = ip.clone();
    state.port = actual_port;
    state.pin = pin.clone();
    state.device.clear();
    state.peer_ip.clear();
    state.bad_pins = 0;
    state.remaining = 60;

    let url = format!("http://{}:{}/?pin={}", ip, actual_port, pin);

    let app_handle = app.clone();
    let pin_clone = pin.clone();
    let stop_clone = stop_flag.clone();

    // 1. Worker thread for incoming HTTP requests
    thread::spawn(move || {
        listener.set_nonblocking(false).ok();
        while !stop_clone.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app_h = app_handle.clone();
                    let p = pin_clone.clone();
                    thread::spawn(move || {
                        handle_client(stream, &app_h, &p);
                    });
                }
                Err(_) => {
                    if stop_clone.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });

    // 2. Countdown timer thread (60 seconds auto-timeout if not connected)
    let app_h2 = app.clone();
    let stop_clone2 = stop_flag.clone();
    let cd_clone = countdown.clone();
    thread::spawn(move || {
        while !stop_clone2.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_secs(1));
            if stop_clone2.load(Ordering::SeqCst) {
                break;
            }

            let is_conn = {
                let st = get_state().lock().unwrap();
                st.connected
            };

            if is_conn {
                continue;
            }

            let rem = cd_clone.fetch_sub(1, Ordering::SeqCst);
            if rem <= 1 {
                let _ = app_h2.emit("inexdrop-event", serde_json::json!({ "type": "timeout" }));
                let _ = stop_inex_drop_internal(&app_h2);
                break;
            } else {
                let cur = rem - 1;
                {
                    if let Ok(mut st) = get_state().lock() {
                        st.remaining = cur;
                    }
                }
                let _ = app_h2.emit("inexdrop-event", serde_json::json!({ "type": "tick", "remaining": cur }));
            }
        }
    });

    Ok(DropStatus {
        running: true,
        connected: false,
        url,
        ip,
        port: actual_port,
        pin,
        device: String::new(),
        remaining: 60,
    })
}

fn stop_inex_drop_internal(app: &AppHandle) -> Result<(), String> {
    let stop_flag = get_stop_flag();
    stop_flag.store(true, Ordering::SeqCst);

    let port = {
        let mut state = get_state().lock().unwrap();
        if !state.running {
            return Ok(());
        }
        state.running = false;
        state.connected = false;
        state.device.clear();
        state.remaining = 60;
        state.staged_files.clear();
        state.pending_transfers.clear();
        state.peer_ip.clear();
        state.bad_pins = 0;
        state.port
    };

    let _ = TcpStream::connect(format!("127.0.0.1:{}", port));

    let _ = app.emit("inexdrop-event", serde_json::json!({ "type": "stopped" }));
    Ok(())
}

#[tauri::command]
pub fn respond_inex_transfer(id: String, accept: bool) -> bool {
    let mut state = get_state().lock().unwrap();
    if let Some(t) = state.pending_transfers.get_mut(&id) {
        t.status = if accept {
            TransferApproval::Accepted
        } else {
            TransferApproval::Declined
        };
        return true;
    }
    false
}

#[tauri::command]
pub fn stop_inex_drop(app: AppHandle) -> Result<(), String> {
    stop_inex_drop_internal(&app)
}

#[tauri::command]
pub fn get_inex_drop_status() -> DropStatus {
    let state = get_state().lock().unwrap();
    let url = if state.running {
        format!("http://{}:{}/?pin={}", state.ip, state.port, state.pin)
    } else {
        String::new()
    };
    DropStatus {
        running: state.running,
        connected: state.connected,
        url,
        ip: state.ip.clone(),
        port: state.port,
        pin: state.pin.clone(),
        device: state.device.clone(),
        remaining: state.remaining,
    }
}

// Each staging gets a generation number, so a file that is staged again later is not removed
// by the 60 s expiry timer of an older staging.
static STAGE_GEN: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[tauri::command]
pub fn stage_file_for_phone(path: String) -> Result<bool, String> {
    let stamp = {
        let mut gens = STAGE_GEN.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
        let g = gens.get(&path).copied().unwrap_or(0) + 1;
        gens.insert(path.clone(), g);
        g
    };
    {
        let mut state = get_state().lock().unwrap();
        if !state.staged_files.contains(&path) {
            state.staged_files.push(path.clone());
        }
    }
    // Auto-expire staged file on PC after 60 seconds (1 minute expiry)
    let p_clone = path;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let latest = STAGE_GEN
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .get(&p_clone)
            .copied()
            .unwrap_or(0);
        if latest != stamp {
            return; // staged again since, a newer timer owns it
        }
        let mut state = get_state().lock().unwrap();
        state.staged_files.retain(|f| f != &p_clone);
    });
    Ok(true)
}

#[tauri::command]
pub fn clear_staged_files() -> bool {
    let mut state = get_state().lock().unwrap();
    state.staged_files.clear();
    true
}
