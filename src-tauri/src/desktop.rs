use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

#[derive(Clone, Deserialize)]
pub struct Region {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    radius: f64,
}
impl Region {
    fn contains(&self, x: f64, y: f64) -> bool {
        if x < self.x || y < self.y || x > self.x + self.w || y > self.y + self.h {
            return false;
        }
        let r = self.radius.min(self.w / 2.0).min(self.h / 2.0).max(0.0);
        let cx = x.clamp(self.x + r, self.x + self.w - r);
        let cy = y.clamp(self.y + r, self.y + self.h - r);
        (x - cx).powi(2) + (y - cy).powi(2) <= r * r
    }
}
#[derive(Clone, Default)]
pub struct DesktopState {
    pub regions: Vec<Region>,
    pub interactive: bool,
    pub dragging: bool,
    pub hidden: bool,
    pub sense_idle: bool,
    pub sense_app: bool,
    pub previous_app: Option<i32>,
}
pub type Desktop = Arc<Mutex<DesktopState>>;

#[tauri::command]
pub fn set_regions(
    regions: Vec<Region>,
    interactive: bool,
    dragging: bool,
    desktop: State<Desktop>,
) {
    if let Ok(mut state) = desktop.lock() {
        state.regions = regions;
        state.interactive = interactive;
        state.dragging = dragging;
    }
}
#[tauri::command]
pub fn configure_sensors(idle: bool, app: bool, desktop: State<Desktop>) {
    if let Ok(mut state) = desktop.lock() {
        state.sense_idle = idle;
        state.sense_app = app;
    }
}
#[tauri::command]
pub fn focus_companion(
    window: tauri::WebviewWindow,
    desktop: State<Desktop>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !window.is_focused().unwrap_or(false) {
        let previous = mac::frontmost_pid();
        if previous != Some(std::process::id() as i32) {
            if let Ok(mut state) = desktop.lock() {
                state.previous_app = previous;
            }
        }
    }
    window.set_focusable(true).map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn release_focus(window: tauri::WebviewWindow, desktop: State<Desktop>) -> Result<(), String> {
    let previous = desktop
        .lock()
        .ok()
        .and_then(|mut state| state.previous_app.take());
    #[cfg(target_os = "macos")]
    if window.is_focused().unwrap_or(false) {
        if let Some(pid) = previous {
            mac::activate(pid);
        }
    }
    window.set_focusable(false).map_err(|e| e.to_string())
}
/// 通知到点时按需读一次键鼠空闲秒数，用户正在操作就等一等再出现。
#[tauri::command]
pub fn idle_seconds() -> f64 {
    #[cfg(target_os = "macos")]
    return mac::idle();
    #[cfg(not(target_os = "macos"))]
    0.0
}
#[tauri::command]
pub fn hide_companion(
    window: tauri::WebviewWindow,
    hidden: bool,
    desktop: State<Desktop>,
) -> Result<(), String> {
    if let Ok(mut state) = desktop.lock() {
        state.hidden = hidden;
    }
    if hidden { window.hide() } else { window.show() }.map_err(|e| e.to_string())
}

pub fn fit_monitor(window: &tauri::WebviewWindow, cursor: bool) -> tauri::Result<()> {
    crate::backdrop::place(window, cursor)
}
#[tauri::command]
pub fn move_to_cursor(window: tauri::WebviewWindow) -> Result<(), String> {
    fit_monitor(&window, true).map_err(|e| e.to_string())?;
    let _ = window.emit("desktop-action", "reposition");
    Ok(())
}

#[tauri::command]
pub fn screen_permission(request: bool) -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        return CGPreflightScreenCaptureAccess() || (request && CGRequestScreenCaptureAccess());
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[tauri::command]
pub async fn capture_screen() -> Result<Option<String>, String> {
    if !screen_permission(false) {
        return Err("请先在设置 → 感知中允许屏幕录制权限".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
        use base64::Engine;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间不可用")?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "companion-shot-{}-{}.png",
            std::process::id(),
            nonce
        ));
        let result = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-i", "-x", "-t", "png"])
            .arg(&path)
            .status();
        if result.is_err() {
            return Err("无法启动系统截图工具".into());
        }
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).map_err(|_| "无法读取截图");
        let _ = std::fs::remove_file(&path);
        let bytes = bytes?;
        if bytes.len() > 40 * 1024 * 1024 {
            return Err("截图过大，请选择更小的区域".into());
        }
        Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    })
    .await
    .map_err(|_| "截图任务失败")?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Sensors {
    idle_seconds: Option<f64>,
    app_name: Option<String>,
    app_id: Option<String>,
    resumed: bool,
}

#[cfg(target_os = "macos")]
mod mac {
    use objc::{class, msg_send, sel, sel_impl};
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event: u32) -> f64;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    pub fn idle() -> f64 {
        unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) }
    }
    pub fn button() -> bool {
        unsafe { CGEventSourceButtonState(0, 0) }
    }
    pub fn frontmost_pid() -> Option<i32> {
        unsafe {
            let workspace: *mut objc::runtime::Object =
                msg_send![class!(NSWorkspace), sharedWorkspace];
            let app: *mut objc::runtime::Object = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                None
            } else {
                Some(msg_send![app, processIdentifier])
            }
        }
    }
    pub fn activate(pid: i32) {
        unsafe {
            let app: *mut objc::runtime::Object = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
            if !app.is_null() {
                let _: bool = msg_send![app, activateWithOptions: 2u64];
            }
        }
    }
    // NSWorkspace and its application properties must be read on the main thread.
    pub fn frontmost() -> (Option<String>, Option<String>) {
        unsafe {
            let workspace: *mut objc::runtime::Object =
                msg_send![class!(NSWorkspace), sharedWorkspace];
            let app: *mut objc::runtime::Object = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return (None, None);
            }
            let string = |selector: objc::runtime::Sel| -> Option<String> {
                let value: *mut objc::runtime::Object = msg_send![app, performSelector: selector];
                if value.is_null() {
                    return None;
                }
                let utf: *const std::os::raw::c_char = msg_send![value, UTF8String];
                if utf.is_null() {
                    None
                } else {
                    Some(std::ffi::CStr::from_ptr(utf).to_string_lossy().into_owned())
                }
            };
            (string(sel!(localizedName)), string(sel!(bundleIdentifier)))
        }
    }
}

