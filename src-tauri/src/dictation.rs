//! On-device macOS dictation. Audio stays on this Mac: recognition requires
//! `requiresOnDeviceRecognition`, and the transcript is only emitted to the
//! composer. Nothing here is sent to the chat model.

#[cfg(target_os = "macos")]
use objc::{sel, sel_impl};
use serde::Deserialize;
use serde_json::json;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
use crate::voice::{microphone_state, speech_label, speech_state};

const EVENT: &str = "voice-dictation";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct DictationConfig {
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub base: String,
}

/// Compute normalized microphone/audio RMS level in `0.0..=1.0`.
pub(crate) fn compute_audio_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sum_sq = 0.0f64;
    let mut count = 0usize;
    for &s in samples {
        if s.is_finite() {
            let v = f64::from(s);
            sum_sq += v * v;
            count += 1;
        }
    }
    if count == 0 {
        return 0.0;
    }
    let rms = (sum_sq / count as f64).sqrt();
    // Apply subtle noise gate (~0.0025) and sqrt compression so normal speech registers clearly.
    (((rms - 0.0025).max(0.0) * 12.0).sqrt()).clamp(0.0, 1.0) as f32
}

pub(crate) fn dictation_permission_error(microphone: &str, speech: &str) -> Option<&'static str> {
    match microphone {
        "denied" => Some("麦克风权限已关闭。请到系统设置 → 隐私与安全性 → 麦克风中允许 KBOT。文字输入不受影响。"),
        "restricted" => Some("这台 Mac 限制了麦克风，听写不可用。文字输入不受影响。"),
        "unsupported" => Some("当前系统不能使用麦克风听写。文字输入不受影响。"),
        _ => None,
    }
    .or(match speech {
        "denied" => Some("语音识别权限已关闭。请到系统设置 → 隐私与安全性 → 语音识别中允许 KBOT。文字输入不受影响。"),
        "restricted" => Some("这台 Mac 限制了语音识别，听写不可用。文字输入不受影响。"),
        "unsupported" => Some("当前系统不能在本机听写。文字输入不受影响。"),
        _ => None,
    })
}

#[cfg(target_os = "macos")]
struct Session {
    request: usize,
    engine: usize,
    input: usize,
    recognizer: usize,
    task: usize,
    tapped: bool,
    running: Arc<AtomicBool>,
    level_bits: Arc<AtomicU32>,
    // Dropped with the session, which releases the tap and result handler.
    #[allow(dead_code)]
    keep: Box<dyn Send>,
}

#[cfg(target_os = "windows")]
struct Session {
    running: Arc<AtomicBool>,
    mic: Option<crate::win_audio::WinMicSession>,
    tx: tokio::sync::mpsc::UnboundedSender<WinDictationMsg>,
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct Session;

#[cfg(target_os = "macos")]
struct Keep<T>(T);
#[cfg(target_os = "macos")]
unsafe impl<T> Send for Keep<T> {}

#[cfg(target_os = "windows")]
enum WinDictationMsg {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

static STARTING: AtomicBool = AtomicBool::new(false);
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[cfg(target_os = "macos")]
struct PromptGuard<'a>(&'a AppHandle);
#[cfg(target_os = "macos")]
impl Drop for PromptGuard<'_> {
    fn drop(&mut self) {
        let _ = self.0.emit("voice-permission-prompting", false);
    }
}

#[tauri::command]
pub async fn voice_dictation_start(
    app: AppHandle,
    config: Option<DictationConfig>,
) -> Result<(), String> {
    if STARTING.swap(true, Ordering::AcqRel) {
        return Err("听写正在启动。".into());
    }
    let start_gen = CANCEL_GEN.load(Ordering::Acquire);
    let result = start_inner(app.clone(), config.unwrap_or_default(), start_gen).await;
    STARTING.store(false, Ordering::Release);
    if result.is_err() {
        let _ = stop_session().await;
    }
    result
}

