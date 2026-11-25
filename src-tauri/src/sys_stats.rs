use serde::Serialize;

#[derive(Serialize)]
pub struct SysStats {
    pub ram_pct: u32,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub cpu_pct: u32,
    pub gpu_pct: u32,
    pub disk_pct: u32,
    pub battery_pct: i32,
    pub charging: bool,
    pub wifi_name: String,
    pub wifi_signal: u32,
    pub wifi_on: bool,
    pub is_fullscreen: bool,
}

#[cfg(target_os = "windows")]
static CPU_PREV: std::sync::Mutex<(u64, u64)> = std::sync::Mutex::new((0, 0));

// ---- Net speed for the "Net Speed" hover widget -------------------------------------------
// Bytes in/out of the real (hardware) adapters that are up, from the native IP Helper API.
// The island only calls get_net_speed while that widget is selected, so it costs nothing otherwise.
#[cfg(target_os = "windows")]
static NET_PREV: std::sync::Mutex<Option<(std::time::Instant, u64, u64)>> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
fn net_octets() -> (u64, u64) {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    let (mut rx, mut tx) = (0u64, 0u64);
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        let _ = GetIfTable2(&mut table);
        if table.is_null() {
            return (0, 0);
        }
        let n = (*table).NumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), n);
        for r in rows {
            // OperStatus 1 = up. The first flag bit is HardwareInterface: it skips VPN, Hyper-V, WSL and loopback
            // adapters, so the same traffic is never counted twice.
            let hardware = (*(&r.InterfaceAndOperStatusFlags as *const _ as *const u8)) & 1 != 0;
            if r.OperStatus.0 == 1 && hardware {
                rx += r.InOctets;
                tx += r.OutOctets;
            }
        }
        FreeMibTable(table as *const core::ffi::c_void);
    }
    (rx, tx)
}

// (download, upload) in bytes per second, averaged since the previous call.
#[tauri::command]
pub async fn get_net_speed() -> (u64, u64) {
    #[cfg(target_os = "windows")]
    {
        let (rx, tx) = net_octets();
        let now = std::time::Instant::now();
        let mut prev = NET_PREV.lock().unwrap();
        let out = match *prev {
            Some((t, prx, ptx)) => {
                let dt = now.duration_since(t).as_secs_f64();
                if dt >= 0.5 && dt <= 10.0 {
                    (
                        (rx.saturating_sub(prx) as f64 / dt) as u64,
                        (tx.saturating_sub(ptx) as f64 / dt) as u64,
                    )
                } else {
                    (0, 0) // first call or a long pause: no usable baseline yet
                }
            }
            None => (0, 0),
        };
        *prev = Some((now, rx, tx));
        return out;
    }
    #[cfg(not(target_os = "windows"))]
    (0, 0)
}

#[cfg(target_os = "windows")]
fn cpu_percent() -> u32 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;
    let (mut idle, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe {
        let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));
    }
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    let (i, total) = (ft(idle), ft(kernel) + ft(user));
    let mut prev = CPU_PREV.lock().unwrap();
    let (prev_i, prev_total) = *prev;
    *prev = (i, total);
    if prev_total == 0 || total <= prev_total {
        return 0;
    }
    let dt = total - prev_total;
    let di = i.saturating_sub(prev_i);
    (100 * dt.saturating_sub(di) / dt) as u32
}

#[cfg(target_os = "windows")]
mod gpu {
    use std::sync::Mutex;
    use windows::core::w;

    #[repr(C)]
    struct PdhFmtCountervalue {
        c_status: u32,
        _pad: u32,
        double_value: f64,
    }

