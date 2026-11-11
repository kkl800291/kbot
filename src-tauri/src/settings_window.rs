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

// App theme, not the system appearance, decides the window chrome so the
// traffic lights and native controls match the page.
fn window_theme(name: &str) -> Option<tauri::Theme> {
    match name {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

const TITLE: &str = "KBOT · 设置";

// AppKit moves the traffic lights back to their default spot when the
// appearance changes. tao re-applies the configured inset after a title
// change, so setting the same title restores the custom position.
fn set_window_theme(window: &tauri::WebviewWindow, theme: tauri::Theme) -> tauri::Result<()> {
    window.set_theme(Some(theme))?;
    window.set_title(TITLE)
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
    theme: Option<String>,
    gate: State<'_, SettingsWindowGate>,
) -> Result<(), String> {
    let _guard = gate.0.lock().await;
    if let Some(window) = app.get_webview_window("settings") {
        if let Some(theme) = theme.as_deref().and_then(window_theme) {
            let _ = set_window_theme(&window, theme);
        }
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
        let builder = WebviewWindowBuilder::new(
            &app,
            "settings",
            WebviewUrl::App(format!("index.html?view=settings&page={route}").into()),
        );
        // The sidebar runs under transparent window chrome, like System Settings.
        #[cfg(target_os = "macos")]
        let builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(20.0, 28.0));
        builder
            .title(TITLE)
            .theme(theme.as_deref().and_then(window_theme))
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
    if let Some(name) = action.strip_prefix("theme:") {
        let theme = window_theme(name).ok_or("未知的主题")?;
        set_window_theme(&window, theme).map_err(|error| error.to_string())?;
        return Ok(state(&app));
    }
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
    use super::{page_name, window_theme};

    #[test]
    fn only_known_settings_categories_are_used_in_window_urls() {
        assert_eq!(page_name("agent"), "agent");
        assert_eq!(page_name("voice"), "voice");
        assert_eq!(page_name("../../index.html?view=other"), "general");
    }

    #[test]
    fn window_chrome_follows_only_known_app_themes() {
        assert_eq!(window_theme("dark"), Some(tauri::Theme::Dark));
        assert_eq!(window_theme("light"), Some(tauri::Theme::Light));
        assert_eq!(window_theme("auto"), None);
    }
}