#[tauri::command]
pub async fn voice_dictation_stop(app: AppHandle) -> Result<(), String> {
    CANCEL_GEN.fetch_add(1, Ordering::AcqRel);
    STARTING.store(false, Ordering::Release);
    if stop_session().await {
        let _ = app.emit(EVENT, json!({ "phase": "ended" }));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn spawn_level_emitter(app: AppHandle, running: Arc<AtomicBool>, level_bits: Arc<AtomicU32>) {
    tauri::async_runtime::spawn(async move {
        let mut sent_nonzero = false;
        while running.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(45)).await;
            if !running.load(Ordering::Relaxed) {
                break;
            }
            let level = f32::from_bits(level_bits.swap(0, Ordering::Relaxed));
            if level > 0.005 {
                sent_nonzero = true;
                let _ = app.emit(EVENT, json!({ "phase": "level", "level": level }));
            } else if sent_nonzero {
                sent_nonzero = false;
                let _ = app.emit(EVENT, json!({ "phase": "level", "level": 0.0 }));
            }
        }
    });
}

async fn start_inner(
    app: AppHandle,
    config: DictationConfig,
    start_gen: u64,
) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, config, start_gen);
        return Err("听写只在 macOS 与 Windows 上可用。文字输入不受影响。".into());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = config;
        ensure_granted(&app).await?;
        if CANCEL_GEN.load(Ordering::Acquire) != start_gen {
            return Err("听写已取消。".into());
        }
        let _ = stop_session().await;
        let app_for_engine = app.clone();
        let session = tauri::async_runtime::spawn_blocking(move || {
            objc::rc::autoreleasepool(|| start_engine(app_for_engine))
        })
        .await
        .map_err(|_| "听写没有启动。文字输入不受影响。".to_string())??;
        if CANCEL_GEN.load(Ordering::Acquire) != start_gen {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                objc::rc::autoreleasepool(|| shutdown(session));
            })
            .await;
            return Err("听写已取消。".into());
        }
        let level_running = Arc::clone(&session.running);
        let level_bits = Arc::clone(&session.level_bits);
        *SESSION.lock().map_err(|_| "听写状态不可用")? = Some(session);
        spawn_level_emitter(app, level_running, level_bits);
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        start_windows_dictation(app, config, start_gen).await
    }
}

