fn synthesize_wav_notes(duration_secs: f32, decay_rate: f32, notes: &[(f32, f32, f32)]) -> Vec<u8> {
    let sample_rate: u32 = 44100;
    let total_samples = ((sample_rate as f32 * duration_secs) as usize).max(1);
    let mut pcm: Vec<i16> = vec![0; total_samples];

    for &(freq, delay, vol) in notes {
        let start_sample = (delay * sample_rate as f32) as usize;
        for (i, slot) in pcm.iter_mut().enumerate().take(total_samples).skip(start_sample) {
            let t = (i - start_sample) as f32 / sample_rate as f32;
            // Warm Material/Android-like soft transient + gentle 2nd harmonic body
            let attack = (t / 0.014).min(1.0);
            let decay = (-t * decay_rate).exp();
            let fundamental = (2.0 * std::f32::consts::PI * freq * t).sin();
            let overtone = (4.0 * std::f32::consts::PI * freq * t).sin() * 0.16 * (-t * decay_rate * 2.2).exp();
            let sample = (fundamental + overtone) * vol * attack * decay;
            let val = (sample * 32767.0) as i32;
            *slot = slot.saturating_add(val as i16);
        }
    }

    let mut wav = Vec::with_capacity(44 + total_samples * 2);
    let data_size = (total_samples * 2) as u32;
    let file_size = 36 + data_size;

    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for s in pcm {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

fn generate_chime_wav() -> Vec<u8> {
    synthesize_wav_notes(
        0.95,
        4.2,
        &[
            (392.00, 0.00, 0.14),
            (493.88, 0.09, 0.13),
            (587.33, 0.18, 0.12),
            (783.99, 0.27, 0.10),
        ],
    )
}

#[cfg(target_os = "windows")]
fn play_wav_memory(wav: &[u8]) {
    #[link(name = "winmm")]
    extern "system" {
        fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
    }
    const SND_ASYNC: u32 = 0x0001;
    const SND_NODEFAULT: u32 = 0x0002;
    const SND_MEMORY: u32 = 0x0004;
    unsafe {
        let _ = PlaySoundW(wav.as_ptr() as *const u16, 0, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
    }
}

#[tauri::command]
pub fn play_status_sound(kind: String) {
    #[cfg(target_os = "windows")]
    {
        use std::sync::OnceLock;
        let wav: &'static Vec<u8> = match kind.as_str() {
            "power" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.38, 8.5, &[(440.00, 0.0, 0.11), (587.33, 0.07, 0.10)]))
            }
            "power-off" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.34, 9.5, &[(523.25, 0.0, 0.10), (392.00, 0.065, 0.09)]))
            }
            "low" | "low-battery" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.45, 7.5, &[(392.00, 0.0, 0.12), (329.63, 0.13, 0.11)]))
            }
            "bluetooth" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.36, 9.0, &[(440.00, 0.0, 0.11), (659.25, 0.065, 0.10)]))
            }
            // File transfer finished: the real Quick Share sound (src-tauri/sounds/transfer.wav, baked into the exe).
            "transfer" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| include_bytes!("../sounds/transfer.wav").to_vec())
            }
            // incoming-file request popup: soft rounded 2-note chime
            "transfer-ask" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.38, 8.5, &[(493.88, 0.0, 0.10), (659.25, 0.08, 0.10)]))
            }
            "lock" => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.32, 10.5, &[(523.25, 0.0, 0.10), (698.46, 0.055, 0.09)]))
            }
            _ => {
                static W: OnceLock<Vec<u8>> = OnceLock::new();
                W.get_or_init(|| synthesize_wav_notes(0.18, 16.0, &[(587.33, 0.0, 0.09)]))
            }
        };
        play_wav_memory(wav);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = kind;
}

#[cfg(target_os = "windows")]
static ALARM_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn parse_wav_duration_ms(wav: &[u8]) -> Option<u64> {
    if wav.len() < 44 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let mut byte_rate: u32 = 0;
    let mut data_len: u32 = 0;
    let mut pos: usize = 12;
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size = u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]) as usize;
        let body = pos + 8;
        if body > wav.len() {
            break;
        }
        if id == b"fmt " && body + 12 <= wav.len() {
            byte_rate = u32::from_le_bytes([wav[body + 8], wav[body + 9], wav[body + 10], wav[body + 11]]);
        } else if id == b"data" {
            data_len = size as u32;
            break;
        }
        let step = size + (size & 1);
        pos = match body.checked_add(step) {
            Some(next) if next > pos => next,
            _ => break,
        };
    }
    if byte_rate > 0 && data_len > 0 {
        Some(((data_len as u64) * 1000 / (byte_rate as u64)).clamp(350, 120_000))
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn stop_winmm_sound() {
    #[link(name = "winmm")]
    extern "system" {
        fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
    }
    unsafe {
        let _ = PlaySoundW(std::ptr::null(), 0, 0);
    }
}

#[cfg(target_os = "windows")]
fn play_alarm_once_with_duration() -> u64 {
    use windows::core::HSTRING;
    #[link(name = "winmm")]
    extern "system" {
        fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
    }
    const SND_ASYNC: u32 = 0x0001;
    const SND_NODEFAULT: u32 = 0x0002;
    const SND_FILENAME: u32 = 0x00020000;

    let alarm_file = r"C:\Windows\Media\Alarm01.wav";
    if let Ok(bytes) = std::fs::read(alarm_file) {
        let dur_ms = parse_wav_duration_ms(&bytes).unwrap_or(5600);
        let hstr = HSTRING::from(alarm_file);
        unsafe {
            if PlaySoundW(hstr.as_ptr(), 0, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) != 0 {
                return dur_ms;
            }
        }
    }

    static CHIME: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let wav = CHIME.get_or_init(generate_chime_wav);
    let dur_ms = parse_wav_duration_ms(wav).unwrap_or(950);
    play_wav_memory(wav);
    dur_ms
}

#[tauri::command]
pub fn play_alarm_sound() {
    #[cfg(target_os = "windows")]
    {
        let _ = play_alarm_once_with_duration();
    }
}

#[tauri::command]
pub fn stop_alarm_sound() {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        ALARM_GEN.fetch_add(1, Ordering::SeqCst);
        stop_winmm_sound();
    }
}

#[tauri::command]
pub fn start_alarm_loop(gap_ms: Option<u64>) {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        let gap = gap_ms.unwrap_or(350).min(10_000);
        let my_gen = ALARM_GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        std::thread::spawn(move || {
            while ALARM_GEN.load(Ordering::SeqCst) == my_gen {
                let dur = play_alarm_once_with_duration();
                let wait_until = std::time::Instant::now() + std::time::Duration::from_millis(dur + gap);
                while std::time::Instant::now() < wait_until {
                    if ALARM_GEN.load(Ordering::SeqCst) != my_gen {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = gap_ms;
}

#[cfg(test)]
mod tests {
    use super::{generate_chime_wav, parse_wav_duration_ms};

    #[test]
    fn parses_generated_wav_duration_accurately() {
        let wav = generate_chime_wav();
        let dur = parse_wav_duration_ms(&wav).expect("valid wav duration");
        assert!((940..=960).contains(&dur), "expected ~950ms, got {}", dur);
    }

    #[test]
    fn rejects_invalid_wav_headers() {
        assert_eq!(parse_wav_duration_ms(b"not a wav"), None);
    }
}
