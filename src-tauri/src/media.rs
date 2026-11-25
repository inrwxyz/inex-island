use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct MediaInfo {
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub source: String,
    pub position: f64,
    pub duration: f64,
    pub updated_at: u64,
}

// 1. Real Windows Media Status (Universal Media Detection across all Windows players)
#[cfg(target_os = "windows")]
fn is_self_media_session(s: &windows::Media::Control::GlobalSystemMediaTransportControlsSession) -> bool {
    let raw = s.SourceAppUserModelId().map(|x| x.to_string()).unwrap_or_default().to_ascii_lowercase();
    if raw.contains("inex") || raw.contains("island") || raw.contains("tauri") {
        return true;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(stem) = exe.file_stem().and_then(|st| st.to_str()) {
            if !stem.is_empty() && raw.contains(&stem.to_ascii_lowercase()) {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn get_best_media_session(
    manager: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
) -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
    if let Ok(sessions) = manager.GetSessions() {
        let mut first_valid = None;
        for s in sessions {
            if is_self_media_session(&s) {
                continue;
            }
            if let Ok(info) = s.GetPlaybackInfo() {
                if let Ok(status) = info.PlaybackStatus() {
                    if status == Status::Playing {
                        return Some(s);
                    }
                    if first_valid.is_none() && status != Status::Closed && status != Status::Stopped {
                        first_valid = Some(s);
                    }
                }
            }
        }
        if first_valid.is_some() {
            return first_valid;
        }
    }
    if let Ok(curr) = manager.GetCurrentSession() {
        if !is_self_media_session(&curr) {
            return Some(curr);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn pretty_media_source(app_id: &str) -> String {
    let raw = app_id.trim();
    if raw.is_empty() {
        return String::new();
    }
    let low = raw.to_ascii_lowercase();
    if low.contains("youtubemusic") || low.contains("cinhimbnkkaeohfgghhklpknlkffjgod") {
        return "YouTube Music".to_string();
    }
    if low.contains("youtube") || low.contains("agimnkijcaahngcdmfeangaknmldooml") {
        return "YouTube".to_string();
    }
    if low.contains("spotify") { return "Spotify".to_string(); }
    if low.contains("applemusic") || low.contains("itunes") { return "Apple Music".to_string(); }
    if low.contains("tidal") { return "TIDAL".to_string(); }
    if low.contains("deezer") { return "Deezer".to_string(); }
    if low.contains("vlc") { return "VLC".to_string(); }
    if low.contains("foobar") { return "foobar2000".to_string(); }
    if low.contains("zune") || low.contains("mediaplayer") { return "Media Player".to_string(); }
    if low.contains("msedge") || low.contains("microsoftedge") { return "Edge".to_string(); }
    if low.contains("chrome") { return "Chrome".to_string(); }
    if low.contains("firefox") { return "Firefox".to_string(); }
    if low.contains("brave") { return "Brave".to_string(); }
    if low.contains("opera") { return "Opera".to_string(); }
    if low.contains("telegram") { return "Telegram".to_string(); }
    if low.contains("discord") { return "Discord".to_string(); }
    let base = raw.rsplit(['\\', '/', '!']).next().unwrap_or(raw);
    let stem = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base);
    let clean = stem.split('_').next().unwrap_or(stem).trim();
    if clean.len() > 20 { clean[..20].to_string() } else { clean.to_string() }
}

#[cfg(target_os = "windows")]
static LAST_BROWSER_MEDIA_SOURCE: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
fn visible_window_titles() -> Vec<String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            if len > 0 {
                let s = String::from_utf16_lossy(&buf[..len as usize]);
                let vec = &mut *(lparam.0 as *mut Vec<String>);
                vec.push(s);
            }
        }
        BOOL(1)
    }

    let mut titles: Vec<String> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut titles as *mut Vec<String> as isize));
    }
    titles
}