    #[repr(C)]
    struct PdhFmtCountervalueItemW {
        sz_name: *mut u16,
        fmt_value: PdhFmtCountervalue,
    }

    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(
            szDataSource: *const u16,
            dwUserData: usize,
            phQuery: *mut isize,
        ) -> u32;
        fn PdhAddEnglishCounterW(
            hQuery: isize,
            szFullCounterPath: *const u16,
            dwUserData: usize,
            phCounter: *mut isize,
        ) -> u32;
        fn PdhCollectQueryData(hQuery: isize) -> u32;
        fn PdhGetFormattedCounterArrayW(
            hCounter: isize,
            dwFormat: u32,
            lpdwBufferSize: *mut u32,
            lpdwItemCount: *mut u32,
            ItemBuffer: *mut u8,
        ) -> u32;
        fn PdhCloseQuery(hQuery: isize) -> u32;
    }

    struct GpuQuery {
        query: isize,
        counter: isize,
        last_success: std::time::Instant,
    }

    static GPU_STATE: Mutex<Option<GpuQuery>> = Mutex::new(None);

    const PDH_FMT_DOUBLE: u32 = 0x00000200;

    pub fn percent() -> u32 {
        let mut state = match GPU_STATE.lock() {
            Ok(s) => s,
            Err(_) => return 0,
        };

        let now = std::time::Instant::now();
        let need_reopen = match &*state {
            Some(q) => now.duration_since(q.last_success).as_secs() > 180,
            None => true,
        };

        if need_reopen {
            if let Some(old) = state.take() {
                unsafe { PdhCloseQuery(old.query); }
            }
            let mut q: isize = 0;
            let mut c: isize = 0;
            unsafe {
                if PdhOpenQueryW(std::ptr::null(), 0, &mut q) == 0 {
                    let path = w!("\\GPU Engine(*)\\Utilization Percentage");
                    if PdhAddEnglishCounterW(q, path.as_ptr(), 0, &mut c) == 0 {
                        PdhCollectQueryData(q);
                        *state = Some(GpuQuery {
                            query: q,
                            counter: c,
                            last_success: now,
                        });
                        return 0; // Baseline initialized
                    } else {
                        PdhCloseQuery(q);
                    }
                }
            }
            return 0;
        }

        let q_ref = match state.as_mut() {
            Some(q) => q,
            None => return 0,
        };

        unsafe {
            if PdhCollectQueryData(q_ref.query) != 0 {
                let old = state.take().unwrap();
                PdhCloseQuery(old.query);
                return 0;
            }

            let mut buf_size: u32 = 0;
            let mut item_count: u32 = 0;
            let _ = PdhGetFormattedCounterArrayW(
                q_ref.counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                std::ptr::null_mut(),
            );

            if buf_size == 0 || item_count == 0 {
                return 0;
            }

            let mut buf: Vec<u8> = vec![0u8; buf_size as usize];
            let status = PdhGetFormattedCounterArrayW(
                q_ref.counter,
                PDH_FMT_DOUBLE,
                &mut buf_size,
                &mut item_count,
                buf.as_mut_ptr(),
            );

            if status != 0 {
                return 0;
            }

            q_ref.last_success = now;

            let item_size = std::mem::size_of::<PdhFmtCountervalueItemW>();
            let mut total_pct = 0.0f64;

            for i in 0..(item_count as usize) {
                let offset = i * item_size;
                if offset + item_size <= buf.len() {
                    let item = &*(buf.as_ptr().add(offset) as *const PdhFmtCountervalueItemW);
                    if item.fmt_value.c_status == 0 {
                        total_pct += item.fmt_value.double_value;
                    }
                }
            }

            total_pct.round().clamp(0.0, 100.0) as u32
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod gpu {
    pub fn percent() -> u32 {
        0
    }
}

#[cfg(target_os = "windows")]
fn disk_percent() -> u32 {
    use windows::core::w;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    unsafe {
        let _ = GetDiskFreeSpaceExW(
            w!("C:\\"),
            Some(&mut avail),
            Some(&mut total),
            Some(&mut free),
        );
    }
    if total == 0 {
        0
    } else {
        (100 - free * 100 / total) as u32
    }
}

#[cfg(target_os = "windows")]
pub fn battery_info() -> (i32, bool) {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st = SYSTEM_POWER_STATUS::default();
    unsafe {
        let _ = GetSystemPowerStatus(&mut st);
    }
    let pct = if st.BatteryLifePercent == 255 {
        -1
    } else {
        st.BatteryLifePercent as i32
    };
    (pct, st.ACLineStatus == 1)
}

// Smart Mode Check: Returns true if the active foreground window is Maximized (IsZoomed) OR Fullscreen!
#[cfg(target_os = "windows")]
pub fn foreground_is_fullscreen() -> bool {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsZoomed,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == HWND::default() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class);
        let name = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if matches!(
            name.as_str(),
            "Progman"
                | "WorkerW"
                | "Shell_TrayWnd"
                | "Shell_SecondaryTrayWnd"
                | "Windows.UI.Core.CoreWindow"
                | "XamlExplorerHostIslandWindow"
                | "Shell_InputSwitchTopLevel"
                | "MultitaskingViewFrame"
        ) {
            return false;
        }
        // Ignore our own Island or Settings window, or screenshot clipping overlays
        let mut title_buf = [0u16; 64];
        let tn = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..tn.max(0) as usize]);
        let title_lower = title.to_lowercase();
        if title.contains("Inex Island")
            || title_lower.contains("snipping")
            || title_lower.contains("screen clipping")
            || title_lower.contains("snip & sketch")
            || title_lower.contains("screenshot")
        {
            return false;
        }

        // Check process image name to never hide during screenshots or for our own app
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            use windows::core::PWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 260];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    let exe = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                    if exe.ends_with("snippingtool.exe")
                        || exe.ends_with("screenclippinghost.exe")
                        || exe.contains("screensketch")
                        || exe.ends_with("sharex.exe")
                        || exe.ends_with("lightshot.exe")
                        || exe.ends_with("flameshot.exe")
                        || exe.ends_with("inex-island.exe")
                    {
                        let _ = CloseHandle(h);
                        return false;
                    }
                }
                let _ = CloseHandle(h);
            }
        }

        // 1. Check if window is Maximized (like YouTube / Chrome / Explorer in video)
        if IsZoomed(hwnd).as_bool() {
            return true;
        }

        // 2. Check if window covers the full monitor (F11 / game fullscreen)
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return false;
        }
        r.left <= mi.rcMonitor.left
            && r.top <= mi.rcMonitor.top
            && r.right >= mi.rcMonitor.right
            && r.bottom >= mi.rcMonitor.bottom
    }
}

