#[cfg(target_os = "windows")]
fn endpoint_volume() -> Option<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
}

#[tauri::command]
pub async fn set_system_volume(level: i32) {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Some(vol) = endpoint_volume() {
            let v = (level.clamp(0, 100) as f32) / 100.0;
            let _ = vol.SetMasterVolumeLevelScalar(v, std::ptr::null());
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = level;
}

#[tauri::command]
pub async fn get_system_volume() -> i32 {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Some(vol) = endpoint_volume() {
            if let Ok(v) = vol.GetMasterVolumeLevelScalar() {
                return (v * 100.0).round() as i32;
            }
        }
    }
    75
}

#[cfg(target_os = "windows")]
fn find_audio_session_volume(app_keyword: &str) -> Option<windows::Win32::Media::Audio::ISimpleAudioVolume> {
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let kw = app_keyword.trim().to_ascii_lowercase();
    if kw.is_empty() {
        return None;
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).ok()?;
        let enum_sessions = mgr.GetSessionEnumerator().ok()?;
        let count = enum_sessions.GetCount().ok()?;

        for i in 0..count {
            if let Ok(ctl) = enum_sessions.GetSession(i) {
                if let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() {
                    let pid = ctl2.GetProcessId().unwrap_or(0);
                    if pid != 0 {
                        if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                            let mut buf = [0u16; 260];
                            let mut len = buf.len() as u32;
                            let ok = QueryFullProcessImageNameW(
                                h,
                                PROCESS_NAME_WIN32,
                                PWSTR(buf.as_mut_ptr()),
                                &mut len,
                            )
                            .is_ok();
                            let _ = CloseHandle(h);
                            if ok {
                                let exe = String::from_utf16_lossy(&buf[..len as usize])
                                    .to_ascii_lowercase();
                                let is_match = match kw.as_str() {
                                    "spotify" => exe.contains("spotify.exe"),
                                    "chrome" | "youtube" | "youtube music" => {
                                        exe.contains("chrome.exe")
                                            || exe.contains("msedge.exe")
                                            || exe.contains("firefox.exe")
                                            || exe.contains("brave.exe")
                                            || exe.contains("opera.exe")
                                    }
                                    "edge" => exe.contains("msedge.exe"),
                                    "firefox" => exe.contains("firefox.exe"),
                                    "brave" => exe.contains("brave.exe"),
                                    "opera" => exe.contains("opera.exe"),
                                    "apple music" => {
                                        exe.contains("applemusic.exe") || exe.contains("itunes.exe")
                                    }
                                    "vlc" => exe.contains("vlc.exe"),
                                    _ => exe.contains(&kw),
                                };
                                if is_match {
                                    if let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() {
                                        return Some(vol);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }
}

#[tauri::command]
pub async fn set_media_app_volume(source: String, level: i32) {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Some(vol) = find_audio_session_volume(&source) {
            let v = (level.clamp(0, 100) as f32) / 100.0;
            let _ = vol.SetMasterVolume(v, std::ptr::null());
            return;
        }
        set_system_volume(level).await;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (source, level);
}

#[tauri::command]
pub async fn get_media_app_volume(source: String) -> i32 {
    #[cfg(target_os = "windows")]
    unsafe {
        if let Some(vol) = find_audio_session_volume(&source) {
            if let Ok(v) = vol.GetMasterVolume() {
                return (v * 100.0).round() as i32;
            }
        }
        get_system_volume().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = source;
        75
    }
}

#[cfg(target_os = "windows")]
fn capture_endpoint() -> Option<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok()
    }
}

/// Real mute state of the default microphone. None = no capture device.
#[tauri::command]
pub async fn get_mic_muted() -> Option<bool> {
    #[cfg(target_os = "windows")]
    unsafe {
        let vol = capture_endpoint()?;
        return vol.GetMute().ok().map(|b| b.as_bool());
    }
    #[cfg(not(target_os = "windows"))]
    None
}

/// Mute / unmute the default microphone for the whole system (IAudioEndpointVolume).
#[tauri::command]
pub async fn set_mic_muted(muted: bool) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::BOOL;
        if let Some(vol) = capture_endpoint() {
            return vol.SetMute(BOOL::from(muted), std::ptr::null()).is_ok();
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = muted;
    false
}
