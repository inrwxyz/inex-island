use crate::startup::shell_open;

// Keep the screen awake. SetThreadExecutionState is per thread, so one parked thread owns the
// request. It sleeps on a channel (0 % CPU) and releases the request when the sender is dropped.
static KEEP_AWAKE: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> =
    std::sync::Mutex::new(None);

#[tauri::command]
pub fn set_keep_awake(on: bool) -> bool {
    let mut g = match KEEP_AWAKE.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if on {
        if g.is_none() {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || {
                #[cfg(target_os = "windows")]
                unsafe {
                    use windows::Win32::System::Power::{
                        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED,
                        ES_SYSTEM_REQUIRED,
                    };
                    let _ = SetThreadExecutionState(
                        ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                    );
                }
                let _ = rx.recv(); // blocks until the sender is dropped
                #[cfg(target_os = "windows")]
                unsafe {
                    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
                    let _ = SetThreadExecutionState(ES_CONTINUOUS);
                }
            });
            *g = Some(tx);
        }
    } else {
        *g = None; // dropping the sender wakes the thread, which clears the request
    }
    g.is_some()
}

#[tauri::command]
pub fn open_bt_settings() {
    shell_open("ms-settings:bluetooth");
}

#[tauri::command]
pub fn open_location_settings() {
    shell_open("ms-settings:privacy-location");
}

#[tauri::command]
pub fn open_wifi_settings() {
    shell_open("ms-settings:network-wifi");
}

pub(crate) fn is_safe_web_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://"))
        && !url.chars().any(|c| c.is_control())
}

#[tauri::command]
pub fn open_url(url: String) {
    // Only web links, and no control characters. ShellExecuteW never goes through cmd.exe,
    // so the text is handed to the default browser as it is and can not run anything.
    if is_safe_web_url(&url) {
        shell_open(&url);
    }
}

#[tauri::command]
pub fn lock_screen() {
    // LockWorkStation() locks the session directly (no rundll32)
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "user32")]
        extern "system" {
            fn LockWorkStation() -> i32;
        }
        let _ = LockWorkStation();
    }
}

#[tauri::command]
pub fn take_snip() {
    shell_open("ms-screenclip:");
}

#[tauri::command]
pub fn launch_quick_action(id: String) {
    if id == "calc" {
        shell_open("calc.exe");
    }
}

#[cfg(test)]
mod tests {
    use super::is_safe_web_url;

    #[test]
    fn allows_only_clean_http_and_https_urls() {
        assert!(is_safe_web_url("https://github.com/inrwxyz/inex-island"));
        assert!(is_safe_web_url("http://127.0.0.1:49871/health"));
        assert!(!is_safe_web_url("javascript:alert(1)"));
        assert!(!is_safe_web_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_safe_web_url("https://example.com/\ncalc"));
    }
}