#[cfg(target_os = "windows")]
async fn start_windows_dictation(
    app: AppHandle,
    config: DictationConfig,
    start_gen: u64,
) -> Result<(), String> {
    use crate::realtime::{
        connect_ws, encode_ws_frame, next_seq, random_bytes, read_realtime_auth_key,
        realtime_endpoint, try_decode_ws_frame,
    };
    use base64::Engine;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;

    let api_key = read_realtime_auth_key(config.managed)?;
    let endpoint = realtime_endpoint(&config.base, "qwen3-asr-flash-realtime")?;
    if CANCEL_GEN.load(Ordering::Acquire) != start_gen {
        return Err("听写已取消。".into());
    }
    let _ = stop_session().await;

    let (stream, leftover) = connect_ws(&endpoint, &api_key).await?;
    if CANCEL_GEN.load(Ordering::Acquire) != start_gen {
        return Err("听写已取消。".into());
    }
    let (mut reader, mut writer) = tokio::io::split(stream);
    let running = Arc::new(AtomicBool::new(true));
    let muted = Arc::new(AtomicBool::new(false));
    let bridging = Arc::new(AtomicBool::new(false));
    let level_bits = Arc::new(AtomicU32::new(0));
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WinDictationMsg>();
    let (pcm_tx, mut pcm_rx) = mpsc::channel::<Vec<u8>>(32);

    let mic_running = Arc::clone(&running);
    let mic_level = Arc::clone(&level_bits);
    let mic = match tauri::async_runtime::spawn_blocking(move || {
        crate::win_audio::WinMicSession::start(
            mic_running,
            muted,
            bridging,
            mic_level,
            None,
            pcm_tx,
        )
    })
    .await
    {
        Ok(Ok(m)) => m,
        Ok(Err(err)) => {
            running.store(false, Ordering::Release);
            return Err(err);
        }
        Err(_) => {
            running.store(false, Ordering::Release);
            return Err("无法初始化麦克风采集".into());
        }
    };

    if CANCEL_GEN.load(Ordering::Acquire) != start_gen {
        running.store(false, Ordering::Release);
        let _ = tauri::async_runtime::spawn_blocking(move || mic.shutdown()).await;
        return Err("听写已取消。".into());
    }

    let init_payload = json!({
        "event_id": format!("kbot-asr-{}", next_seq()),
        "type": "session.update",
        "session": {
            "turn_detection": { "type": "server_vad" },
            "input_audio_format": "pcm"
        }
    });
    let _ = out_tx.send(WinDictationMsg::Text(init_payload.to_string()));

    *SESSION.lock().map_err(|_| "听写状态不可用")? = Some(Session {
        running: Arc::clone(&running),
        mic: Some(mic),
        tx: out_tx.clone(),
    });
    spawn_level_emitter(app.clone(), Arc::clone(&running), Arc::clone(&level_bits));

    // WebSocket writer loop
    let writer_running = Arc::clone(&running);
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            match msg {
                WinDictationMsg::Text(text) => {
                    let frame = encode_ws_frame(0x01, text.as_bytes(), random_bytes::<4>());
                    if writer.write_all(&frame).await.is_err() {
                        break;
                    }
                }
                WinDictationMsg::Pong(data) => {
                    let frame = encode_ws_frame(0x0A, &data, random_bytes::<4>());
                    if writer.write_all(&frame).await.is_err() {
                        break;
                    }
                }
                WinDictationMsg::Close => {
                    let frame = encode_ws_frame(0x08, &[], random_bytes::<4>());
                    let _ = writer.write_all(&frame).await;
                    let _ = writer.flush().await;
                    break;
                }
            }
            if !writer_running.load(Ordering::Relaxed) {
                break;
            }
        }
    });

    // Mic audio uploader (~100ms per packet @ 16kHz PCM16)
    let mic_tx = out_tx.clone();
    let mic_loop_running = Arc::clone(&running);
    tauri::async_runtime::spawn(async move {
        let mut batch = Vec::with_capacity(6400);
        while mic_loop_running.load(Ordering::Relaxed) {
            match tokio::time::timeout(Duration::from_millis(120), pcm_rx.recv()).await {
                Ok(Some(chunk)) => batch.extend_from_slice(&chunk),
                Ok(None) => break,
                Err(_) => {}
            }
            while batch.len() < 3200 {
                match pcm_rx.try_recv() {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if batch.len() >= 1600 {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&batch);
                batch.clear();
                let ev = json!({
                    "event_id": format!("kbot-asr-aud-{}", next_seq()),
                    "type": "input_audio_buffer.append",
                    "audio": encoded
                });
                if mic_tx.send(WinDictationMsg::Text(ev.to_string())).is_err() {
                    break;
                }
            }
        }
    });

    // WebSocket reader loop -> partial/final/error events
    let rd_running = Arc::clone(&running);
    let rd_tx = out_tx;
    tauri::async_runtime::spawn(async move {
        let mut buf = leftover;
        let mut frag_buf: Vec<u8> = Vec::new();
        let mut frag_is_text = false;
        let mut tmp = [0u8; 4096];
        let mut partial_acc = String::new();

        'outer: while rd_running.load(Ordering::Relaxed) {
            loop {
                match try_decode_ws_frame(&mut buf) {
                    Ok(Some(frame)) => match frame.opcode {
                        0x01 | 0x02 => {
                            let is_text = frame.opcode == 0x01;
                            if frame.fin {
                                if is_text {
                                    if let Ok(txt) = String::from_utf8(frame.payload) {
                                        handle_win_asr_event(
                                            &txt,
                                            &app,
                                            &rd_running,
                                            &mut partial_acc,
                                        );
                                    }
                                }
                            } else {
                                frag_buf = frame.payload;
                                frag_is_text = is_text;
                            }
                        }
                        0x00 => {
                            if frag_is_text {
                                frag_buf.extend_from_slice(&frame.payload);
                                if frame.fin {
                                    let finished = std::mem::take(&mut frag_buf);
                                    frag_is_text = false;
                                    if let Ok(txt) = String::from_utf8(finished) {
                                        handle_win_asr_event(
                                            &txt,
                                            &app,
                                            &rd_running,
                                            &mut partial_acc,
                                        );
                                    }
                                }
                            }
                        }
                        0x09 => {
                            let _ = rd_tx.send(WinDictationMsg::Pong(frame.payload));
                        }
                        0x08 => break 'outer,
                        _ => {}
                    },
                    Ok(None) => break,
                    Err(err) => {
                        if rd_running.swap(false, Ordering::AcqRel) {
                            let _ = app.emit(EVENT, json!({ "phase": "error", "message": err }));
                        }
                        break 'outer;
                    }
                }
            }
            match reader.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(_) => break,
            }
        }
        if rd_running.swap(false, Ordering::AcqRel) {
            let _ = app.emit(EVENT, json!({ "phase": "ended" }));
        }
        let _ = stop_session().await;
    });

    Ok(())
}