pub fn poll(app: &tauri::AppHandle, state: Desktop) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut pass_through = true;
        let mut mouse_down = false;
        let mut last_sensor = Instant::now() - Duration::from_secs(5);
        let mut last_wall = std::time::SystemTime::now();
        let mut last_check = Instant::now();
        let mut was_resumed = false;
        let mut monitor_check = Instant::now();
        let mut placed_for: Option<(i32, i32)> = None;
        let mut last_tick = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let Some(w) = app.get_webview_window("main") else {
                break;
            };
            let wall = std::time::SystemTime::now();
            let wall_gap = wall.duration_since(last_wall).unwrap_or_default();
            let mono_gap = last_check.elapsed();
            let resumed = wall_gap > Duration::from_secs(10) || mono_gap > Duration::from_secs(10);
            last_wall = wall;
            last_check = Instant::now();
            was_resumed |= resumed;
            if last_tick.elapsed() >= Duration::from_secs(1) {
                last_tick = Instant::now();
                let _ = w.emit("desktop-tick", ());
            }
            let (Ok(pos), Ok(origin), Ok(scale)) =
                (w.cursor_position(), w.outer_position(), w.scale_factor())
            else {
                continue;
            };
            let x = (pos.x - origin.x as f64) / scale;
            let y = (pos.y - origin.y as f64) / scale;
            // Release the shared state lock before dispatching window work to
            // the main thread, which also handles set_regions and focus IPC.
            let Ok(s) = state.lock().map(|state| state.clone()) else {
                continue;
            };
            let hit = !s.hidden && (s.dragging || s.regions.iter().any(|r| r.contains(x, y)));
            if hit == pass_through && w.set_ignore_cursor_events(!hit).is_ok() {
                pass_through = !hit;
            }
            #[cfg(target_os = "macos")]
            let down = mac::button();
            #[cfg(not(target_os = "macos"))]
            let down = false;
            let sampled_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            #[cfg(target_os = "macos")]
            {
                if down && !mouse_down && !hit && s.interactive {
                    let _ = w.emit("desktop-outside", ());
                }
                mouse_down = down;
            }
            if !s.hidden {
                let _ = w.emit(
                    "desktop-cursor",
                    serde_json::json!({"x":x,"y":y,"buttonsDown":down,"sampledAt":sampled_at}),
                );
            }
            if last_sensor.elapsed() >= Duration::from_secs(2) {
                last_sensor = Instant::now();
                let idle_enabled = s.sense_idle;
                let app_enabled = s.sense_app;
                let wake = was_resumed;
                was_resumed = false;
                let out = app.clone();
                let _ = app.run_on_main_thread(move || {
                    #[cfg(target_os = "macos")]
                    let (name, id) = if app_enabled {
                        mac::frontmost()
                    } else {
                        (None, None)
                    };
                    #[cfg(not(target_os = "macos"))]
                    let (name, id) = (None, None);
                    #[cfg(target_os = "macos")]
                    let idle = idle_enabled.then(mac::idle);
                    #[cfg(not(target_os = "macos"))]
                    let idle = None;
                    let _ = out.emit(
                        "desktop-sensors",
                        Sensors {
                            idle_seconds: idle,
                            app_name: name,
                            app_id: id,
                            resumed: wake,
                        },
                    );
                });
            }
            // 显示器拔掉或分辨率变化后，透明宿主重新铺满当前（或主）显示器。
            if monitor_check.elapsed() > Duration::from_secs(5) {
                monitor_check = Instant::now();
                if let Ok(monitors) = w.available_monitors() {
                    let origin_valid = monitors.iter().any(|m| {
                        let p = m.position();
                        let sz = m.size();
                        origin.x >= p.x
                            && origin.y >= p.y
                            && origin.x < p.x + sz.width as i32
                            && origin.y < p.y + sz.height as i32
                    });
                    if !origin_valid {
                        let _ = fit_monitor(&w, false);
                    } else if let Ok(Some(m)) = w.current_monitor() {
                        // 系统不让放到目标位置时只试一次，避免每 5 秒挪一次窗口
                        let target = crate::backdrop::monitor_origin(&m);
                        let resized = w.outer_size().map(|size| size != *m.size()).unwrap_or(false);
                        if (origin.x, origin.y) == target && !resized {
                            placed_for = None;
                        } else if placed_for != Some(target) {
                            placed_for = Some(target);
                            let _ = crate::backdrop::place_on(&w, &m);
                            let _ = w.emit("desktop-action", "relayout");
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transparent_corners_pass_through() {
        let r = Region {
            x: 10.,
            y: 20.,
            w: 100.,
            h: 80.,
            radius: 20.,
        };
        assert!(!r.contains(10., 20.));
        assert!(r.contains(30., 20.));
        assert!(r.contains(60., 60.));
        assert!(!r.contains(111., 60.));
    }
}