#[cfg(target_os = "windows")]
fn resolve_media_source(app_id: &str, title: &str, artist: &str, album: &str, subtitle: &str) -> String {
    let base = pretty_media_source(app_id);
    let meta = format!("{} {}", album, subtitle).to_ascii_lowercase();
    if meta.contains("youtube music") { return "YouTube Music".to_string(); }
    if meta.contains("youtube") { return "YouTube".to_string(); }
    if meta.contains("spotify") { return "Spotify".to_string(); }

    let is_browser = matches!(base.as_str(), "Chrome" | "Edge" | "Firefox" | "Brave" | "Opera");
    if !is_browser {
        return base;
    }

    let title_low = title.trim().to_ascii_lowercase();
    let artist_low = artist.trim().to_ascii_lowercase();
    let track_key = format!("{}|{}|{}", base, title_low, artist_low);
    let snippet: String = title_low.chars().take(18).collect();
    let snippet = snippet.trim();

    let windows = visible_window_titles();
    let mut detected: Option<String> = None;

    // Exact match: window title includes current track snippet + site name
    if snippet.len() >= 4 {
        for wt in &windows {
            let wl = wt.to_ascii_lowercase();
            if wl.contains(snippet) {
                if wl.contains("youtube music") {
                    detected = Some("YouTube Music".to_string());
                    break;
                }
                if wl.contains("youtube") {
                    detected = Some("YouTube".to_string());
                    break;
                }
                if wl.contains("spotify") {
                    detected = Some("Spotify".to_string());
                    break;
                }
            }
        }
    }

    // Fallback: open browser window actively showing YouTube / YouTube Music
    if detected.is_none() {
        let browser_hint = match base.as_str() {
            "Chrome" => "chrome",
            "Edge" => "edge",
            "Firefox" => "firefox",
            "Brave" => "brave",
            "Opera" => "opera",
            _ => "",
        };
        for wt in &windows {
            let wl = wt.to_ascii_lowercase();
            if !browser_hint.is_empty() && !wl.contains(browser_hint) && !wl.ends_with("youtube") {
                continue;
            }
            if wl.contains("youtube music") {
                detected = Some("YouTube Music".to_string());
                break;
            }
            if wl.contains(" - youtube") || wl.starts_with("youtube - ") || wl == "youtube" || wl.contains("youtube shorts") {
                detected = Some("YouTube".to_string());
                break;
            }
        }
    }

    if let Ok(mut guard) = LAST_BROWSER_MEDIA_SOURCE.lock() {
        if let Some(ref src) = detected {
            *guard = Some((track_key, src.clone()));
            return src.clone();
        }
        if let Some((ref prev_key, ref prev_src)) = *guard {
            if prev_key == &track_key {
                return prev_src.clone();
            }
        }
    }

    base
}

