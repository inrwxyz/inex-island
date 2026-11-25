use tauri::{
    window::Color, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

static SETTINGS_OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn show_settings_window(app: &AppHandle) {
    let _guard = SETTINGS_OPEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.emit("settings-opened", ());
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("settings.html".into()),
    )
    .title("Inex Island Settings")
    .inner_size(980.0, 680.0)
    .center()
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .resizable(false)
    .shadow(false)
    .skip_taskbar(false)
    .visible(true)
    .focused(true)
    .build()
    {
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
pub fn close_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.close();
    }
}

#[tauri::command]
pub fn drag_settings(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    crate::screentime::save();
    app.restart();
}

#[tauri::command]
pub fn settings_changed(app: AppHandle, json: String) {
    let _ = app.emit("settings-changed", json);
}

#[tauri::command]
pub fn trigger_companion_demo(app: AppHandle, kind: String) {
    let _ = app.emit("companion-demo", kind);
}

#[tauri::command]
pub fn trigger_animation_demo(app: AppHandle, category: String, id: String) {
    let _ = app.emit("animation-demo", serde_json::json!({ "category": category, "id": id }));
}

// Autostart lives in two HKCU keys: Run (the command) and StartupApproved\Run (the on/off flag
// shown in Windows' Startup Apps list). Both are read and written with the registry API.
#[cfg(target_os = "windows")]
const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const APPROVED_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_NAME: &str = "Inex Island";

// The exe that should start at login. A dev build (target\debug) can not start alone, so for
// dev the real release exe (made by `npm run build`) is used instead.
#[cfg(target_os = "windows")]
fn autostart_exe() -> Option<String> {
    let cur = std::env::current_exe().ok()?;
    let s = cur.to_string_lossy().to_string();
    if s.to_lowercase().contains("\\target\\debug\\") {
        let rel = cur
            .parent()
            .and_then(|d| d.parent())
            .map(|t| t.join("release").join("inex-island.exe"))?;
        if rel.exists() {
            return Some(rel.to_string_lossy().to_string());
        }
        return None;
    }
    Some(s)
}

// Writes the Run entry AND marks it "enabled" for Windows' own Startup Apps list.
#[cfg(target_os = "windows")]
pub(crate) fn register_autostart() -> bool {
    let exe = match autostart_exe() {
        Some(e) => e,
        None => {
            crate::startup::log("autostart: no release exe found (run `npm run build` first)");
            return false;
        }
    };
    let value = format!("\"{}\" --autostart", exe);
    let ok = crate::winreg::set_string(RUN_SUBKEY, AUTOSTART_NAME, &value);
    // 02 00 00 00 ... = enabled (Windows writes 03 when the user/Windows disabled it)
    let _ = crate::winreg::set_binary(APPROVED_SUBKEY, AUTOSTART_NAME, &[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    crate::startup::log(&format!("autostart: register {} -> {}", value, ok));
    ok
}

#[tauri::command]
pub fn set_autostart(on: bool) -> bool {
    #[cfg(target_os = "windows")]
    {
        let marker = crate::startup::data_dir().join("autostart.on");
        if on {
            let ok = register_autostart();
            if ok {
                let _ = std::fs::write(&marker, b"1");
            }
            return ok;
        } else {
            let _ = std::fs::remove_file(&marker);
            let _ = crate::winreg::delete_value(RUN_SUBKEY, AUTOSTART_NAME);
            let _ = crate::winreg::delete_value(APPROVED_SUBKEY, AUTOSTART_NAME);
            return true;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = on;
        false
    }
}

// If an earlier dev build registered itself for startup, remove that dead entry
#[cfg(target_os = "windows")]
pub(crate) fn drop_stale_autostart() {
    if let Some(text) = crate::winreg::get_string(RUN_SUBKEY, AUTOSTART_NAME) {
        if text.to_lowercase().contains("\\target\\debug\\") {
            let _ = crate::winreg::delete_value(RUN_SUBKEY, AUTOSTART_NAME);
        }
    }
}
