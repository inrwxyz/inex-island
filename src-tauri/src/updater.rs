use serde::Serialize;

#[derive(Serialize)]
pub struct UpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> UpdateCheck {
    let current_version = app.package_info().version.to_string();
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateCheck {
                available: false,
                current_version,
                latest_version: String::new(),
                error: Some(e.to_string()),
            }
        }
    };
    match updater.check().await {
        Ok(Some(update)) => UpdateCheck {
            available: true,
            current_version,
            latest_version: update.version,
            error: None,
        },
        Ok(None) => UpdateCheck {
            available: false,
            current_version,
            latest_version: String::new(),
            error: None,
        },
        Err(e) => UpdateCheck {
            available: false,
            current_version,
            latest_version: String::new(),
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn apply_update(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_chunk_len, _content_len| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        Ok(true)
    } else {
        Ok(false)
    }
}
