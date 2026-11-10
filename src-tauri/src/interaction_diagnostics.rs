use crate::desktop::Desktop;
use serde_json::{json, Value};
use std::io::Write;
use tauri::{Manager, State};

#[tauri::command]
pub fn interaction_trace_enabled() -> bool {
    std::env::var("COMPANION_INTERACTION_TRACE").as_deref() == Ok("1")
}

#[tauri::command]
pub fn write_interaction_trace(
    window: tauri::WebviewWindow,
    snapshot: Value,
    desktop: State<Desktop>,
) -> Result<(), String> {
    if !interaction_trace_enabled() {
        return Err("交互诊断未启用".into());
    }
    let native = desktop.lock().map(|state| json!({"regions":state.regions.len(), "dragging":state.dragging,"interactive":state.interactive,"hidden":state.hidden})).map_err(|_| "状态不可用")?;
    #[cfg(target_os = "macos")]
    let ignores_mouse: Option<bool> = window.ns_window().ok().map(|raw| unsafe {
        use objc::{msg_send, sel, sel_impl};
        let value: bool = msg_send![raw as *mut objc::runtime::Object, ignoresMouseEvents];
        value
    });
    #[cfg(not(target_os = "macos"))]
    let ignores_mouse: Option<bool> = None;
    let report = json!({"version":window.app_handle().package_info().version.to_string(),"pid":std::process::id(),
        "at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        "focused":window.is_focused().ok(),"visible":window.is_visible().ok(),"ignoresMouse":ignores_mouse,
        "native":native,"frontend":snapshot});
    let path = std::env::temp_dir().join(format!("kbot-interaction-{}.json", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
