//! 透明宿主覆盖当前显示器，能量体固定在顶部，对话和系统模糊衬底可独立拖动。

use serde::{Deserialize, Serialize};

/// 原生动画的两条时间曲线（三次贝塞尔控制点）：变大带回弹，变小平滑减速。
pub const SPRING: [f64; 4] = [0.32, 1.32, 0.52, 1.0];
pub const EASE: [f64; 4] = [0.4, 0.0, 0.2, 1.0];

/// 网页给出的衬底矩形（窗口坐标，左上角为原点）、羽化宽度和圆角半径。
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Backdrop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub feather: f64,
    /// 对话窗口是圆角面板；其余状态没有圆角。
    #[serde(default)]
    pub radius: f64,
    pub visible: bool,
    /// 动画秒数；0 表示立即生效（隐藏时用它把视图真正藏起来）。
    pub duration: f64,
    /// 变大时用带回弹的曲线，变小时用平滑减速。
    pub spring: bool,
    /// 待命空间：铺满整个屏幕，整体淡入淡出。
    #[serde(default)]
    pub standby: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopMetrics {
    /// 刘海屏顶部被遮住的高度；没有刘海时为 0。
    safe_top: f64,
    /// 系统菜单栏占掉的高度（菜单栏自动隐藏时为 0）。常驻条和通知要让开它。
    menu_top: f64,
}

#[tauri::command]
pub fn set_backdrop(window: tauri::WebviewWindow, backdrop: Backdrop) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac::on_main(&window, move |w| unsafe { mac::apply(w, backdrop) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, backdrop);
        Err("系统模糊衬底只支持 macOS".into())
    }
}

#[tauri::command]
pub fn top_metrics(window: tauri::WebviewWindow) -> TopMetrics {
    #[cfg(target_os = "macos")]
    let (safe_top, menu_top) = unsafe { (mac::safe_top(&window), mac::menu_top(&window)) };
    #[cfg(not(target_os = "macos"))]
    let (safe_top, menu_top) = {
        let _ = window;
        (0.0, 0.0)
    };
    TopMetrics { safe_top, menu_top }
}

/// 透明宿主铺满显示器，网页里的固定舞台仍位于顶部中央。
pub fn place(window: &tauri::WebviewWindow, cursor: bool) -> tauri::Result<()> {
    let monitor = if cursor {
        let pos = window.cursor_position()?;
        window.monitor_from_point(pos.x, pos.y)?
    } else {
        window.primary_monitor()?
    };
    if let Some(m) = monitor {
        place_on(window, &m)?;
    }
    Ok(())
}

pub fn place_on(window: &tauri::WebviewWindow, m: &tauri::Monitor) -> tauri::Result<()> {
    let (x, y) = monitor_origin(m);
    window.set_size(*m.size())?;
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    #[cfg(target_os = "macos")]
    unsafe {
        mac::raise(window);
    }
    Ok(())
}

/// 窗口在该显示器上应有的左上角（物理像素）。
pub fn monitor_origin(m: &tauri::Monitor) -> (i32, i32) {
    let p = m.position();
    (p.x, p.y)
}

/// 时间进度 t（0～1）在曲线上对应的数值进度；回弹曲线中途会超过 1。
pub fn curve(points: [f64; 4], t: f64) -> f64 {
    let [x1, y1, x2, y2] = points;
    let bez = |a: f64, b: f64, s: f64| 3.0 * a * s * (1.0 - s).powi(2) + 3.0 * b * s * s * (1.0 - s) + s.powi(3);
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if bez(x1, x2, mid) < t.clamp(0.0, 1.0) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bez(y1, y2, (lo + hi) / 2.0)
}

/// 遮罩图的固定边距（点）：左右、上、下；中间 1 点可拉伸。
pub fn mask_caps(f: f64, r: f64) -> (usize, usize, usize) {
    let side = f.max(r).ceil().max(1.0) as usize;
    (side, r.ceil() as usize, side)
}

