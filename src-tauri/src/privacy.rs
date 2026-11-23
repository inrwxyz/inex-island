// Microphone "in use" indicator, read from Windows audio sessions (Core Audio).
//
// Every app that records from a microphone has an active capture session on that device.
// This asks Windows for those sessions: no registry tricks, no hard-coded app names.
// No timer: Windows itself updates the privacy "ConsentStore" registry key every time an app
// starts or stops recording; RegNotifyChangeKeyValue wakes the thread on exactly those moments and
// only then the capture sessions are looked at. The thread sleeps (0 % CPU) the rest of the time.
// The island gets "privacy-changed" {kind: "mic", app: "<name>" | null} whenever it changes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;
#[allow(unused_imports)]
use tauri::Emitter;

static ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static STARTED: AtomicBool = AtomicBool::new(false);
// event handle (as isize) that wakes the thread when the Settings toggle changes
#[cfg(target_os = "windows")]
static WAKE: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

// Name of the app using microphone right now
static MIC_STATE: Mutex<Option<String>> = Mutex::new(None);

// Switches the watcher on / off (the thread is created once) and returns what is known right now.
#[tauri::command]
pub async fn privacy_watch_start(app: AppHandle, enabled: bool) -> Option<String> {
    ENABLED.store(enabled, Ordering::Relaxed);
    #[cfg(target_os = "windows")]
    {
        if enabled {
            start_once(app);
            wake();
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    if !enabled {
        return None;
    }
    let st = MIC_STATE.lock().unwrap();
    st.clone()
}

#[cfg(target_os = "windows")]
fn start_once(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("inex-privacy-mic".to_string())
        .spawn(move || mic_loop(app));
}

#[cfg(target_os = "windows")]
fn wake() {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::SetEvent;
    let raw = WAKE.load(Ordering::SeqCst);
    if raw != 0 {
        unsafe {
            let _ = SetEvent(HANDLE(raw as *mut core::ffi::c_void));
        }
    }
}

#[cfg(target_os = "windows")]
fn mic_loop(app: AppHandle) {
    use std::time::Duration;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Registry::{
        RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_NOTIFY,
        REG_NOTIFY_CHANGE_LAST_SET, REG_NOTIFY_CHANGE_NAME,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForMultipleObjects, INFINITE};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return;
        };

        // Windows writes LastUsedTimeStart / LastUsedTimeStop here for every app that uses the mic
        let mut key = HKEY::default();
        let opened = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"),
            0,
            KEY_NOTIFY,
            &mut key,
        ) == ERROR_SUCCESS;

        let Ok(reg_ev) = CreateEventW(None, false, false, PCWSTR::null()) else { return };
        let Ok(wake_ev) = CreateEventW(None, false, false, PCWSTR::null()) else { return };
        WAKE.store(wake_ev.0 as isize, Ordering::SeqCst);

        loop {
            if ENABLED.load(Ordering::Relaxed) {
                publish(&app, mic_in_use(&enumerator));
            }
            // arm the notification again (it fires once), then sleep until something happens
            if opened {
                let _ = RegNotifyChangeKeyValue(
                    key,
                    true,
                    REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET,
                    reg_ev,
                    true,
                );
            }
            let handles: [HANDLE; 2] = [reg_ev, wake_ev];
            let which = WaitForMultipleObjects(&handles, false, INFINITE);
            if which == WAIT_OBJECT_0 {
                // let the audio engine finish switching the session state before we read it
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn publish(app: &AppHandle, now: Option<String>) {
    let mut st = MIC_STATE.lock().unwrap();
    if *st == now {
        return;
    }
    *st = now.clone();
    drop(st);
    let _ = app.emit("privacy-changed", serde_json::json!({ "kind": "mic", "app": now }));
}

// Name of the first app that is recording from any microphone right now.
#[cfg(target_os = "windows")]
unsafe fn mic_in_use(en: &windows::Win32::Media::Audio::IMMDeviceEnumerator) -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::CLSCTX_ALL;

    let devices = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE).ok()?;
    let count = devices.GetCount().unwrap_or(0);
    let me = std::process::id();
    for i in 0..count {
        let Ok(dev) = devices.Item(i) else { continue };
        let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
        let Ok(list) = mgr.GetSessionEnumerator() else { continue };
        let n = list.GetCount().unwrap_or(0);
        for j in 0..n {
            let Ok(ctl) = list.GetSession(j) else { continue };
            if ctl.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let pid = ctl2.GetProcessId().unwrap_or(0);
            if pid == 0 || pid == me {
                continue; // system sounds / ourselves
            }
            return Some(process_name(pid));
        }
    }
    None
}

// "C:\...\Discord.exe" -> "Discord"
#[cfg(target_os = "windows")]
unsafe fn process_name(pid: u32) -> String {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut name = String::new();
    if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            name = full.rsplit('\\').next().unwrap_or("").to_string();
        }
        let _ = CloseHandle(h);
    }
    if name.to_lowercase().ends_with(".exe") {
        let cut = name.len() - 4;
        name.truncate(cut);
    }
    let mut c = name.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "An app".to_string(),
    }
}
