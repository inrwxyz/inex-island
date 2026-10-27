use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        use windows::core::w;
        use windows::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE, WIN32_ERROR};
        use windows::Win32::Storage::FileSystem::{ReadFile, FILE_FLAGS_AND_ATTRIBUTES};
        use windows::Win32::System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
            PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        };

        let pipe_name = w!(r"\\.\pipe\InexIslandLock");

        loop {
            unsafe {
                // PIPE_ACCESS_DUPLEX = 0x00000003
                let open_mode = FILE_FLAGS_AND_ATTRIBUTES(0x00000003);
                let handle = CreateNamedPipeW(
                    pipe_name,
                    open_mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    2048,
                    2048,
                    0,
                    None,
                );

                if handle == INVALID_HANDLE_VALUE {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue;
                }

                let connected = ConnectNamedPipe(handle, None).is_ok()
                    || GetLastError() == WIN32_ERROR(535); // ERROR_PIPE_CONNECTED

                if connected {
                    let mut buffer = [0u8; 1024];
                    let mut bytes_read = 0u32;
                    if ReadFile(handle, Some(&mut buffer), Some(&mut bytes_read), None).is_ok()
                        && bytes_read > 0
                    {
                        if let Ok(msg) = std::str::from_utf8(&buffer[..bytes_read as usize]) {
                            let clean = msg.trim();
                            if !clean.is_empty() {
                                let _ = app.emit("locker-unlock", clean);
                            }
                        }
                    }
                    let _ = DisconnectNamedPipe(handle);
                }
                let _ = CloseHandle(handle);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn start(_app: AppHandle) {}
