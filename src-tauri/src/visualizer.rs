//! Audio visualizer for the island.
//!
//! Listens to whatever Windows is playing (WASAPI loopback), runs a 512-point
//! FFT and sends five smoothed band levels (0.18 ..= 1.0) to the UI as the
//! `audio-visualization` event.
//!
//! CPU notes
//!   * paused (UI says not visible / not playing): the stream is stopped, the thread only wakes
//!     every 400 ms to look at the flag;
//!   * playing: wakes every 20 ms, events go out at most every ~32 ms;
//!   * silence: wakes every 60 ms for a few seconds (so the UI can fade out), then every 150 ms
//!     and sends nothing.

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

pub static VISUALIZER_ACTIVE: AtomicBool = AtomicBool::new(true);

#[derive(Clone, serde::Serialize)]
pub struct AudioVisualizationData {
    pub frequencies: Vec<f32>,
}

#[tauri::command]
pub fn set_visualizer_active(active: bool) {
    VISUALIZER_ACTIVE.store(active, Ordering::Relaxed);
}

// ───────────────────────────── tuning ─────────────────────────────

const BANDS: usize = 5;
const FFT_LEN: usize = 512;
/// Lowest level sent to the UI (it draws this as "bar at rest").
const FLOOR: f32 = 0.18;
/// Band amplitude below this counts as silence.
const SILENCE_AMP: f32 = 0.004;
/// How fast each band's running peak forgets (per FFT block).
const PEAK_DECAY: f32 = 0.997;
const ATTACK: f32 = 0.70;
const RELEASE: f32 = 0.28;

const POLL_ACTIVE: Duration = Duration::from_millis(20);
const POLL_FADE: Duration = Duration::from_millis(60);
const POLL_IDLE: Duration = Duration::from_millis(150);
const POLL_PAUSED: Duration = Duration::from_millis(400);
const EMIT_EVERY: Duration = Duration::from_millis(32);
const QUIET_AFTER: Duration = Duration::from_millis(1200);
const DEVICE_CHECK_EVERY: Duration = Duration::from_secs(2);
/// Flat frames sent after the music stops so the UI can switch itself to "quiet".
const FLAT_FRAMES: u32 = 60;
/// Loopback buffer length in 100 ns units (0.5 s).
const BUFFER_100NS: i64 = 5_000_000;
const SILENT_FLAG: u32 = 0x2; // AUDCLNT_BUFFERFLAGS_SILENT

// ───────────────────────────── sample format ─────────────────────────────

#[derive(Clone, Copy)]
enum Encoding {
    Float32,
    Int16,
    Int24,
    Int32,
}

struct Layout {
    rate: u32,
    channels: usize,
    width: usize,  // bytes per sample
    stride: usize, // bytes per frame
    encoding: Encoding,
}

/// Decode the WAVEFORMATEX / WAVEFORMATEXTENSIBLE Windows gave us.
/// Offsets are those of the documented structs; reads are unaligned-safe.
unsafe fn read_layout(fmt: *const u8) -> Option<Layout> {
    let tag = (fmt as *const u16).read_unaligned();
    let channels = (fmt.add(2) as *const u16).read_unaligned() as usize;
    let rate = (fmt.add(4) as *const u32).read_unaligned();
    let bits = (fmt.add(14) as *const u16).read_unaligned();
    let extra = (fmt.add(16) as *const u16).read_unaligned();

    let mut float = tag == 3; // WAVE_FORMAT_IEEE_FLOAT
    if tag == 0xFFFE && extra >= 22 {
        // extensible: the first dword of SubFormat says PCM (1) or float (3)
        float = (fmt.add(24) as *const u32).read_unaligned() == 3;
    }

    let encoding = match (float, bits) {
        (true, 32) => Encoding::Float32,
        (false, 16) => Encoding::Int16,
        (false, 24) => Encoding::Int24,
        (false, 32) => Encoding::Int32,
        _ => return None,
    };
    if channels == 0 || rate == 0 {
        return None;
    }
    let width = (bits / 8) as usize;
    Some(Layout { rate, channels, width, stride: width * channels, encoding })
}

