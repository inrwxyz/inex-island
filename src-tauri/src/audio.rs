#![allow(non_snake_case, dead_code)]

#[cfg(target_os = "windows")]
use windows::core::*;
#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::*;
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::*;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::PropertiesSystem::*;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[cfg(target_os = "windows")]
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

#[cfg(target_os = "windows")]
const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

#[cfg(target_os = "windows")]
#[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: windows::core::IUnknown {
    fn GetMixFormat(&self, device_id: PCWSTR, format: *mut std::ffi::c_void) -> HRESULT;
    fn GetDeviceFormat(&self, device_id: PCWSTR, default: i32, format: *mut std::ffi::c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, device_id: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, device_id: PCWSTR, endpoint_format: *const std::ffi::c_void, mix_format: *const std::ffi::c_void) -> HRESULT;
    fn GetProcessingPeriod(&self, device_id: PCWSTR, default: i32, period: *mut i64, period_min: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, device_id: PCWSTR, period: *const i64) -> HRESULT;
    fn GetShareMode(&self, device_id: PCWSTR, mode: *mut std::ffi::c_void) -> HRESULT;
    fn SetShareMode(&self, device_id: PCWSTR, mode: *const std::ffi::c_void) -> HRESULT;
    fn GetPropertyValue(&self, device_id: PCWSTR, key: *const PROPERTYKEY, value: *mut std::ffi::c_void) -> HRESULT;
    fn SetPropertyValue(&self, device_id: PCWSTR, key: *const PROPERTYKEY, value: *const std::ffi::c_void) -> HRESULT;
    fn SetDefaultEndpoint(&self, device_id: PCWSTR, role: ERole) -> HRESULT;
    fn SetEndpointVisibility(&self, device_id: PCWSTR, visible: i32) -> HRESULT;
}

#[tauri::command]
pub async fn get_audio_devices() -> Vec<AudioDevice> {
    #[cfg(target_os = "windows")]
    unsafe {
        let mut out = Vec::new();
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: windows::core::Result<IMMDeviceEnumerator> = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);
        let Ok(enumerator) = enumerator else { return out; };

        let default_id: Option<String> = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
            .ok()
            .and_then(|dev| dev.GetId().ok())
            .map(|id_pwstr| {
                let s = id_pwstr.to_string().unwrap_or_default();
                CoTaskMemFree(Some(id_pwstr.0 as *const _));
                s
            });

        let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out; };
        let count = collection.GetCount().unwrap_or(0);

        for i in 0..count {
            let Ok(dev) = collection.Item(i) else { continue; };
            let Ok(id_pwstr) = dev.GetId() else { continue; };
            let id = id_pwstr.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id_pwstr.0 as *const _));

            let mut name = String::new();
            if let Ok(store) = dev.OpenPropertyStore(STGM_READ) {
                if let Ok(val) = store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME) {
                    name = val.to_string();
                }
            }
            if name.is_empty() {
                name = format!("Audio Device {}", i + 1);
            }

            let is_default = default_id.as_deref() == Some(&id);
            out.push(AudioDevice { id, name, is_default });
        }
        out
    }
    #[cfg(not(target_os = "windows"))]
    Vec::new()
}

#[tauri::command]
pub async fn set_default_audio_device(id: String) -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let policy: windows::core::Result<IPolicyConfig> = CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL);
        if let Ok(policy) = policy {
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            let pcwstr = PCWSTR(wide.as_ptr());
            let r0 = policy.SetDefaultEndpoint(pcwstr, eConsole);
            let r1 = policy.SetDefaultEndpoint(pcwstr, eMultimedia);
            let r2 = policy.SetDefaultEndpoint(pcwstr, eCommunications);
            return r0.is_ok() || r1.is_ok() || r2.is_ok();
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = id;
        false
    }
}

#[tauri::command]
pub fn open_sound_settings() {
    #[cfg(target_os = "windows")]
    unsafe {
        let action = windows::core::w!("open");
        let target = windows::core::w!("ms-settings:sound");
        let _ = ShellExecuteW(None, action, target, None, None, SW_SHOWNORMAL);
    }
}