#[tauri::command]
pub async fn get_media_status() -> MediaInfo {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::{
            GlobalSystemMediaTransportControlsSessionManager,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus,
        };
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    let status = session
                        .GetPlaybackInfo()
                        .and_then(|info| info.PlaybackStatus())
                        .unwrap_or(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed);

                    let playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
                    let raw_app_id = session
                        .SourceAppUserModelId()
                        .map(|s| s.to_string())
                        .unwrap_or_default();

                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    // If closed or stopped, media is not active
                    if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed
                        || status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped
                    {
                        return MediaInfo {
                            playing: false,
                            title: String::new(),
                            artist: String::new(),
                            source: String::new(),
                            position: 0.0,
                            duration: 0.0,
                            updated_at: now_ms,
                        };
                    }

                    if let Ok(props_op) = session.TryGetMediaPropertiesAsync() {
                        if let Ok(props) = props_op.get() {
                            let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
                            let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
                            let album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
                            let subtitle = props.Subtitle().map(|s| s.to_string()).unwrap_or_default();
                            if !title.is_empty() {
                                let source = resolve_media_source(&raw_app_id, &title, &artist, &album, &subtitle);
                                let (position, duration) = session
                                    .GetTimelineProperties()
                                    .map(|t| {
                                        let start = t
                                            .StartTime()
                                            .map(|d| d.Duration as f64 / 1e7)
                                            .unwrap_or(0.0);
                                        let mut pos = (t
                                            .Position()
                                            .map(|d| d.Duration as f64 / 1e7)
                                            .unwrap_or(0.0)
                                            - start)
                                            .max(0.0);
                                        let end = t
                                            .EndTime()
                                            .map(|d| d.Duration as f64 / 1e7)
                                            .unwrap_or(0.0);
                                        let max_seek = t
                                            .MaxSeekTime()
                                            .map(|d| d.Duration as f64 / 1e7)
                                            .unwrap_or(0.0);
                                        let dur = if end > start {
                                            end - start
                                        } else if max_seek > start {
                                            max_seek - start
                                        } else {
                                            0.0
                                        };
                                        if playing {
                                            if let Ok(lu) = t.LastUpdatedTime() {
                                                const WIN_TO_UNIX_TICKS: i64 = 116_444_736_000_000_000;
                                                let now_win_ticks = (now_ms as i64) * 10_000 + WIN_TO_UNIX_TICKS;
                                                if lu.UniversalTime > WIN_TO_UNIX_TICKS && now_win_ticks > lu.UniversalTime {
                                                    let elapsed = (now_win_ticks - lu.UniversalTime) as f64 / 1e7;
                                                    if elapsed > 0.0 && elapsed < 14_400.0 {
                                                        pos += elapsed;
                                                    }
                                                }
                                            }
                                        }
                                        if dur > 0.0 {
                                            pos = pos.min(dur);
                                        }
                                        (pos, dur)
                                    })
                                    .unwrap_or((0.0, 0.0));
                                return MediaInfo {
                                    playing,
                                    title,
                                    artist,
                                    source,
                                    position,
                                    duration,
                                    updated_at: now_ms,
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    MediaInfo {
        playing: false,
        title: String::new(),
        artist: String::new(),
        source: String::new(),
        position: 0.0,
        duration: 0.0,
        updated_at: now_ms,
    }
}

// Seek media timeline to a specific second (for draggable progress bar)
#[tauri::command]
pub async fn seek_media(position_sec: f64) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    let ticks = (position_sec.max(0.0) * 10_000_000.0) as i64;
                    if let Ok(seek_op) = session.TryChangePlaybackPositionAsync(ticks) {
                        return seek_op.get().unwrap_or(false);
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = position_sec;
    false
}

#[cfg(target_os = "windows")]
fn media_art_inner() -> Option<String> {
    use windows::core::Interface;
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    use windows::Storage::Streams::{DataReader, IInputStream};

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;
    let session = get_best_media_session(&manager)?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    let input: IInputStream = stream.cast().ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;

    // Reject Windows ICO format (starts with \x00\x00\x01\x00) - browser/app executable icon, not media artwork
    if buf.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return None;
    }

    // Check PNG format: if PNG is smaller than 3.5KB or dimensions <= 64x64, it's a browser placeholder/favicon
    if buf.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        if buf.len() < 3500 {
            return None;
        }
        if buf.len() >= 24 {
            let width = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
            let height = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
            if width <= 64 && height <= 64 {
                return None;
            }
        }
    }

    // Detect proper image mime type
    let mime = if buf.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if buf.len() > 12 && buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    };

    Some(format!("data:{};base64,{}", mime, base64_encode(&buf)))
}

pub fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[tauri::command]
pub async fn get_media_art() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(art) = media_art_inner() {
            return art;
        }
    }
    String::new()
}

#[tauri::command]
pub async fn media_play_pause() {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        let mut handled = false;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    if let Ok(toggle_op) = session.TryTogglePlayPauseAsync() {
                        handled = toggle_op.get().unwrap_or(false);
                    }
                }
            }
        }
        if !handled {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_PLAY_PAUSE,
                };
                keybd_event(VK_MEDIA_PLAY_PAUSE.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MEDIA_PLAY_PAUSE.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }
}

#[tauri::command]
pub async fn media_next() {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        let mut handled = false;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    if let Ok(next_op) = session.TrySkipNextAsync() {
                        handled = next_op.get().unwrap_or(false);
                    }
                }
            }
        }
        if !handled {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_NEXT_TRACK,
                };
                keybd_event(VK_MEDIA_NEXT_TRACK.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MEDIA_NEXT_TRACK.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }
}

#[tauri::command]
pub async fn media_prev() {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
        let mut handled = false;
        if let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            if let Ok(manager) = op.get() {
                if let Some(session) = get_best_media_session(&manager) {
                    if let Ok(prev_op) = session.TrySkipPreviousAsync() {
                        handled = prev_op.get().unwrap_or(false);
                    }
                }
            }
        }
        if !handled {
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::{
                    keybd_event, KEYEVENTF_KEYUP, VK_MEDIA_PREV_TRACK,
                };
                keybd_event(VK_MEDIA_PREV_TRACK.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MEDIA_PREV_TRACK.0 as u8, 0, KEYEVENTF_KEYUP, 0);
            }
        }
    }
}
