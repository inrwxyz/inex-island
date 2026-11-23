//! Core Audio push notifications (no polling).
//!
//!   * IAudioEndpointVolumeCallback on the default speaker  -> "volume-changed"    {level, muted}
//!   * IAudioEndpointVolumeCallback on the default mic      -> "mic-muted-changed" {muted}
//!   * IMMNotificationClient (device added / removed / state / default changed)
//!         -> re-attaches the two callbacks above to the new default devices,
//!            wakes the audio visualizer and sends "audio-device-changed".
//!
//! Volume keys, the Windows tray slider, a headset button or another app changing the volume all
//! arrive here the moment they happen. The thread sleeps on a channel the rest of the time.

#![cfg(target_os = "windows")]

use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::{implement, PCWSTR};
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE, EDataFlow, ERole,
    IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

// ───────────────────────────── volume callback ─────────────────────────────

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeCallback {
    app: AppHandle,
    capture: bool,
}

impl IAudioEndpointVolumeCallback_Impl for VolumeCallback_Impl {
    fn OnNotify(&self, pnotify: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows::core::Result<()> {
        if pnotify.is_null() {
            return Ok(());
        }
        let d = unsafe { &*pnotify };
        let muted = d.bMuted.as_bool();
        if self.capture {
            let _ = self.app.emit("mic-muted-changed", serde_json::json!({ "muted": muted }));
        } else {
            let level = (d.fMasterVolume * 100.0).round() as i32;
            let _ = self
                .app
                .emit("volume-changed", serde_json::json!({ "level": level, "muted": muted }));
        }
        Ok(())
    }
}

// ───────────────────────────── device callback ─────────────────────────────

#[implement(IMMNotificationClient)]
struct DeviceCallback {
    tx: Mutex<mpsc::Sender<()>>,
}

impl DeviceCallback {
    fn ping(&self, default_output_changed: bool) {
        crate::visualizer::device_event(default_output_changed);
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(());
        }
    }
}

impl IMMNotificationClient_Impl for DeviceCallback_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> windows::core::Result<()> {
        self.ping(false);
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        self.ping(false);
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        self.ping(false);
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _id: &PCWSTR) -> windows::core::Result<()> {
        if role == eConsole {
            self.ping(flow == eRender);
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

// ───────────────────────────── attach / detach ─────────────────────────────

/// A registered volume callback. Dropping it unregisters it.
struct Attached {
    vol: IAudioEndpointVolume,
    cb: IAudioEndpointVolumeCallback,
}

impl Drop for Attached {
    fn drop(&mut self) {
        unsafe {
            let _ = self.vol.UnregisterControlChangeNotify(&self.cb);
        }
    }
}

/// Attach to the default device of `flow` and send its current state once.
/// Returns None (and tells the UI "no device") when there is none.
unsafe fn attach(en: &IMMDeviceEnumerator, app: &AppHandle, capture: bool) -> Option<Attached> {
    let flow = if capture { eCapture } else { eRender };
    let result = (|| {
        let dev = en.GetDefaultAudioEndpoint(flow, eConsole).ok()?;
        let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
        let cb: IAudioEndpointVolumeCallback = VolumeCallback { app: app.clone(), capture }.into();
        vol.RegisterControlChangeNotify(&cb).ok()?;
        Some(Attached { vol, cb })
    })();

    match &result {
        Some(a) => {
            let muted = a.vol.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            if capture {
                let _ = app.emit("mic-muted-changed", serde_json::json!({ "muted": muted }));
            } else if let Ok(v) = a.vol.GetMasterVolumeLevelScalar() {
                let level = (v * 100.0).round() as i32;
                let _ = app.emit("volume-changed", serde_json::json!({ "level": level, "muted": muted }));
            }
        }
        None => {
            if capture {
                let _ = app.emit("mic-muted-changed", serde_json::json!({ "muted": serde_json::Value::Null }));
            }
        }
    }
    result
}

unsafe fn run(app: AppHandle) {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
        return;
    };

    let (tx, rx) = mpsc::channel::<()>();
    let client: IMMNotificationClient = DeviceCallback { tx: Mutex::new(tx) }.into();
    if en.RegisterEndpointNotificationCallback(&client).is_err() {
        return;
    }

    loop {
        // (re)attach to whatever the default speaker / microphone is right now
        let speaker = attach(&en, &app, false);
        let mic = attach(&en, &app, true);

        // sleep until Windows reports a device change (no timer)
        if rx.recv().is_err() {
            break;
        }
        // one plug / unplug produces a burst of notifications: merge them
        while rx.recv_timeout(Duration::from_millis(250)).is_ok() {}

        drop(speaker);
        drop(mic);
        let _ = app.emit("audio-device-changed", ());
    }
    let _ = en.UnregisterEndpointNotificationCallback(&client);
}

pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("inex-audio-events".to_string())
        .spawn(move || unsafe { run(app) });
}