/// One frame (all channels) averaged to mono, -1.0 ..= 1.0.
unsafe fn frame_mono(frame: *const u8, l: &Layout) -> f32 {
    let mut sum = 0.0f32;
    for ch in 0..l.channels {
        let p = frame.add(ch * l.width);
        sum += match l.encoding {
            Encoding::Float32 => (p as *const f32).read_unaligned(),
            Encoding::Int16 => (p as *const i16).read_unaligned() as f32 / 32768.0,
            Encoding::Int24 => {
                let v = ((*p.add(2) as i8 as i32) << 16) | ((*p.add(1) as i32) << 8) | (*p as i32);
                v as f32 / 8_388_608.0
            }
            Encoding::Int32 => (p as *const i32).read_unaligned() as f32 / 2_147_483_648.0,
        };
    }
    sum / l.channels as f32
}

// ───────────────────────────── analysis ─────────────────────────────

/// FFT bin range (lo, hi) of each band for this sample rate.
fn band_bins(rate: u32) -> [(usize, usize); BANDS] {
    const EDGES_HZ: [f32; BANDS + 1] = [60.0, 120.0, 400.0, 1500.0, 5000.0, 16000.0];
    let half = FFT_LEN / 2;
    let per_bin = rate as f32 / FFT_LEN as f32;

    let mut cut = [0usize; BANDS + 1];
    for (i, hz) in EDGES_HZ.iter().enumerate() {
        let wanted = ((hz / per_bin).round() as usize).clamp(1, half);
        cut[i] = if i == 0 { wanted } else { wanted.max(cut[i - 1] + 1) };
    }

    let mut out = [(1usize, 2usize); BANDS];
    for b in 0..BANDS {
        let hi = cut[b + 1].clamp(2, half);
        let lo = cut[b].min(hi - 1);
        out[b] = (lo, hi);
    }
    out
}

struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    block: Vec<Complex<f32>>,
    fill: usize,
    bins: [(usize, usize); BANDS],
    peak: [f32; BANDS],
    pending: [f32; BANDS],
    level: [f32; BANDS],
    last_loud: Instant,
    last_emit: Instant,
    flat_left: u32,
}

impl Analyzer {
    fn new(rate: u32) -> Analyzer {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_LEN);
        let window = (0..FFT_LEN)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_LEN as f32).cos())
            .collect();
        Analyzer {
            fft,
            window,
            block: vec![Complex::new(0.0, 0.0); FFT_LEN],
            fill: 0,
            bins: band_bins(rate),
            peak: [0.0; BANDS],
            pending: [0.0; BANDS],
            level: [FLOOR; BANDS],
            last_loud: Instant::now(),
            last_emit: Instant::now(),
            flat_left: FLAT_FRAMES,
        }
    }

    /// Forget everything about the previous playback.
    fn reset(&mut self) {
        self.fill = 0;
        self.pending = [0.0; BANDS];
        self.level = [FLOOR; BANDS];
        self.last_loud = Instant::now();
        self.flat_left = FLAT_FRAMES;
    }

    fn push(&mut self, sample: f32) {
        self.block[self.fill] = Complex::new(sample * self.window[self.fill], 0.0);
        self.fill += 1;
        if self.fill == FFT_LEN {
            self.fill = 0;
            self.analyse();
        }
    }

    fn analyse(&mut self) {
        self.fft.process(&mut self.block);
        // amplitude of an equivalent sine wave (Hann window gain = 1/2, two-sided spectrum)
        let scale = 4.0 / FFT_LEN as f32;
        let mut loud = false;
        for b in 0..BANDS {
            let (lo, hi) = self.bins[b];
            let sum: f32 = self.block[lo..hi].iter().map(|c| c.norm()).sum();
            let amp = sum / (hi - lo) as f32 * scale;
            let silence_thresh = if b >= 3 { SILENCE_AMP * 0.45 } else { SILENCE_AMP };
            if amp > silence_thresh {
                loud = true;
            }
            let decay = if b >= 3 { 0.991 } else { PEAK_DECAY };
            self.peak[b] = amp.max(self.peak[b] * decay);
            let pow = match b {
                4 => 0.48,
                3 => 0.56,
                2 => 0.65,
                _ => 0.70,
            };
            let rel = (amp / self.peak[b].max(silence_thresh)).min(1.0).powf(pow);
            if rel > self.pending[b] {
                self.pending[b] = rel;
            }
        }
        if loud {
            self.last_loud = Instant::now();
        }
    }

    fn quiet(&self) -> bool {
        self.last_loud.elapsed() > QUIET_AFTER
    }

    /// Smooth towards the newest peaks; returns the levels to send, if any.
    fn tick(&mut self) -> Option<[f32; BANDS]> {
        if self.last_emit.elapsed() < EMIT_EVERY {
            return None;
        }
        self.last_emit = Instant::now();

        let mut flat = true;
        for b in 0..BANDS {
            let target = FLOOR + (1.0 - FLOOR) * self.pending[b];
            let k = if target > self.level[b] { ATTACK } else { RELEASE };
            self.level[b] = (self.level[b] + (target - self.level[b]) * k).clamp(FLOOR, 1.0);
            self.pending[b] = 0.0;
            if self.level[b] > FLOOR + 0.01 {
                flat = false;
            }
        }
        if flat {
            if self.flat_left == 0 {
                return None;
            }
            self.flat_left -= 1;
        } else {
            self.flat_left = FLAT_FRAMES;
        }
        Some(self.level)
    }
}

