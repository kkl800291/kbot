use serde_json::{json, Value};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

// A single settings context is kept alive when closed or minimized. The main
// window remains the sole owner of application state and reminder scheduling.
#[derive(Default)]
pub struct SettingsWindowGate(tokio::sync::Mutex<()>);

fn page_name(page: &str) -> &str {
    match page {
        "general" | "agent" | "voice" | "sense" | "chat" => page,
        _ => "general",
    }
}

fn visibility(app: &tauri::AppHandle, visible: bool) {
    let _ = app.emit_to("main", "settings-visibility", visible);
}

pub fn hide_settings(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        // Flush fields that only commit on blur before the context is hidden.
        let _ = window.emit("settings-closed", ());
        window.hide().map_err(|error| error.to_string())?;
    }
    visibility(app, false);
    Ok(())
}

#[tauri::command]
pub async fn open_settings_window(
    app: tauri::AppHandle,
    page: Option<String>,
    gate: State<'_, SettingsWindowGate>,
) -> Result<(), String> {
    let _guard = gate.0.lock().await;
    if let Some(window) = app.get_webview_window("settings") {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        // An empty page means retain the current category, form and scroll.
        let requested = page.as_deref().map(page_name).unwrap_or("");
        window
            .emit("settings-open", requested)
            .map_err(|error| error.to_string())?;
    } else {
        let route = page.as_deref().map(page_name).unwrap_or("general");
        WebviewWindowBuilder::new(
            &app,
            "settings",
            WebviewUrl::App(format!("index.html?view=settings&page={route}").into()),
        )
        .title("KBOT · 设置")
        .inner_size(780.0, 660.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .decorations(true)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .closable(true)
        .always_on_top(false)
        .visible_on_all_workspaces(false)
        .skip_taskbar(false)
        .shadow(true)
        .focusable(true)
        .focused(true)
        .visible(true)
        .build()
        .map_err(|error| error.to_string())?;
    }
    visibility(&app, true);
    Ok(())
}

pub fn state(app: &tauri::AppHandle) -> Value {
    let settings = app.get_webview_window("settings");
    let main = app.get_webview_window("main");
    json!({
        "visible": settings.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false)),
        "minimized": settings.as_ref().is_some_and(|w| w.is_minimized().unwrap_or(false)),
        "fullscreen": settings.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false)),
        "mainVisible": main.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false)),
        "mainFullscreen": main.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false)),
        "mainMinimized": main.as_ref().is_some_and(|w| w.is_minimized().unwrap_or(false)),
    })
}

#[tauri::command]
pub async fn settings_window_action(
    app: tauri::AppHandle,
    action: String,
) -> Result<Value, String> {
    if action == "state" {
        return Ok(state(&app));
    }
    let window = app
        .get_webview_window("settings")
        .ok_or("设置窗口尚未打开")?;
    match action.as_str() {
        "close" => hide_settings(&app)?,
        "minimize" => {
            let _ = window.emit("settings-closed", ());
            window.minimize().map_err(|error| error.to_string())?;
            visibility(&app, false);
        }
        "fullscreen" => {
            let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
            window
                .set_fullscreen(!fullscreen)
                .map_err(|error| error.to_string())?;
        }
        "restore" => {
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            visibility(&app, true);
        }
        _ => return Err("未知的设置窗口操作".into()),
    }
    // These native operations are asynchronous on macOS. Yield rather than
    // blocking the main thread so the returned snapshot can observe the change.
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    Ok(state(&app))
}

#[cfg(test)]
mod tests {
    use super::page_name;

    #[test]
    fn only_known_settings_categories_are_used_in_window_urls() {
        assert_eq!(page_name("agent"), "agent");
        assert_eq!(page_name("voice"), "voice");
        assert_eq!(page_name("../../index.html?view=other"), "general");
    }
}