#[cfg(target_os = "windows")]
fn handle_win_asr_event(
    raw: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
    partial_acc: &mut String,
) {
    let Ok(ev) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    let kind = ev["type"].as_str().unwrap_or("");
    match kind {
        "conversation.item.input_audio_transcription.text" => {
            let fixed = ev["text"].as_str().unwrap_or("");
            let stash = ev["stash"].as_str().unwrap_or("");
            let combined = format!("{fixed}{stash}");
            if !combined.is_empty() {
                *partial_acc = combined.clone();
                let _ = app.emit(EVENT, json!({ "phase": "partial", "text": combined }));
            }
        }
        "conversation.item.input_audio_transcription.delta" => {
            let delta = ev["delta"].as_str().unwrap_or("");
            if !delta.is_empty() {
                partial_acc.push_str(delta);
                let _ = app.emit(EVENT, json!({ "phase": "partial", "text": partial_acc.as_str() }));
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let text = ev["transcript"].as_str().unwrap_or(partial_acc.as_str());
            if running.swap(false, Ordering::AcqRel) {
                let _ = app.emit(EVENT, json!({ "phase": "final", "text": text }));
            }
        }
        "error" => {
            let msg = ev["error"]["message"]
                .as_str()
                .or_else(|| ev["message"].as_str())
                .unwrap_or("语音听写服务返回错误");
            if running.swap(false, Ordering::AcqRel) {
                let _ = app.emit(
                    EVENT,
                    json!({ "phase": "error", "message": crate::realtime::friendly_server_error(msg) }),
                );
            }
        }
        _ => {}
    }
}

async fn stop_session() -> bool {
    let session = SESSION.lock().ok().and_then(|mut guard| guard.take());
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let Some(mut session) = session else { return false };
    #[cfg(target_os = "macos")]
    {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            objc::rc::autoreleasepool(|| shutdown(session));
        })
        .await;
    }
    #[cfg(target_os = "windows")]
    {
        session.running.store(false, Ordering::Release);
        let _ = session.tx.send(WinDictationMsg::Close);
        if let Some(mic) = session.mic.take() {
            let _ = tauri::async_runtime::spawn_blocking(move || mic.shutdown()).await;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        drop(session);
    }
    true
}

#[cfg(target_os = "macos")]
fn open_privacy_pane(pane: &str) {
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
    let _ = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(target_os = "macos")]
