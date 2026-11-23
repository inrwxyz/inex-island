// Spotlight Search native side: finds installed browsers and opens a URL in a specific one.
// It only launches the chosen browser with the URL. It never touches the system default browser.
// Register in the Tauri builder: `mod spotlight;` and add
//   spotlight::spotlight_detect_browsers, spotlight::spotlight_open
// to tauri::generate_handler![...].

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct InstalledBrowser {
    pub id: String,
    pub path: String,
}

// (id, executable paths relative to Program Files / Program Files (x86) / %LOCALAPPDATA%)
const BROWSERS: &[(&str, &[&str])] = &[
    ("chrome", &["Google\\Chrome\\Application\\chrome.exe"]),
    ("edge", &["Microsoft\\Edge\\Application\\msedge.exe"]),
    ("firefox", &["Mozilla Firefox\\firefox.exe"]),
    ("brave", &["BraveSoftware\\Brave-Browser\\Application\\brave.exe"]),
    ("opera", &["Opera\\opera.exe", "Programs\\Opera\\opera.exe"]),
    ("vivaldi", &["Vivaldi\\Application\\vivaldi.exe"]),
];

fn roots() -> Vec<PathBuf> {
    ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .map(PathBuf::from)
        .collect()
}

fn find_exe(id: &str) -> Option<PathBuf> {
    let (_, rels) = BROWSERS.iter().find(|(bid, _)| *bid == id)?;
    for root in roots() {
        for rel in rels.iter() {
            let p = root.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
pub fn spotlight_detect_browsers() -> Vec<InstalledBrowser> {
    BROWSERS
        .iter()
        .filter_map(|(id, _)| {
            find_exe(id).map(|p| InstalledBrowser {
                id: (*id).to_string(),
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn spotlight_open(browser: String, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs can be opened".into());
    }
    let exe = find_exe(&browser).ok_or_else(|| format!("browser not installed: {browser}"))?;
    Command::new(exe).arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
