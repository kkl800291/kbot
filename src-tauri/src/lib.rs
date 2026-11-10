mod desktop;
mod files;
mod interaction_diagnostics;
mod knowledge;
mod mcp;
mod model_protocol;
mod network;
mod page;
mod settings_window;
mod storage;
mod voice;

use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

#[tauri::command]
fn desktop_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
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
    let mut data = vec![0u8; 22 * 22 * 4];
    for y in 0..22 {
        for x in 0..22 {
            let outline = (3..19).contains(&x)
                && (5..18).contains(&y)
                && !(5..17)
                    .contains(&x)
                    .then_some((7..16).contains(&y))
                    .unwrap_or(false);
            let eyes = ((7..9).contains(&x) || (13..15).contains(&x)) && (9..13).contains(&y);
            let antenna = x == 10 && (2..5).contains(&y);
            if outline || eyes || antenna {
                data[(y * 22 + x) * 4 + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(data, 22, 22)
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
        .manage(network::Requests::default())
        .manage(settings_window::SettingsWindowGate::default())
        .manage(mcp::McpHub::default())
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
            let reminders = MenuItem::with_id(app, "reminders", "提醒列表…", true, None::<&str>)?;
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
                    &reminders,
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
            network::chat_stream,
            network::cancel_chat,
            network::test_model,
            network::list_models,
            network::search_web,
            network::weather_get,
            network::city_search,
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
            page::read_page,
            files::list_folder,
            files::read_file,
            files::write_file,
            files::move_file,
            mcp::mcp_start,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_stop,
            mcp::mcp_save_secret,
            mcp::mcp_delete_secrets,
            knowledge::knowledge_update,
            knowledge::knowledge_search,
            knowledge::knowledge_remove,
            voice::voice_speak,
            voice::voice_stop,
            voice::voice_list,
            voice::voice_permission_status
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
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.emit("desktop-action", "chat");
                }
            }
        });
}
