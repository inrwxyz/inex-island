//! Tauri event bus: the engine (client/server/mdns) emits JSON events, the UI listens via Tauri events.

use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(h: AppHandle) {
    let _ = APP_HANDLE.set(h);
}

pub fn emit(v: serde_json::Value) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("quickshare-event", &v);
        let _ = app.emit("qs_event", &v);
        let _ = app.emit("inexdrop-event", &v);
        if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
            let _ = app.emit(t, &v);

            // If an incoming file offer arrives, bring the window to the front!
            if t == "offer" {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        }
    }
}

/// level: "info" | "ok" | "warn" | "error"
pub fn status(level: &str, text: &str) {
    emit(serde_json::json!({ "type": "status", "level": level, "text": text }));
}
