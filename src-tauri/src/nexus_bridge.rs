use tauri::{AppHandle, Emitter};

// Named pipe `\\.\pipe\InexIslandNexus`: Nexus Assistant -> Island
// Passive receiver: Nexus pushes voice lifecycle events ("wake", "thinking", "done", "cancel").
// Zero polling: uses Overlapped NamedPipe I/O with WaitForSingleObject.
//
// Hardening:
//  * first instance created with FILE_FLAG_FIRST_PIPE_INSTANCE (prevents squatting)
//  * PIPE_ACCESS_INBOUND (island only reads, cannot write) + PIPE_REJECT_REMOTE_CLIENTS
//  * immediate instance recreation on connection (no dropped event window)
//  * readers use FILE_FLAG_OVERLAPPED + WaitForSingleObject with a 2s deadline
//  * forwards valid JSON lines as the "nexus-voice" Tauri event to WebView

#[cfg(target_os = "windows")]
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("InexNexusBridge".to_string())
        .spawn(move || run(app))
        .expect("Failed to spawn InexNexusBridge thread");
}

#[cfg(target_os = "windows")]
unsafe fn read_overlapped_line(
    handle: windows::Win32::Foundation::HANDLE,
    max_bytes: usize,
    deadline_ms: u64,
) -> Vec<u8> {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_IO_PENDING, WAIT_OBJECT_0};
    use windows::Win32::Storage::FileSystem::ReadFile;
    use windows::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    let Ok(ev) = CreateEventW(None, true, false, None) else {
        return Vec::new();
    };
    let mut data: Vec<u8> = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(deadline_ms);
    let mut chunk = [0u8; 1024];

    while data.len() < max_bytes {
        let Some(rem) = deadline.checked_duration_since(std::time::Instant::now()) else {
            break;
        };
        let _ = ResetEvent(ev);
        let mut ov = OVERLAPPED { hEvent: ev, ..Default::default() };
        let mut n = 0u32;
        if ReadFile(handle, Some(&mut chunk), Some(&mut n), Some(&mut ov)).is_err() {
            if GetLastError() != ERROR_IO_PENDING {
                break;
            }
            if WaitForSingleObject(ev, rem.as_millis().max(1) as u32) != WAIT_OBJECT_0 {
                let _ = CancelIoEx(handle, Some(&ov));
                break;
            }
            if GetOverlappedResult(handle, &ov, &mut n, false).is_err() {
                break;
            }
        }
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n as usize]);
        if data.ends_with(b"\n") {
            break;
        }
    }

    let _ = CloseHandle(ev);
    data
}

#[cfg(target_os = "windows")]
fn run(app: AppHandle) {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows::core::w;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows::Win32::Storage::FileSystem::{FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_OVERLAPPED};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
    use windows::Win32::System::IO::OVERLAPPED;

    const PIPE_ACCESS_INBOUND: u32 = 0x0000_0001;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const MAX_MESSAGE_BYTES: usize = 4096;
    const MAX_LINE_BYTES: usize = 2048;
    const MAX_HANDLERS: usize = 16;
    const READ_DEADLINE_MS: u64 = 2000;

    let pipe_name = w!(r"\\.\pipe\InexIslandNexus");
    let active = Arc::new(AtomicUsize::new(0));
    let mut first_instance = true;

    loop {
        unsafe {
            let mut open_mode = PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED.0;
            if first_instance {
                open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
            }
            let handle = CreateNamedPipeW(
                pipe_name,
                FILE_FLAGS_AND_ATTRIBUTES(open_mode),
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                2048,
                2048,
                0,
                None,
            );

            if handle == INVALID_HANDLE_VALUE {
                std::thread::sleep(Duration::from_millis(if first_instance { 2000 } else { 500 }));
                continue;
            }
            first_instance = false;

            let Ok(conn_ev) = CreateEventW(None, true, false, None) else {
                let _ = CloseHandle(handle);
                continue;
            };
            let mut ov = OVERLAPPED { hEvent: conn_ev, ..Default::default() };
            let mut connected = ConnectNamedPipe(handle, Some(&mut ov)).is_ok();
            if !connected {
                let err = GetLastError();
                if err == ERROR_PIPE_CONNECTED {
                    connected = true;
                } else if err == ERROR_IO_PENDING {
                    connected = WaitForSingleObject(conn_ev, INFINITE) == WAIT_OBJECT_0;
                }
            }
            let _ = CloseHandle(conn_ev);

            if !connected {
                let _ = CloseHandle(handle);
                continue;
            }

            if active.load(Ordering::SeqCst) >= MAX_HANDLERS {
                let _ = DisconnectNamedPipe(handle);
                let _ = CloseHandle(handle);
                continue;
            }

            let raw = handle.0 as isize;
            let app2 = app.clone();
            let active2 = active.clone();
            active.fetch_add(1, Ordering::SeqCst);

            std::thread::spawn(move || {
                let handle = HANDLE(raw as *mut c_void);
                let data = read_overlapped_line(handle, MAX_MESSAGE_BYTES, READ_DEADLINE_MS);

                if let Ok(text) = std::str::from_utf8(&data) {
                    for line in text.split('\n') {
                        let clean = line.trim();
                        if clean.is_empty() || clean.len() > MAX_LINE_BYTES || !clean.starts_with('{') {
                            continue;
                        }
                        let _ = app2.emit("nexus-voice", clean);
                    }
                }

                let _ = DisconnectNamedPipe(handle);
                let _ = CloseHandle(handle);
                active2.fetch_sub(1, Ordering::SeqCst);
            });
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn start(_app: AppHandle) {}
