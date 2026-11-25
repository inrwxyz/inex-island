use tauri::AppHandle;

#[cfg(target_os = "windows")]
fn radio_kind(name: &str) -> Option<windows::Devices::Radios::RadioKind> {
    use windows::Devices::Radios::RadioKind;
    match name {
        "wifi" => Some(RadioKind::WiFi),
        "bt" => Some(RadioKind::Bluetooth),
        _ => None,
    }
}

/// Does this PC have the adapter at all (Bluetooth dongle plugged in, Wi-Fi card present)?
/// Kept current by the radio watcher in live.rs; the first call before it has looked checks directly.
#[tauri::command]
pub async fn get_radio_present(kind: String) -> Option<bool> {
    if let Some(p) = crate::live::radio_present_known(&kind) {
        return Some(p);
    }
    #[cfg(target_os = "windows")]
    {
        use windows::Devices::Radios::Radio;
        let wanted = radio_kind(&kind)?;
        let radios = Radio::GetRadiosAsync().ok()?.get().ok()?;
        let mut found = false;
        for i in 0..radios.Size().ok()? {
            if radios.GetAt(i).ok()?.Kind().ok()? == wanted {
                found = true;
                break;
            }
        }
        crate::live::present_store(&kind, found);
        return Some(found);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = kind;
        None
    }
}

#[tauri::command]
pub async fn get_radio_state(kind: String) -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        use windows::Devices::Radios::{Radio, RadioState};
        // The radio watcher (live.rs) keeps this current through Windows events.
        if let Some(on) = crate::live::radio_cached(&kind) {
            return Some(on);
        }
        let wanted = radio_kind(&kind)?;
        let radios = Radio::GetRadiosAsync().ok()?.get().ok()?;
        for i in 0..radios.Size().ok()? {
            let r = radios.GetAt(i).ok()?;
            if r.Kind().ok()? == wanted {
                let on = r.State().ok()? == RadioState::On;
                crate::live::radio_store(&kind, on);
                return Some(on);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = kind;
    None
}

#[tauri::command]
pub async fn set_radio_state(kind: String, on: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioState};
        let wanted = radio_kind(&kind).ok_or("unknown radio")?;
        let _ = Radio::RequestAccessAsync()
            .ok()
            .and_then(|op| op.get().ok());
        let radios = Radio::GetRadiosAsync()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;
        let count = radios.Size().map_err(|e| e.to_string())?;
        for i in 0..count {
            let r = radios.GetAt(i).map_err(|e| e.to_string())?;
            if r.Kind().map_err(|e| e.to_string())? == wanted {
                let status = r
                    .SetStateAsync(if on { RadioState::On } else { RadioState::Off })
                    .map_err(|e| e.to_string())?
                    .get()
                    .map_err(|e| e.to_string())?;
                if status == RadioAccessStatus::Allowed {
                    crate::live::radio_store(&kind, on);
                }
                return Ok(status == RadioAccessStatus::Allowed);
            }
        }
        return Err("No such radio on this PC".into());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (kind, on);
        Err("Windows only".into())
    }
}

// ---------------------------------------------------------------------------------------
// Control-panel slot backends (start / stop from the island's slot registry)
// ---------------------------------------------------------------------------------------

/// Start or stop the whole Wi-Fi backend (WLAN notification watcher + radio events).
#[tauri::command]
pub fn wifi_backend(app: AppHandle, on: bool) {
    crate::live::set_radio_active("wifi", on);
    if on {
        crate::wifi::start(app);
    } else {
        crate::wifi::stop();
    }
}

/// Switch the Bluetooth backend on or off. While off, every Bluetooth command returns at once.
#[tauri::command]
pub fn bt_backend(app: AppHandle, on: bool) {
    crate::live::set_radio_active("bt", on);
    if on {
        crate::bluetooth::start(app);
    } else {
        crate::bluetooth::stop();
    }
}
