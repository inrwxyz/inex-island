# Architecture Overview

Inex Island is structured as a thin, strict TypeScript UI running inside a fixed-size transparent WebView2 overlay paired with a multi-threaded native Rust/Win32 backend built on Tauri v2.

## 1. System Topology

```
+-------------------------------------------------------------------+
| Windows OS APIs (Win32, COM, WinRT, WMI, Core Audio, Event Log)   |
+-------------------+-----------------------------------------------+
                    | Native events / async IPC commands
+-------------------v-----------------------------------------------+
| Rust Backend (src-tauri/src/)                                     |
|  - Window & Hit-Testing: island_window.rs, settings_win.rs        |
|  - Event Push Loops:     live.rs, audio_events.rs, native_events  |
|  - Conditional Samplers: sys_stats.rs, visualizer.rs              |
|  - Subsystems:           media, bluetooth, wifi, clipboard,       |
|                          screentime, session_history, webget,     |
|                          spotlight, quick_share/                  |
+-------------------+-----------------------------------------------+
                    | Tauri IPC invoke() & emit()
+-------------------v-----------------------------------------------+
| WebView2 Frontend (Vite 8 + Strict TypeScript + Modular CSS)      |
|  - src/main.ts         -> Notch views, Control Deck, Popups/HUDs  |
|  - src/settings.ts     -> Standalone Settings window              |
|  - src/shared.ts       -> Theme CSS vars, settings store, sync    |
|  - src/js/core/        -> EventBus, AppState, Tauri bridge, views |
|  - src/js/features/    -> Self-contained feature controllers      |
+-------------------------------------------------------------------+
```

## 2. Windowing & Hit-Testing (`island_window.rs`)

Resizing a transparent layered window on every frame of an animation causes DWM composition stalls and horizontal jitter. Instead:

1. **Single-Call Geometry**: `place_island()` calculates the centered monitor bounding box and applies size + position atomically using Win32 `SetWindowPos` (`SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER`).
2. **Dynamic Click-Through Probe**: `start_hit_poller()` reads the physical cursor coordinates via `GetCursorPos` and compares against the active pill/deck logical bounds scaled by monitor DPI.
   - Outside the pill -> `set_ignore_cursor_events(true)` passes every click straight through to desktop applications underneath.
   - Inside the pill -> `set_ignore_cursor_events(false)` captures pointer interaction and emits `island_pointer` events.
   - Adaptive sleep -> `16ms` while the cursor is within `120px` of the island, dropping to `70ms` everywhere else.

## 3. Event-Driven vs. Conditional Polling

Background CPU usage stays near zero when idle because state updates rely on OS push notifications wherever Windows supports them:

| Domain | Mechanism | Trigger Behavior |
| --- | --- | --- |
| **Power & Battery** | `WM_POWERBROADCAST` + Win32 power callbacks (`live.rs`) | Pushes charger / percentage changes without loops |
| **Radios (Wi-Fi / BT)** | WinRT radio watchers & WLAN notifications (`live.rs`, `radios.rs`) | Updates state only on adapter or link change |
| **Session Lock / Resume** | Hidden message window (`native_events.rs`) | Receives `WM_WTSSESSION_CHANGE` & shutdown signals |
| **Audio Volume & Devices** | COM `IAudioEndpointVolumeCallback` & `IMMNotificationClient` (`audio_events.rs`) | Wakes UI only on mute/volume/default-device change |
| **Display Brightness** | WMI `WmiMonitorBrightnessEvent` (`brightness.rs`) | Ignores self-echo for 2s, emits OS-initiated changes |
| **Clipboard** | `WM_CLIPBOARDUPDATE` + image/screenshot watcher (`clipboard.rs`) | Fires on copy events only |
| **CPU / GPU / Disk / Net** | `sys_stats.rs` (`GetSystemTimes`, PDH, `GetDiskFreeSpaceExW`) | Invoked by frontend only while Stats / Widgets panels are active |
| **5-Band Visualizer** | Core Audio loopback + `rustfft` (`visualizer.rs`) | Paused when media is stopped or compact visualizer is hidden |

## 4. Strict TypeScript Modular Design

- **No Virtual DOM Overhead**: Every interactive view (`view-compact`, `view-control`, `view-control-deck`, `view-clipboard`, `view-p2p`, etc.) uses pre-rendered semantic HTML + GPU-friendly CSS transitions controlled by typed TypeScript modules (`src/js/core/views.ts`).
- **Central Store & EventBus**:
  - `src/js/core/state.ts` holds `appState` typed against `AppState` in `src/types/models.ts` and emits fine-grained `state:<key>` and `state:change` events.
  - `src/js/core/bus.ts` decouples feature panels (e.g., closing Spotlight, Prayer, or Tray panels when switching Control Deck tabs).
- **Cross-Window Synchronization**: `src/shared.ts` serializes settings to `localStorage` (`inex.settings.v1`) and broadcasts updates between the main overlay window and `settings.html` via Tauri's `settings_changed` / `settings-changed` IPC bridge.

## 5. Verification & Build Pipeline

- **CSS Assembly**: `scripts/build-styles.mjs` concatenates `styles-parts/*.css` into `src/styles.css`.
- **Frontend Bundle**: Vite 8 compiles `src/main.ts`, `src/settings.ts`, and `src/shared.ts` with `tsc --noEmit` strict typechecking (`strict: true`, `allowJs: false`).
- **Automated Tests**:
  - `npm test` (Vitest): Unit tests for coordinate/theme calculation, settings migration, clock/solar math, spotlight URL resolution, clipboard hashing, and currency formatting.
  - `npm run test:rust` (`cargo test`): Unit tests covering clipboard DIB generation, WAV chime synthesis, file transfer safety/chunking, session history `wevtapi` parsing, URL sanitization, HTTP host allowlisting, Bluetooth classification, and Screen Time path filtering.
  - `npm run test:golden`: Builds `dist/`, runs Playwright against `index.html` & `settings.html` with a deterministic mocked Tauri bridge, exercises runtime tab interactions, verifies zero console/page errors, and compares 5 baseline views pixel-for-pixel via `pixelmatch`.