pub(crate) async fn ensure_microphone_granted(app: &AppHandle) -> Result<(), String> {
    ensure_audio_frameworks()?;
    let mic = microphone_state();
    if let Some(message) = dictation_permission_error(&mic, "authorized") {
        if mic == "denied" {
            open_privacy_pane("Privacy_Microphone");
        }
        return Err(message.into());
    }
    if mic != "authorized" {
        let granted = request_microphone(app).await?;
        if !granted {
            return Err(dictation_permission_error("denied", "authorized")
                .unwrap_or("没有获得麦克风权限。文字输入不受影响。")
                .into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn ensure_granted(app: &AppHandle) -> Result<(), String> {
    ensure_frameworks()?;
    let mic = microphone_state();
    let speech = speech_state();
    if let Some(message) = dictation_permission_error(&mic, &speech) {
        if mic == "denied" {
            open_privacy_pane("Privacy_Microphone");
        } else if speech == "denied" {
            open_privacy_pane("Privacy_SpeechRecognition");
        }
        return Err(message.into());
    }
    ensure_microphone_granted(app).await?;
    if speech != "authorized" {
        let in_app_bundle = std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(false);
        if !in_app_bundle {
            return Err("开发模式下系统听写需要通过 KBOT.app 申请语音识别权限，文字输入不受影响。".into());
        }
        let status = request_speech(app).await?;
        let label = speech_label(status);
        if label != "authorized" {
            return Err(dictation_permission_error("authorized", label)
                .unwrap_or("没有获得语音识别权限。文字输入不受影响。")
                .into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn spawn_main(app: &AppHandle, work: impl FnOnce() + Send + 'static) {
    let _ = app.run_on_main_thread(work);
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_audio_frameworks() -> Result<(), String> {
    extern "C" {
        fn dlopen(path: *const i8, mode: i32) -> *mut std::ffi::c_void;
    }
    for path in [
        "/System/Library/Frameworks/AVFAudio.framework/AVFAudio",
        "/System/Library/Frameworks/AVFoundation.framework/AVFoundation",
    ] {
        let c_path = CString::new(path).map_err(|_| "语音组件路径无效")?;
        if unsafe { dlopen(c_path.as_ptr(), 1) }.is_null() {
            return Err("这台 Mac 缺少音频组件。文字输入不受影响。".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_frameworks() -> Result<(), String> {
    ensure_audio_frameworks()?;
    extern "C" {
        fn dlopen(path: *const i8, mode: i32) -> *mut std::ffi::c_void;
    }
    let c_path = CString::new("/System/Library/Frameworks/Speech.framework/Speech")
        .map_err(|_| "语音组件路径无效")?;
    if unsafe { dlopen(c_path.as_ptr(), 1) }.is_null() {
        return Err("这台 Mac 缺少语音识别组件。文字输入不受影响。".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn ns_string(text: &str) -> *mut objc::runtime::Object {
    let Ok(c_text) = CString::new(text) else {
        return std::ptr::null_mut();
    };
    unsafe {
        let string: *mut objc::runtime::Object =
            objc::msg_send![objc::class!(NSString), stringWithUTF8String: c_text.as_ptr()];
        string
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ns_to_string(value: *mut objc::runtime::Object) -> String {
    if value.is_null() {
        return String::new();
    }
    unsafe {
        let bytes: *const i8 = objc::msg_send![value, UTF8String];
        if bytes.is_null() {
            return String::new();
        }
        CStr::from_ptr(bytes).to_string_lossy().into_owned()
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn release(object: *mut objc::runtime::Object) {
    if !object.is_null() {
        unsafe {
            let _: () = objc::msg_send![object, release];
        }
    }
}

#[cfg(target_os = "macos")]
async fn request_microphone(app: &AppHandle) -> Result<bool, String> {
    let _ = app.emit("voice-permission-prompting", true);
    let _guard = PromptGuard(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    spawn_main(app, move || {
        let tx = Arc::clone(&tx);
        let block = block::ConcreteBlock::new(move |granted: bool| {
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(granted);
            }
        })
        .copy();
        unsafe {
            let media = ns_string("soun");
            let _: () = objc::msg_send![
                objc::class!(AVCaptureDevice),
                requestAccessForMediaType: media completionHandler: &*block
            ];
        }
        std::mem::forget(block);
    });
    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(granted)) => Ok(granted),
        _ => Err("没有等到麦克风权限结果。文字输入不受影响。".into()),
    }
}

#[cfg(target_os = "macos")]
async fn request_speech(app: &AppHandle) -> Result<isize, String> {
    let _ = app.emit("voice-permission-prompting", true);
    let _guard = PromptGuard(app);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    spawn_main(app, move || {
        let tx = Arc::clone(&tx);
        let block = block::ConcreteBlock::new(move |status: isize| {
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(status);
            }
        })
        .copy();
        unsafe {
            let _: () = objc::msg_send![objc::class!(SFSpeechRecognizer), requestAuthorization: &*block];
        }
        std::mem::forget(block);
    });
    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(status)) => Ok(status),
        _ => Err("没有等到语音识别权限结果。文字输入不受影响。".into()),
    }
}

#[cfg(target_os = "macos")]
fn open_on_device_recognizer() -> Result<*mut objc::runtime::Object, String> {
    use objc::runtime::Object;
    use objc::{class, msg_send};

    let is_usable = |rec: *mut Object| -> bool {
        if rec.is_null() {
            return false;
        }
        let available: bool = unsafe { msg_send![rec, isAvailable] };
        let on_device: bool = unsafe { msg_send![rec, supportsOnDeviceRecognition] };
        available && on_device
    };

    for id in ["zh-CN", "zh-Hans-CN"] {
        let locale_id = ns_string(id);
        if locale_id.is_null() {
            continue;
        }
        let locale: *mut Object =
            unsafe { msg_send![class!(NSLocale), localeWithLocaleIdentifier: locale_id] };
        if locale.is_null() {
            continue;
        }
        let rec: *mut Object = unsafe { msg_send![class!(SFSpeechRecognizer), alloc] };
        let rec: *mut Object = unsafe { msg_send![rec, initWithLocale: locale] };
        if is_usable(rec) {
            return Ok(rec);
        }
        release(rec);
    }

    let default_rec: *mut Object = unsafe { msg_send![class!(SFSpeechRecognizer), new] };
    if is_usable(default_rec) {
        return Ok(default_rec);
    }
    release(default_rec);
    Err("这台 Mac 还不能在本机识别语音。可以在「系统设置 → 键盘 → 听写」打开听写后再试。声音不会发给网络，文字输入不受影响。".into())
}

#[cfg(target_os = "macos")]
fn start_engine(app: AppHandle) -> Result<Session, String> {
    use objc::runtime::Object;
    use objc::{class, msg_send};
    ensure_frameworks()?;
    let running = Arc::new(AtomicBool::new(true));
    let level_bits = Arc::new(AtomicU32::new(0));
    let recognizer = open_on_device_recognizer()?;

    let request: *mut Object = unsafe { msg_send![class!(SFSpeechAudioBufferRecognitionRequest), new] };
    if request.is_null() {
        release(recognizer);
        return Err("听写暂时没能开始。文字输入不受影响。".into());
    }
    unsafe {
        let _: () = msg_send![request, setShouldReportPartialResults: true];
        let _: () = msg_send![request, setRequiresOnDeviceRecognition: true];
    }

    let engine: *mut Object = unsafe { msg_send![class!(AVAudioEngine), new] };
    if engine.is_null() {
        release(request);
        release(recognizer);
        return Err("听写暂时没能开始。文字输入不受影响。".into());
    }
    let input: *mut Object = unsafe { msg_send![engine, inputNode] };
    let format: *mut Object = if input.is_null() {
        std::ptr::null_mut()
    } else {
        unsafe { msg_send![input, outputFormatForBus: 0usize] }
    };
    let (sample_rate, channel_count) = if format.is_null() {
        (0.0, 0u32)
    } else {
        unsafe {
            (
                msg_send![format, sampleRate],
                msg_send![format, channelCount],
            )
        }
    };
    if input.is_null() || format.is_null() || sample_rate <= 0.0 || channel_count == 0 {
        release(engine);
        release(request);
        release(recognizer);
        return Err("麦克风还没有准备好。文字输入不受影响。".into());
    }

    let request_addr = request as usize;
    let tap_running = Arc::clone(&running);
    let tap_level_bits = Arc::clone(&level_bits);
    let tap = block::ConcreteBlock::new(move |buffer: *mut Object, _when: *mut Object| {
        if !tap_running.load(Ordering::Relaxed) || buffer.is_null() {
            return;
        }
        let request = request_addr as *mut Object;
        unsafe {
            let _: () = msg_send![request, appendAudioPCMBuffer: buffer];
            let frame_len: u32 = msg_send![buffer, frameLength];
            let channels: *const *const f32 = msg_send![buffer, floatChannelData];
            if frame_len > 0 && !channels.is_null() {
                let first_ch = *channels;
                if !first_ch.is_null() {
                    let samples = std::slice::from_raw_parts(first_ch, frame_len as usize);
                    let lvl = compute_audio_level(samples);
                    let prev = f32::from_bits(tap_level_bits.load(Ordering::Relaxed));
                    if lvl > prev {
                        tap_level_bits.store(lvl.to_bits(), Ordering::Relaxed);
                    }
                }
            }
        }
    })
    .copy();
    if let Err(detail) = crate::realtime::try_objc(|| unsafe {
        let _: () = msg_send![input, installTapOnBus: 0usize bufferSize: 1024u32 format: format block: &*tap];
    }) {
        release(engine);
        release(request);
        release(recognizer);
        return Err(format!("听写暂时没能开始（{detail}）。文字输入不受影响。"));
    }

    let handler_running = Arc::clone(&running);
    let handler_app = app.clone();
    let handler = block::ConcreteBlock::new(move |result: *mut Object, error: *mut Object| {
        if !handler_running.load(Ordering::Relaxed) {
            return;
        }
        if !error.is_null() {
            let code: isize = unsafe { msg_send![error, code] };
            let message = if code == 1110 {
                "没有听到声音。文字输入不受影响。"
            } else if matches!(code, 203 | 209 | 216 | 301) {
                ""
            } else {
                "听写中断了。文字输入不受影响。"
            };
            let phase = if message.is_empty() { "ended" } else { "error" };
            let _ = handler_app.emit(EVENT, json!({ "phase": phase, "message": message }));
            return;
        }
        if result.is_null() {
            return;
        }
        let text = result_text(result);
        if text.is_empty() {
            return;
        }
        let is_final: bool = unsafe { msg_send![result, isFinal] };
        let _ = handler_app.emit(
            EVENT,
            json!({
                "phase": if is_final { "final" } else { "partial" },
                "text": text.chars().take(2000).collect::<String>(),
            }),
        );
    })
    .copy();

    let task: *mut Object = unsafe {
        msg_send![recognizer, recognitionTaskWithRequest: request resultHandler: &*handler]
    };
    if task.is_null() {
        unsafe {
            let _: () = msg_send![input, removeTapOnBus: 0usize];
        }
        release(engine);
        release(request);
        release(recognizer);
        return Err("听写暂时没能开始。文字输入不受影响。".into());
    }
    unsafe {
        let _: *mut Object = msg_send![task, retain];
        let _: () = msg_send![engine, prepare];
        let mut err: *mut Object = std::ptr::null_mut();
        let started: bool = msg_send![engine, startAndReturnError: &mut err];
        if !started {
            let detail = if err.is_null() {
                String::new()
            } else {
                ns_to_string(msg_send![err, localizedDescription])
            };
            let _: () = msg_send![task, cancel];
            let _: () = msg_send![input, removeTapOnBus: 0usize];
            release(task);
            release(engine);
            release(request);
            release(recognizer);
            let extra = if detail.is_empty() { String::new() } else { format!("（{detail}）") };
            return Err(format!("听写暂时没能开始{extra}。文字输入不受影响。"));
        }
    }

    Ok(Session {
        request: request as usize,
        engine: engine as usize,
        input: input as usize,
        recognizer: recognizer as usize,
        task: task as usize,
        tapped: true,
        running,
        level_bits,
        keep: Box::new(Keep((tap, handler))),
    })
}

#[cfg(target_os = "macos")]
fn result_text(result: *mut objc::runtime::Object) -> String {
    unsafe {
        let transcription: *mut objc::runtime::Object = objc::msg_send![result, bestTranscription];
        if transcription.is_null() {
            return String::new();
        }
        let text: *mut objc::runtime::Object = objc::msg_send![transcription, formattedString];
        ns_to_string(text)
    }
}

#[cfg(target_os = "macos")]
fn shutdown(session: Session) {
    session.running.store(false, Ordering::Relaxed);
    let request = session.request as *mut objc::runtime::Object;
    let engine = session.engine as *mut objc::runtime::Object;
    let input = session.input as *mut objc::runtime::Object;
    let task = session.task as *mut objc::runtime::Object;
    unsafe {
        if !request.is_null() {
            let _: () = objc::msg_send![request, endAudio];
        }
        if session.tapped && !input.is_null() {
            let _: () = objc::msg_send![input, removeTapOnBus: 0usize];
        }
        if !engine.is_null() {
            let _: () = objc::msg_send![engine, stop];
        }
        if !task.is_null() {
            let _: () = objc::msg_send![task, cancel];
        }
    }
    release(task);
    release(engine);
    release(request);
    release(session.recognizer as *mut objc::runtime::Object);
}

#[cfg(test)]
mod tests {
    use super::{compute_audio_level, dictation_permission_error};

    #[test]
    fn audio_level_normalizes_silence_and_speech() {
        assert_eq!(compute_audio_level(&[]), 0.0);
        assert_eq!(compute_audio_level(&[0.0; 256]), 0.0);
        assert_eq!(compute_audio_level(&[0.001; 256]), 0.0);
        let speech = compute_audio_level(&[0.04; 256]);
        assert!(speech > 0.2 && speech < 0.95, "speech level was {speech}");
        let loud = compute_audio_level(&[0.9, -0.9, f32::NAN]);
        assert!(loud > 0.9 && loud <= 1.0, "loud level was {loud}");
    }

    #[test]
    fn denied_permissions_explain_where_to_enable_them() {
        assert!(dictation_permission_error("denied", "authorized")
            .unwrap()
            .contains("麦克风"));
        assert!(dictation_permission_error("authorized", "denied")
            .unwrap()
            .contains("语音识别"));
        assert!(dictation_permission_error("not_determined", "not_determined").is_none());
        assert!(dictation_permission_error("authorized", "authorized").is_none());
    }
}
