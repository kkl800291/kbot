mod desktop;
mod dsh;
mod interaction_diagnostics;
mod settings_window;
mod storage;
mod updater;
mod voice;
mod weather;

use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

#[tauri::command]
fn desktop_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle, dsh: tauri::State<'_, dsh::DshManager>) {
    dsh.shutdown_blocking();
    app.exit(0);
}

// Disabled in release builds. Smoke runs use a separate bundle identifier and Keychain service.
#[tauri::command]
fn debug_smoke_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("COMPANION_SMOKE").as_deref() == Ok("1")
        && std::env::var("COMPANION_SMOKE_AUTO").as_deref() != Ok("0")
}
#[tauri::command]
fn debug_smoke_report(
    window: tauri::WebviewWindow,
    mut report: serde_json::Value,
) -> Result<(), String> {
    if !debug_smoke_enabled() {
        return Err("仅用于隔离开发验证".into());
    }
    report["native"] = serde_json::json!({
        "visible": window.is_visible().unwrap_or(false), "onTop": window.is_always_on_top().unwrap_or(false),
        "scale": window.scale_factor().unwrap_or(0.0), "size": window.inner_size().ok(),
    });
    std::fs::write(
        std::env::temp_dir().join("companion-native-smoke.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn tray_image() -> tauri::image::Image<'static> {
    // 36 px renders at the 18 pt menu-bar height as an exact 2x bitmap.
    const S: usize = 36;
    let rounded = |px: f64, py: f64, cx: f64, cy: f64, hw: f64, hh: f64, r: f64| {
        let dx = ((px - cx).abs() - (hw - r)).max(0.0);
        let dy = ((py - cy).abs() - (hh - r)).max(0.0);
        dx * dx + dy * dy <= r * r
    };
    let inside = |px: f64, py: f64| {
        let body = (px - 18.0).powi(2) + (py - 18.0).powi(2) <= 15.0_f64.powi(2);
        let eye = rounded(px, py, 14.0, 18.0, 1.6, 3.8, 1.6)
            || rounded(px, py, 22.0, 18.0, 1.6, 3.8, 1.6);
        body && !eye
    };
    let mut data = vec![0u8; S * S * 4];
    for y in 0..S {
        for x in 0..S {
            let mut hits = 0u32;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = x as f64 + (sx as f64 + 0.5) / 4.0;
                    let py = y as f64 + (sy as f64 + 0.5) / 4.0;
                    hits += inside(px, py) as u32;
                }
            }
            data[(y * S + x) * 4 + 3] = (hits * 255 / 16) as u8;
        }
    }
    tauri::image::Image::new_owned(data, S as u32, S as u32)
}

#[cfg(test)]
mod tests {
    use super::tray_image;

    #[test]
    fn tray_icon_is_a_round_template_with_transparent_eyes() {
        let image = tray_image();
        assert_eq!((image.width(), image.height()), (36, 36));
        let rgba = image.rgba();
        assert_eq!(rgba.len(), 36 * 36 * 4);
        let alpha = |x: usize, y: usize| rgba[(y * 36 + x) * 4 + 3];

        assert_eq!(alpha(18, 18), 255, "solid bridge between the eyes");
        assert_eq!(alpha(14, 18), 0, "left eye is transparent");
        assert_eq!(alpha(22, 18), 0, "right eye is transparent");
        for (x, y) in [(0, 18), (35, 18), (18, 0), (18, 35), (7, 29)] {
            assert_eq!(alpha(x, y), 0, "outside the round silhouette");
        }
        assert!(rgba.chunks_exact(4).all(|px| px[..3] == [0, 0, 0]));
        assert!(rgba.chunks_exact(4).any(|px| px[3] > 0 && px[3] < 255));
        for y in 0..36 {
            for x in 0..36 {
                assert_eq!(alpha(x, y), alpha(35 - x, y));
                assert_eq!(alpha(x, y), alpha(x, 35 - y));
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let desktop: desktop::Desktop = Arc::new(Mutex::new(desktop::DesktopState::default()));
    let sensor_state = desktop.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.emit("desktop-action", "chat");
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(desktop)
        .manage(storage::StorageLock::default())
        .manage(dsh::DshManager::default())
        .manage(settings_window::SettingsWindowGate::default())
        .manage(voice::Speech::default())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            let w = app.get_webview_window("main").expect("main window");
            desktop::fit_monitor(&w, false)?;
            w.set_focusable(false)?;
            w.set_ignore_cursor_events(true)?;
            let show = MenuItem::with_id(app, "visibility", "显示／隐藏伙伴", true, None::<&str>)?;
            let chat = MenuItem::with_id(app, "chat", "打开聊天", true, None::<&str>)?;
            let workspace = MenuItem::with_id(app, "workspace", "打开养成目录", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
            let move_screen =
                MenuItem::with_id(app, "move", "移到鼠标所在屏幕", true, None::<&str>)?;
            let dnd = MenuItem::with_id(app, "dnd", "勿扰 30 分钟／结束勿扰", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 KBOT", true, Some("CmdOrCtrl+Q"))?;
            let sep = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &chat,
                    &show,
                    &move_screen,
                    &sep,
                    &dnd,
                    &workspace,
                    &settings,
                    &sep2,
                    &quit,
                ],
            )?;
            TrayIconBuilder::with_id("companion")
                .icon(tray_image())
                .icon_as_template(true)
                .tooltip("KBOT")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, ev| {
                    if let Some(w) = app.get_webview_window("main") {
                        if ev.id.as_ref() == "move" {
                            let _ = desktop::fit_monitor(&w, true);
                            let _ = w.emit("desktop-action", "reposition");
                        } else {
                            let _ = w.emit("desktop-action", ev.id.as_ref());
                        }
                    }
                })
                .build(app)?;
            desktop::poll(app.handle(), sensor_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_ready,
            quit_app,
            debug_smoke_enabled,
            debug_smoke_report,
            interaction_diagnostics::interaction_trace_enabled,
            interaction_diagnostics::write_interaction_trace,
            storage::load_state,
            storage::save_state,
            storage::save_key,
            storage::delete_key,
            storage::key_status,
            weather::weather_get,
            weather::city_search,
            dsh::dsh_status,
            dsh::dsh_ensure,
            dsh::dsh_open_console,
            dsh::dsh_restart,
            dsh::dsh_stop,
            dsh::dsh_request,
            dsh::dsh_init_workspace,
            dsh::dsh_open_workspace,
            dsh::dsh_install_desktop_patch,
            desktop::set_regions,
            desktop::configure_sensors,
            desktop::focus_companion,
            desktop::release_focus,
            desktop::set_on_top,
            desktop::hide_companion,
            desktop::move_to_cursor,
            desktop::screen_permission,
            desktop::capture_screen,
            settings_window::open_settings_window,
            settings_window::settings_window_action,
            voice::voice_speak,
            voice::voice_stop,
            voice::voice_list,
            voice::voice_permission_status,
            updater::check_app_update,
            updater::install_app_update
        ])
        .on_window_event(|window, event| {
            if window.label() == "settings" && matches!(event, tauri::WindowEvent::Focused(false)) {
                // Native miniaturization and application switching do not
                // necessarily blur the focused DOM input themselves.
                let _ = window.emit("settings-blur", ());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "settings" {
                    let _ = settings_window::hide_settings(window.app_handle());
                } else {
                    let _ = window.emit("desktop-action", "hide");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("could not build cyber companion")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<dsh::DshManager>().shutdown_blocking();
                app.state::<voice::Speech>().stop_active();
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.emit("desktop-action", "chat");
                }
            }
        });
}
