use tauri::{AppHandle, Emitter};

// Named pipe `\\.\pipe\InexIslandVoice`: Voice Assistant -> Island
// Emits "voice-assistant" event to Tauri frontend.
#[cfg(target_os = "windows")]
pub fn start(app: AppHandle) {
    std::thread::spawn(move || run(app));
}

#[cfg(target_os = "windows")]
fn run(app: AppHandle) {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WIN32_ERROR};
    use windows::Win32::Storage::FileSystem::{ReadFile, FILE_FLAGS_AND_ATTRIBUTES};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    const PIPE_ACCESS_INBOUND: u32 = 0x0000_0001;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const MAX_MESSAGE_BYTES: usize = 4096;
    const MAX_LINE_BYTES: usize = 2048;
    const MAX_HANDLERS: usize = 16;
    const READ_DEADLINE_MS: u64 = 2000;

    let pipe_name = w!(r"\\.\pipe\InexIslandVoice");
    let active = Arc::new(AtomicUsize::new(0));
    let mut first_instance = true;

    loop {
        unsafe {
            let mut open_mode = PIPE_ACCESS_INBOUND;
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

            let connected = ConnectNamedPipe(handle, None).is_ok()
                || GetLastError() == WIN32_ERROR(ERROR_PIPE_CONNECTED);

            if !connected {
                let _ = CloseHandle(handle);
                std::thread::sleep(Duration::from_millis(50));
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
                let mut data: Vec<u8> = Vec::new();
                let deadline = std::time::Instant::now() + Duration::from_millis(READ_DEADLINE_MS);

                while std::time::Instant::now() < deadline && data.len() < MAX_MESSAGE_BYTES {
                    let mut avail = 0u32;
                    if PeekNamedPipe(handle, None, 0, None, Some(&mut avail), None).is_err() {
                        break;
                    }
                    if avail == 0 {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    let mut buf = vec![0u8; (avail as usize).min(1024)];
                    let mut n = 0u32;
                    if ReadFile(handle, Some(&mut buf), Some(&mut n), None).is_err() || n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n as usize]);
                    if data.ends_with(b"\n") {
                        break;
                    }
                }

                if let Ok(text) = std::str::from_utf8(&data) {
                    for line in text.split('\n') {
                        let clean = line.trim();
                        if clean.is_empty() || clean.len() > MAX_LINE_BYTES || !clean.starts_with('{') {
                            continue;
                        }
                        let _ = app2.emit("voice-assistant", clean);
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
