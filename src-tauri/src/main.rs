#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod audio;
mod bluetooth;
mod brightness;
mod clipboard;
mod island_window;
mod live;
mod locker_bridge;
mod media;
mod net;
mod nexus_bridge;
mod privacy;
mod radios;
mod screentime;
mod session_history;
mod settings_win;
mod shelf;
mod sounds;
mod spotlight;
mod startup;
mod sys_stats;
mod updater;
mod visualizer;
mod volume;
mod webget;
mod wifi;
#[cfg(target_os = "windows")]
mod winreg;

pub mod quick_share;
pub use quick_share::{console, crypto, events, mdns, protos};
#[cfg(target_os = "windows")]
mod native_events;
#[cfg(target_os = "windows")]
mod audio_events;

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn main() {
    std::panic::set_hook(Box::new(|info| {
        startup::log(&format!("PANIC: {}", info));
    }));
    let autostarted = std::env::args().any(|a| a == "--autostart");
    startup::log(&format!("start (autostart={})", autostarted));

    // Started by Windows at login: wait a little so the desktop, taskbar and WebView2 are ready
    // (laptops are slower at boot).
    if autostarted {
        std::thread::sleep(Duration::from_secs(5));
    }

    // SINGLE INSTANCE GUARD: only exit if a REAL Inex Island answers. Anything else on this
    // port (or a dead leftover) must not make the app quit silently.
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:49871".parse().unwrap(),
        Duration::from_millis(800),
    ) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
        let _ = stream.write_all(b"OPEN_SETTINGS");
        let mut buf = [0u8; 8];
        let n = stream.read(&mut buf).unwrap_or(0);
        if &buf[..n] == b"INEX" {
            startup::log("another instance is running, exiting");
            return;
        }
        startup::log("port 49871 answered but not Inex Island, starting anyway");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| {
                settings_win::drop_stale_autostart();
                // Self-heal: if "Launch at Login" is on, rewrite the entry on every start
                // (fixes moved exe, entries Windows disabled, entries deleted by cleaners).
                if startup::data_dir().join("autostart.on").exists() {
                    settings_win::register_autostart();
                }
                net::clean_stage();
            });

            // Event-driven watchers (radio on/off, now-playing) - replaces fast polling
            live::start(app.handle().clone());
            brightness::start(app.handle().clone());
            shelf::setup_shelf_drop(app.handle().clone());
            visualizer::setup_audio_visualization(app.handle().clone());
            locker_bridge::start(app.handle().clone());
            nexus_bridge::start(app.handle().clone());
            clipboard::start_screenshot_watch(app.handle().clone());
            screentime::start();

            #[cfg(target_os = "windows")]
            {
                native_events::setup_native_events(app.handle().clone());
                audio_events::start(app.handle().clone());
                live::set_radio_active("bt", true);
                bluetooth::start(app.handle().clone());
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_decorations(false);
                // The window starts hidden (tauri.conf.json). Place it first, then show it,
                // so it never appears in the wrong spot. The page plays the intro animation.
                let w = window.clone();
                std::thread::spawn(move || {
                    let mut placed = island_window::place_island(
                        &w,
                        island_window::FIXED_WIN_W,
                        island_window::FIXED_WIN_H,
                    );
                    let mut tries = 0;
                    while !placed && tries < 10 {
                        std::thread::sleep(Duration::from_millis(50));
                        placed = island_window::place_island(
                            &w,
                            island_window::FIXED_WIN_W,
                            island_window::FIXED_WIN_H,
                        );
                        tries += 1;
                    }
                    island_window::start_hit_poller(w.clone(), island_window::FIXED_WIN_W);
                    let _ = w.show();
                });
            }

            // Windows shutting down / logging off: native_events.rs reacts to WM_ENDSESSION and exits
            // at once, so no helper process (netsh, powershell...) is started while the system closes
            // (that is what shows "The application was unable to start correctly (0xc0000142)").

            // Listen for second-launch signal (when user clicks Desktop Shortcut)
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(listener) = TcpListener::bind("127.0.0.1:49871") {
                    for stream in listener.incoming().flatten() {
                        let mut s = stream;
                        let mut buf = [0u8; 32];
                        let _ = s.read(&mut buf);
                        let _ = s.write_all(b"INEX");
                        settings_win::show_settings_window(&handle);
                    }
                }
            });

            // System Tray Icon & Menu (Open Settings / Restart / Quit)
            let open_i = MenuItem::with_id(app, "settings", "Open Settings", true, None::<&str>)?;
            let restart_i =
                MenuItem::with_id(app, "restart", "Restart Inex Island", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Inex Island", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &restart_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Inex Island")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        let h = app.clone();
                        std::thread::spawn(move || settings_win::show_settings_window(&h));
                    }
                    "restart" => {
                        screentime::save();
                        app.restart();
                    }
                    "quit" => {
                        screentime::save();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let h = tray.app_handle().clone();
                        std::thread::spawn(move || settings_win::show_settings_window(&h));
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _ = tray_builder.build(app);

            let handle = app.handle().clone();
            quick_share::events::add_listener(move |evt| {
                let _ = handle.emit("qs-event", evt);
                let _ = handle.emit("quickshare-event", evt);
                let _ = handle.emit("inexdrop-event", evt);
                if let Some(t) = evt.get("type").and_then(|t| t.as_str()) {
                    let _ = handle.emit(t, evt);
                    if t == "offer" {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                }
            });

            #[cfg(windows)]
            quick_share::ensure_firewall();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quick_share::get_status,
            quick_share::start_server,
            quick_share::stop_server,
            quick_share::start_scan,
            quick_share::stop_scan,
            quick_share::respond_offer,
            quick_share::control_transfer,
            quick_share::pick_files,
            quick_share::pick_folder,
            quick_share::send_files,
            quick_share::open_downloads,
            spotlight::spotlight_detect_browsers,
            spotlight::spotlight_open,
            island_window::set_island_hit,
            island_window::pet_probe,
            settings_win::trigger_companion_demo,
            settings_win::trigger_animation_demo,
            clipboard::clipboard_seq,
            clipboard::get_clipboard_text,
            clipboard::set_clipboard_text,
            clipboard::set_clipboard_image,
            clipboard::get_clipboard_files,
            clipboard::set_clipboard_files,
            clipboard::filter_screenshot_paths,
            clipboard::filter_existing_paths,
            clipboard::read_screenshot_bytes,
            clipboard::read_image_file,
            sys_stats::get_net_speed,
            privacy::privacy_watch_start,
            island_window::focus_island,
            settings_win::open_settings,
            settings_win::close_settings,
            settings_win::drag_settings,
            sounds::play_alarm_sound,
            sounds::start_alarm_loop,
            sounds::stop_alarm_sound,
            sounds::play_status_sound,
            settings_win::restart_app,
            settings_win::settings_changed,
            settings_win::set_autostart,
            bluetooth::get_bt_battery,
            bluetooth::get_bt_batteries,
            bluetooth::bt_discovery,
            bluetooth::get_bt_nearby,
            bluetooth::bt_pair,
            bluetooth::bt_pair_answer,
            bluetooth::bt_unpair,
            brightness::get_system_brightness,
            media::get_media_status,
            media::seek_media,
            media::media_play_pause,
            media::media_next,
            media::media_prev,
            volume::set_system_volume,
            volume::get_system_volume,
            volume::set_media_app_volume,
            volume::get_media_app_volume,
            media::get_media_art,
            radios::get_radio_state,
            radios::get_radio_present,
            radios::set_radio_state,
            brightness::set_system_brightness,
            sys_stats::get_sys_stats,
            sys_stats::get_sys_load,
            wifi::get_wifi_networks,
            wifi::connect_wifi_network,
            wifi::wifi_join,
            wifi::wifi_forget,
            wifi::get_wifi_status,
            wifi::disconnect_wifi,
            wifi::wifi_rescan,
            radios::wifi_backend,
            radios::bt_backend,
            volume::get_mic_muted,
            volume::set_mic_muted,
            actions::set_keep_awake,
            bluetooth::get_bt_devices,
            visualizer::set_visualizer_active,
            actions::open_bt_settings,
            actions::open_wifi_settings,
            actions::open_location_settings,
            actions::open_url,
            actions::lock_screen,
            actions::take_snip,
            actions::launch_quick_action,
            audio::get_audio_devices,
            audio::set_default_audio_device,
            audio::open_sound_settings,
            bluetooth::bt_set_connection,
            net::file_info,
            net::read_file_chunk,
            net::recv_begin,
            net::recv_chunk,
            net::recv_end,
            net::recv_abort,
            net::drag_out_file,
            island_window::setup_shelf_drop,
            quick_share::start_quick_share,
            quick_share::stop_quick_share,
            quick_share::get_quick_share_status,
            quick_share::start_quick_share_scan,
            quick_share::stop_quick_share_scan,
            quick_share::send_quick_share_files,
            quick_share::respond_quick_share_offer,
            quick_share::control_quick_share,
            quick_share::open_quick_share_downloads,
            quick_share::choose_quick_share_save_dir,
            quick_share::set_quick_share_save_dir,
            quick_share::get_quick_share_save_dir,
            quick_share::pick_quick_share_files,
            quick_share::pick_quick_share_folder,
            quick_share::stage_quick_share_files,
            quick_share::get_staged_quick_share_files,
            quick_share::clear_staged_quick_share_files,
            quick_share::stage_file_for_phone,
            quick_share::clear_staged_files,
            quick_share::start_inex_drop,
            quick_share::stop_inex_drop,
            quick_share::get_inex_drop_status,
            quick_share::respond_inex_transfer,
            updater::check_update,
            updater::get_app_version,
            updater::apply_update,
            screentime::get_screen_time_today,
            screentime::get_screen_time_history,
            screentime::set_screen_time_enabled,
            screentime::clear_screen_time,
            screentime::get_app_icons,
            session_history::get_pc_session_history,
            webget::http_get
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