/// 圆角 r、左右和下方羽化 f 的遮罩像素（RGBA，第 0 行在最上面）。顶边贴屏幕不羽化；
/// f 为 0 时边缘留 1 像素抗锯齿。
pub fn mask_pixels(f: f64, r: f64, scale: usize) -> (usize, usize, Vec<u8>) {
    let (side, top, bottom) = mask_caps(f, r);
    let (w, h) = ((side * 2 + 1) * scale, (top + bottom + 1) * scale);
    let ease = |t: f64| {
        let c = t.clamp(0.0, 1.0);
        c * c * (3.0 - 2.0 * c)
    };
    let s = scale as f64;
    let soft = f.max(1.0 / s);
    let (wp, hp) = (w as f64 / s, h as f64 / s);
    let mut px = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (u, v) = ((x as f64 + 0.5) / s, (y as f64 + 0.5) / s);
            let mut a = ease(u.min(wp - u) / soft) * ease((hp - v) / soft);
            if r > 0.0 {
                let d = (u - u.clamp(r, wp - r)).hypot(v - v.clamp(r, hp - r));
                a *= ((r - d) * s + 0.5).clamp(0.0, 1.0);
            }
            px[(y * w + x) * 4 + 3] = (a * 255.0).round() as u8;
        }
    }
    (w, h, px)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Backdrop;
    use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};
    use objc::{class, msg_send, sel, sel_impl, Message};
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }
    impl NSRect {
        fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
            NSRect { origin: NSPoint { x, y }, size: NSSize { width: w, height: h } }
        }
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSEdgeInsets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataCreate(alloc: *const c_void, bytes: *const u8, len: isize) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSAppearanceNameVibrantDark: *mut Object;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGColorSpaceCreateDeviceRGB() -> *const c_void;
        fn CGColorSpaceRelease(space: *const c_void);
        fn CGDataProviderCreateWithCFData(data: *const c_void) -> *const c_void;
        fn CGDataProviderRelease(provider: *const c_void);
        #[allow(clippy::too_many_arguments)]
        fn CGImageCreate(
            width: usize,
            height: usize,
            bits_per_component: usize,
            bits_per_pixel: usize,
            bytes_per_row: usize,
            space: *const c_void,
            bitmap_info: u32,
            provider: *const c_void,
            decode: *const f64,
            interpolate: bool,
            intent: i32,
        ) -> *const c_void;
        fn CGImageRelease(image: *const c_void);
    }

    const NS_STATUS_WINDOW_LEVEL: i64 = 25;
    // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
    const COLLECTION: u64 = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
    const BLEND_BEHIND_WINDOW: i64 = 0;
    const MATERIAL_HUD_WINDOW: i64 = 13;
    const STATE_ACTIVE: i64 = 1;
    const NS_WINDOW_BELOW: i64 = -1;
    const RESIZE_STRETCH: i64 = 1;
    const ALPHA_PREMULTIPLIED_LAST: u32 = 1;

    // AppKit 只能在主线程上动，视图指针也只在主线程里存取。
    thread_local! {
        static FX: Cell<*mut Object> = const { Cell::new(std::ptr::null_mut()) };
        static STANDBY_ACTIVE: Cell<bool> = const { Cell::new(false) };
        // 此刻的（羽化，圆角），变形途中是中间值；MASK 是已经生成的遮罩按半点取整后的键
        static SHAPE: Cell<(f64, f64)> = const { Cell::new((0.0, 0.0)) };
        static MASK: Cell<(i64, i64)> = const { Cell::new((-1, -1)) };
    }
    // 每次 set_backdrop 加一；还在跑的旧变形看到代数变了就停下
    static MORPH: AtomicU64 = AtomicU64::new(0);

    pub fn on_main(
        window: &tauri::WebviewWindow,
        f: impl FnOnce(&tauri::WebviewWindow) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let main: BOOL = unsafe { msg_send![class!(NSThread), isMainThread] };
        if main == YES {
            return f(window);
        }
        let w = window.clone();
        window
            .run_on_main_thread(move || {
                if let Err(e) = f(&w) {
                    eprintln!("[backdrop] {e}");
                }
            })
            .map_err(|e| e.to_string())
    }

    unsafe fn ns_window(window: &tauri::WebviewWindow) -> Result<*mut Object, String> {
        let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut Object;
        if ptr.is_null() {
            return Err("找不到原生窗口".into());
        }
        Ok(ptr)
    }

    /// 层级高于菜单栏；出现在所有桌面和全屏应用上，不参与窗口切换。
    pub unsafe fn raise(window: &tauri::WebviewWindow) {
        if let Ok(w) = ns_window(window) {
            let _: () = msg_send![w, setLevel: NS_STATUS_WINDOW_LEVEL];
            let _: () = msg_send![w, setCollectionBehavior: COLLECTION];
        }
    }

    pub unsafe fn safe_top(window: &tauri::WebviewWindow) -> f64 {
        let Ok(w) = ns_window(window) else { return 0.0 };
        let screen: *mut Object = msg_send![w, screen];
        if screen.is_null() {
            return 0.0;
        }
        let ok: BOOL = msg_send![screen, respondsToSelector: sel!(safeAreaInsets)];
        if ok == NO {
            return 0.0;
        }
        let insets: NSEdgeInsets = msg_send![screen, safeAreaInsets];
        insets.top.max(0.0)
    }

    /// 屏幕顶边到可用区域顶边的距离：就是菜单栏的高度。
    pub unsafe fn menu_top(window: &tauri::WebviewWindow) -> f64 {
        let Ok(w) = ns_window(window) else { return 0.0 };
        let screen: *mut Object = msg_send![w, screen];
        if screen.is_null() {
            return 0.0;
        }
        let frame: NSRect = msg_send![screen, frame];
        let visible: NSRect = msg_send![screen, visibleFrame];
        let top = (frame.origin.y + frame.size.height) - (visible.origin.y + visible.size.height);
        if top.is_finite() { top.clamp(0.0, 80.0) } else { 0.0 }
    }

    unsafe fn effect_view(window: &tauri::WebviewWindow) -> Result<*mut Object, String> {
        let existing = FX.with(|c| c.get());
        if !existing.is_null() {
            return Ok(existing);
        }
        let w = ns_window(window)?;
        let content: *mut Object = msg_send![w, contentView];
        let cls = Class::get("NSVisualEffectView").ok_or("系统没有 NSVisualEffectView")?;
        let fx: *mut Object = msg_send![cls, alloc];
        let fx: *mut Object = msg_send![fx, initWithFrame: NSRect::new(0.0, 0.0, 0.0, 0.0)];
        if fx.is_null() {
            return Err("无法创建模糊视图".into());
        }
        let _: () = msg_send![fx, setBlendingMode: BLEND_BEHIND_WINDOW];
        let _: () = msg_send![fx, setMaterial: MATERIAL_HUD_WINDOW];
        let _: () = msg_send![fx, setState: STATE_ACTIVE];
        let _: () = msg_send![fx, setAlphaValue: 0.0f64];
        let _: () = msg_send![fx, setHidden: YES];
        let nil: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![content, addSubview: fx positioned: NS_WINDOW_BELOW relativeTo: nil];
        FX.with(|c| c.set(fx));
        Ok(fx)
    }

    unsafe fn mask_image(f: f64, r: f64) -> Result<*mut Object, String> {
        let (side, top, bottom) = super::mask_caps(f, r);
        let (w, h, px) = super::mask_pixels(f, r, 2);
        let data = CFDataCreate(std::ptr::null(), px.as_ptr(), px.len() as isize);
        let provider = CGDataProviderCreateWithCFData(data);
        let space = CGColorSpaceCreateDeviceRGB();
        let image = CGImageCreate(w, h, 8, 32, w * 4, space, ALPHA_PREMULTIPLIED_LAST, provider, std::ptr::null(), true, 0);
        CGColorSpaceRelease(space);
        CGDataProviderRelease(provider);
        CFRelease(data);
        if image.is_null() {
            return Err("无法生成羽化遮罩".into());
        }
        let (side, top, bottom) = (side as f64, top as f64, bottom as f64);
        let ns: *mut Object = msg_send![class!(NSImage), alloc];
        let ns: *mut Object =
            msg_send![ns, initWithCGImage: image size: NSSize { width: side * 2.0 + 1.0, height: top + bottom + 1.0 }];
        CGImageRelease(image);
        // 系统按图像坐标（下边为起点）解释上下两端的固定边距：图像下方的边距要写在 top 里
        let insets = NSEdgeInsets { top: bottom, left: side, bottom: top, right: side };
        let _: () = msg_send![ns, setCapInsets: insets];
        let _: () = msg_send![ns, setResizingMode: RESIZE_STRETCH];
        Ok(ns)
    }

    /// 待命空间的衬底铺满整个屏幕，整体淡入、整体淡出：桌面只是“静下来”，没有从哪里铺开或收回的形状。
    unsafe fn apply_standby(fx: *mut Object, target: NSRect, b: Backdrop) -> Result<(), String> {
        let was = STANDBY_ACTIVE.with(|s| s.replace(b.visible));
        // 停掉常驻条、通知那种底板还在进行的变形，换成没有遮罩的整块
        MORPH.fetch_add(1, Ordering::SeqCst);
        MASK.with(|m| m.set((-1, -1)));
        let nil: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![fx, setMaskImage: nil];
        let _: () = msg_send![fx, setFrame: target];
        if b.duration <= 0.0 {
            let _: () = msg_send![fx, setAlphaValue: if b.visible { 1.0f64 } else { 0.0f64 }];
            let _: () = msg_send![fx, setHidden: if b.visible { NO } else { YES }];
            return Ok(());
        }
        if was == b.visible { return Ok(()); }
        if b.visible {
            let _: () = msg_send![fx, setAlphaValue: 0.0f64];
            let _: () = msg_send![fx, setHidden: NO];
        }
        let _: () = msg_send![class!(NSAnimationContext), beginGrouping];
        let ctx: *mut Object = msg_send![class!(NSAnimationContext), currentContext];
        let _: () = msg_send![ctx, setDuration: b.duration];
        let tf = timing(false);
        if !tf.is_null() {
            let _: () = msg_send![ctx, setTimingFunction: tf];
        }
        let animator: *mut Object = msg_send![fx, animator];
        let _: () = msg_send![animator, setAlphaValue: if b.visible { 1.0f64 } else { 0.0f64 }];
        let _: () = msg_send![class!(NSAnimationContext), endGrouping];
        Ok(())
    }

    unsafe fn set_shape(fx: *mut Object, f: f64, r: f64) -> Result<(), String> {
        SHAPE.with(|c| c.set((f, r)));
        let key = ((f * 2.0).round() as i64, (r * 2.0).round() as i64);
        if MASK.with(|c| c.get()) == key {
            return Ok(());
        }
        let mask = mask_image(key.0 as f64 / 2.0, key.1 as f64 / 2.0)?;
        let _: () = msg_send![fx, setMaskImage: mask];
        let _: () = msg_send![mask, release];
        MASK.with(|c| c.set(key));
        Ok(())
    }

    /// 羽化和圆角不能交给系统动画，按同一条曲线逐帧换遮罩，跟着矩形一起变。
    fn morph(window: &tauri::WebviewWindow, gen: u64, from: (f64, f64), to: (f64, f64), b: &Backdrop) {
        let (w, duration) = (window.clone(), b.duration);
        let points = if b.spring { super::SPRING } else { super::EASE };
        std::thread::spawn(move || {
            let start = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(16));
                let t = (start.elapsed().as_secs_f64() / duration).min(1.0);
                let k = super::curve(points, t);
                let shape = ((from.0 + (to.0 - from.0) * k).max(0.0), (from.1 + (to.1 - from.1) * k).max(0.0));
                if MORPH.load(Ordering::SeqCst) != gen {
                    return;
                }
                let _ = w.run_on_main_thread(move || {
                    if MORPH.load(Ordering::SeqCst) == gen {
                        if let Err(e) = unsafe { set_shape(FX.with(|c| c.get()), shape.0, shape.1) } {
                            eprintln!("[backdrop] {e}");
                        }
                    }
                });
                if t >= 1.0 {
                    return;
                }
            }
        });
    }

    unsafe fn timing(spring: bool) -> *mut Object {
        let Some(cls) = Class::get("CAMediaTimingFunction") else { return std::ptr::null_mut() };
        let [a, b, c, d] = if spring { super::SPRING } else { super::EASE };
        let points = (a as f32, b as f32, c as f32, d as f32);
        cls.send_message(Sel::register("functionWithControlPoints::::"), points).unwrap_or(std::ptr::null_mut())
    }

    pub unsafe fn apply(window: &tauri::WebviewWindow, b: Backdrop) -> Result<(), String> {
        let fx = effect_view(window)?;
        // 屏幕顶部的界面不跟系统深浅走，始终是中性的烟灰玻璃，所以底下的系统材质也固定用深色
        let appearance: *mut Object = msg_send![class!(NSAppearance), appearanceNamed: NSAppearanceNameVibrantDark];
        let _: () = msg_send![fx, setAppearance: appearance];
        let _: () = msg_send![fx, setMaterial: MATERIAL_HUD_WINDOW];
        let w = ns_window(window)?;
        let content: *mut Object = msg_send![w, contentView];
        let bounds: NSRect = msg_send![content, bounds];
        let flipped: BOOL = msg_send![content, isFlipped];
        let to_native = |x: f64, y: f64, width: f64, height: f64| {
            let y = if flipped == YES { y } else { bounds.size.height - y - height };
            NSRect::new(x, y, width, height)
        };
        let target = to_native(b.x, b.y, b.w, b.h);
        if b.standby { return apply_standby(fx, target, b); }
        STANDBY_ACTIVE.with(|s| s.set(false));
        // 从隐身出现、或收回隐身时，底板都在原位淡入淡出；只有两种底板之间切换才跟着矩形变形
        let hidden: BOOL = msg_send![fx, isHidden];
        let gen = MORPH.fetch_add(1, Ordering::SeqCst) + 1;
        let (from, to) = (SHAPE.with(|c| c.get()), (b.feather.max(0.0), b.radius.max(0.0)));
        if b.duration <= 0.0 || hidden == YES || (from.0 - to.0).abs() + (from.1 - to.1).abs() < 0.5 {
            set_shape(fx, to.0, to.1)?;
        } else {
            morph(window, gen, from, to, &b);
        }

        if b.visible && hidden == YES {
            let _: () = msg_send![fx, setFrame: target];
            let _: () = msg_send![fx, setAlphaValue: 0.0f64];
            let _: () = msg_send![fx, setHidden: NO];
        }
        if b.duration <= 0.0 {
            let _: () = msg_send![fx, setFrame: target];
            let _: () = msg_send![fx, setAlphaValue: if b.visible { 1.0f64 } else { 0.0f64 }];
            if !b.visible {
                let _: () = msg_send![fx, setHidden: YES];
            }
            return Ok(());
        }
        let _: () = msg_send![class!(NSAnimationContext), beginGrouping];
        let ctx: *mut Object = msg_send![class!(NSAnimationContext), currentContext];
        let _: () = msg_send![ctx, setDuration: b.duration];
        let tf = timing(b.spring);
        if !tf.is_null() {
            let _: () = msg_send![ctx, setTimingFunction: tf];
        }
        let animator: *mut Object = msg_send![fx, animator];
        let _: () = msg_send![animator, setFrame: target];
        let _: () = msg_send![animator, setAlphaValue: if b.visible { 1.0f64 } else { 0.0f64 }];
        let _: () = msg_send![class!(NSAnimationContext), endGrouping];
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_is_opaque_at_the_top_and_fades_out_at_the_sides_and_bottom() {
        let (w, h, px) = mask_pixels(40.0, 0.0, 2);
        assert_eq!((w, h), (162, 82));
        let alpha = |x: usize, y: usize| px[(y * w + x) * 4 + 3];
        assert_eq!(alpha(w / 2, 0), 255, "top center is solid");
        assert_eq!(alpha(1, 0), alpha(w - 2, 0), "sides are symmetric");
        assert!(alpha(0, 0) < 4, "left edge fades out");
        assert!(alpha(w - 1, 0) < 4, "right edge fades out");
        assert!(alpha(w / 2, h - 1) < 4, "bottom edge fades out");
        assert!(alpha(w / 2, h / 2) > 64 && alpha(w / 2, h / 2) < 192, "half way down is half faded");
        assert!(px.chunks_exact(4).all(|p| p[..3] == [0, 0, 0]));
    }

    #[test]
    fn panel_mask_is_a_crisp_rounded_rect() {
        let (w, h, px) = mask_pixels(0.0, 18.0, 2);
        assert_eq!(mask_caps(0.0, 18.0), (18, 18, 18));
        assert_eq!((w, h), (74, 74));
        let alpha = |x: usize, y: usize| px[(y * w + x) * 4 + 3];
        assert_eq!(alpha(w / 2, h / 2), 255, "center is solid");
        for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (4, 4)] {
            assert_eq!(alpha(x, y), 0, "corner ({x}, {y}) is cut away");
        }
        assert_eq!(alpha(w / 2, 0), 255, "top edge is not feathered");
        assert_eq!(alpha(w / 2, 1), 255);
        assert_eq!(alpha(1, h / 2), 255, "one pixel of anti-aliasing at the sides");
        assert_eq!(alpha(w / 2, h - 2), 255, "and at the bottom");
        let arc = alpha(10, 10);
        assert!(arc > 0 && arc < 255, "the arc itself is anti-aliased, got {arc}");
    }

    #[test]
    fn mask_stretches_only_through_uniform_middle_lines() {
        for (f, r) in [(71.0, 0.0), (35.5, 9.0), (0.0, 18.0), (4.0, 18.0)] {
            let (side, top, _) = mask_caps(f, r);
            let (w, h, px) = mask_pixels(f, r, 2);
            let alpha = |x: usize, y: usize| px[(y * w + x) * 4 + 3];
            let (mx, my) = (side * 2, top * 2);
            for y in 0..h {
                assert_eq!(alpha(mx, y), alpha(mx + 1, y), "middle column at f={f} r={r}");
            }
            for x in 0..w {
                assert_eq!(alpha(x, my), alpha(x, my + 1), "middle row at f={f} r={r}");
            }
        }
    }

    #[test]
    fn curves_start_at_zero_end_at_one_and_the_spring_overshoots() {
        for points in [SPRING, EASE] {
            assert!(curve(points, 0.0).abs() < 1e-6);
            assert!((curve(points, 1.0) - 1.0).abs() < 1e-6);
        }
        assert!((0..=20).any(|i| curve(SPRING, i as f64 / 20.0) > 1.02));
        assert!((0..=20).all(|i| curve(EASE, i as f64 / 20.0) <= 1.0 + 1e-9));
    }
}