// Only the figures Windows cannot push (it has no "CPU % changed" event): sampled, and only while
// a load widget is on screen. Battery, Wi-Fi and fullscreen are NOT read here: they arrive as events.
#[derive(Serialize)]
pub struct SysLoad {
    pub ram_pct: u32,
    pub ram_used_gb: f32,
    pub cpu_pct: u32,
    pub gpu_pct: u32,
    pub disk_pct: u32,
}

#[allow(unused_assignments)]
#[tauri::command]
pub async fn get_sys_load() -> SysLoad {
    let (mut ram_pct, mut cpu_pct, mut gpu_pct, mut disk_pct) = (0, 0, 0, 0);
    let mut ram_used_gb = 0.0f32;
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut mem).is_ok() {
            ram_pct = mem.dwMemoryLoad;
            ram_used_gb = ((mem.ullTotalPhys - mem.ullAvailPhys) as f64 / 1_073_741_824.0) as f32;
        }
        cpu_pct = cpu_percent();
        gpu_pct = gpu::percent();
        disk_pct = disk_percent();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (&mut ram_pct, &mut cpu_pct, &mut gpu_pct, &mut disk_pct);
    SysLoad { ram_pct, ram_used_gb, cpu_pct, gpu_pct, disk_pct }
}

#[allow(unused_assignments)]
#[tauri::command]
pub async fn get_sys_stats() -> SysStats {
    let mut ram_pct = 0;
    let (mut ram_used_gb, mut ram_total_gb) = (0.0f32, 0.0f32);
    let (mut cpu_pct, mut gpu_pct, mut disk_pct, mut battery_pct, mut charging) = (0, 0, 0, -1, false);
    let mut is_fullscreen = false;
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut mem).is_ok() {
            ram_pct = mem.dwMemoryLoad;
            let total = mem.ullTotalPhys as f64;
            let avail = mem.ullAvailPhys as f64;
            ram_total_gb = (total / 1_073_741_824.0) as f32;
            ram_used_gb = ((total - avail) / 1_073_741_824.0) as f32;
        }
        cpu_pct = cpu_percent();
        gpu_pct = gpu::percent();
        disk_pct = disk_percent();
        (battery_pct, charging) = battery_info();
        is_fullscreen = foreground_is_fullscreen();
    }

    // Wi-Fi name + signal straight from the native WLAN API (no netsh process any more)
    let mut wifi_name = String::from("Not connected");
    let wifi_on = true;
    let mut wifi_signal: u32 = 0;
    if crate::wifi::is_running() && !crate::startup::system_shutting_down() {
        if let Some((name, sig)) = crate::live::wifi_now() {
            wifi_name = name;
            wifi_signal = sig;
        }
    }

    SysStats {
        ram_pct,
        ram_used_gb,
        ram_total_gb,
        cpu_pct,
        gpu_pct,
        disk_pct,
        battery_pct,
        charging,
        wifi_name,
        wifi_signal,
        wifi_on,
        is_fullscreen,
    }
}