// ───────────────────────────── capture ─────────────────────────────

unsafe fn default_device_id(enumerator: &IMMDeviceEnumerator) -> Option<String> {
    let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
    let id = device.GetId().ok()?;
    let text = id.to_string().ok();
    CoTaskMemFree(Some(id.0 as *const _));
    text
}

/// Read every packet that is waiting and feed it to the analyzer.
unsafe fn drain(capture: &IAudioCaptureClient, layout: &Layout, an: &mut Analyzer) -> Result<(), String> {
    loop {
        let waiting = capture
            .GetNextPacketSize()
            .map_err(|e| format!("packet size: {e:?}"))?;
        if waiting == 0 {
            return Ok(());
        }

        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        capture
            .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
            .map_err(|e| format!("buffer: {e:?}"))?;

        let silent = data.is_null() || flags & SILENT_FLAG != 0;
        for i in 0..frames as usize {
            let s = if silent { 0.0 } else { frame_mono(data.add(i * layout.stride), layout) };
            an.push(s);
        }
        let _ = capture.ReleaseBuffer(frames);
    }
}

/// One capture session on the current default output device.
/// Returns Err when the device goes away or changes; the caller starts a new one.
fn run_session(app: &AppHandle) -> Result<(), String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("enumerator: {e:?}"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("endpoint: {e:?}"))?;
        let started_on = default_device_id(&enumerator);

        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("activate: {e:?}"))?;

        let mix = client.GetMixFormat().map_err(|e| format!("mix format: {e:?}"))?;
        let layout = read_layout(mix as *const u8);
        let init = if layout.is_some() {
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    BUFFER_100NS,
                    0,
                    mix,
                    Some(std::ptr::null()),
                )
                .map_err(|e| format!("initialize: {e:?}"))
        } else {
            Err("unsupported mix format".to_string())
        };
        CoTaskMemFree(Some(mix as *const _));
        init?;
        let layout = layout.ok_or_else(|| "unsupported mix format".to_string())?;

        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| format!("capture service: {e:?}"))?;

        let mut an = Analyzer::new(layout.rate);
        let mut running = false;
        let mut last_device_check = Instant::now();

        loop {
            // start / stop the stream when the UI asks
            let wanted = VISUALIZER_ACTIVE.load(Ordering::Relaxed);
            if wanted != running {
                if wanted {
                    let _ = client.Reset();
                    client.Start().map_err(|e| format!("start: {e:?}"))?;
                    an.reset();
                } else {
                    let _ = client.Stop();
                }
                running = wanted;
            }

            // did the default output device change?
            if last_device_check.elapsed() >= DEVICE_CHECK_EVERY {
                last_device_check = Instant::now();
                let now_on = default_device_id(&enumerator);
                if now_on.is_some() && started_on.is_some() && now_on != started_on {
                    return Err("default output device changed".to_string());
                }
            }

            if !running {
                std::thread::sleep(POLL_PAUSED);
                continue;
            }

            drain(&capture, &layout, &mut an)?;
            if let Some(levels) = an.tick() {
                let _ = app.emit(
                    "audio-visualization",
                    AudioVisualizationData { frequencies: levels.to_vec() },
                );
            }

            let nap = if !an.quiet() {
                POLL_ACTIVE
            } else if an.flat_left > 0 {
                POLL_FADE
            } else {
                POLL_IDLE
            };
            std::thread::sleep(nap);
        }
    }
}

pub fn setup_audio_visualization(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("inex-visualizer".to_string())
        .spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            loop {
                // an Err just means "start a fresh session" (device switched, driver restarted ...)
                let _ = run_session(&app);
                std::thread::sleep(Duration::from_millis(2500));
            }
        });
}
