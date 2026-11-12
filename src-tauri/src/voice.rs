//! Xiaomi MiMo TTS (`mimo-v2.5-tts`) with local `0600` credential vault storage.
//! User text is sent as structured request data. MiMo audio plays from a private
//! temp WAV via `afplay`.

use crate::storage::read_key;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

const MAX_CHARS: usize = 4_000;
const DEFAULT_MIMO_BASE: &str = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL: &str = "mimo-v2.5-tts";
const DEFAULT_MIMO_VOICE: &str = "冰糖";
const DICTATION_MESSAGE: &str = "听写还没有接入。当前只查询麦克风和语音识别权限，不会弹出系统授权框，也不会把声音发给模型。文字输入不受影响。";
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

struct ActivePlayback {
    child: Child,
    temp_file: Option<PathBuf>,
}

impl ActivePlayback {
    fn cleanup_file(&mut self) {
        if let Some(path) = self.temp_file.take() {
            let _ = fs::remove_file(path);
        }
    }

    fn kill_and_clean(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.cleanup_file();
    }
}

#[derive(Clone, Default)]
pub struct Speech(Arc<Mutex<Option<ActivePlayback>>>);

impl Speech {
    pub fn stop_active(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut active) = guard.take() {
                active.kill_and_clean();
            }
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MimoTtsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
    #[serde(default)]
    pub style: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakOutcome {
    pub provider: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub implemented: bool,
    pub microphone: String,
    pub speech_recognition: String,
    pub message: String,
}

#[tauri::command]
pub async fn voice_speak(
    speech: tauri::State<'_, Speech>,
    text: String,
    mimo: Option<MimoTtsConfig>,
    emotion: Option<String>,
) -> Result<SpeakOutcome, String> {
    validate_speech_text(&text)?;
    let cfg = mimo
        .filter(|cfg| cfg.enabled)
        .ok_or_else(|| "尚未配置 MiMo 语音，请到设置中保存 API Key".to_string())?;
    let speech_state = speech.inner().clone();
    let wav_bytes = synthesize_mimo_wav(&text, &cfg, emotion.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || play_wav_bytes(&speech_state, &wav_bytes))
        .await
        .map_err(|_| "音频播放任务失败".to_string())??;
    Ok(SpeakOutcome {
        provider: "mimo".into(),
    })
}

#[tauri::command]
pub async fn voice_stop(speech: tauri::State<'_, Speech>) -> Result<(), String> {
    let speech = speech.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_speech(&speech))
        .await
        .map_err(|_| "停止朗读失败".to_string())?
}

#[tauri::command]
pub fn voice_permission_status() -> DictationStatus {
    permission_status()
}

pub(crate) fn mimo_endpoint(raw_base: &str) -> Result<String, String> {
    let base = if raw_base.trim().is_empty() {
        DEFAULT_MIMO_BASE
    } else {
        raw_base.trim()
    };
    let parsed = url::Url::parse(base).map_err(|_| "MiMo API 地址格式无效")?;
    let host = parsed.host_str().ok_or("MiMo API 地址缺少主机名")?;
    let local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        return Err("MiMo API 地址必须使用 HTTPS（本机调试除外）".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() {
        return Err("MiMo API 地址不能包含凭据或查询参数".into());
    }
    Ok(format!("{}/chat/completions", base.trim_end_matches('/')))
}

pub(crate) fn mimo_style_prompt(style: &str, emotion: Option<&str>) -> String {
    let base = if style.trim().is_empty() {
        "自然亲切、温和清晰的桌面伙伴语气，吐字干净，节奏舒服。"
    } else {
        style.trim()
    };
    let mood = match emotion.unwrap_or("").trim() {
        "happy" | "wink" => "带着轻快开心的笑意，尾音微微上扬。",
        "coy" => "略带一点不好意思的温柔笑意。",
        "surprised" => "带着一点好奇与小惊喜的语气。",
        "confused" | "think" => "认真思考后温和解答的语气。",
        "sad" => "轻声安慰、柔和体贴的语气。",
        "sleepy" | "sleep" => "轻柔放松、语速略微放慢，像轻声道晚安。",
        "remind" => "温和提醒、清晰但不生硬的语气。",
        _ => "",
    };
    if mood.is_empty() {
        base.to_string()
    } else {
        format!("{base} {mood}")
    }
}

pub(crate) fn mimo_request_body(text: &str, cfg: &MimoTtsConfig, emotion: Option<&str>) -> Value {
    let model = if cfg.model.trim().is_empty() {
        DEFAULT_MIMO_MODEL
    } else {
        cfg.model.trim()
    };
    let voice = if cfg.voice.trim().is_empty() {
        DEFAULT_MIMO_VOICE
    } else {
        cfg.voice.trim()
    };
    let style = mimo_style_prompt(&cfg.style, emotion);
    let audio = if model == "mimo-v2.5-tts-voicedesign" {
        json!({ "format": "wav" })
    } else {
        json!({ "format": "wav", "voice": voice })
    };
    json!({
        "model": model,
        "messages": [
            { "role": "user", "content": style },
            { "role": "assistant", "content": text }
        ],
        "audio": audio,
        "stream": false
    })
}

pub(crate) fn decode_mimo_response(data: &Value) -> Result<Vec<u8>, String> {
    let encoded = data["choices"]
        .get(0)
        .and_then(|c| c["message"]["audio"]["data"].as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "MiMo 语音服务未返回音频数据".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "MiMo 音频数据解码失败".to_string())
}

async fn synthesize_mimo_wav(
    text: &str,
    cfg: &MimoTtsConfig,
    emotion: Option<&str>,
) -> Result<Vec<u8>, String> {
    let endpoint = mimo_endpoint(&cfg.base)?;
    let key = read_key("tts")?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "语音网络组件初始化失败".to_string())?;
    let body = mimo_request_body(text, cfg, emotion);
    let response = client
        .post(&endpoint)
        .header("api-key", key.trim())
        .bearer_auth(key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|_| "MiMo 语音连接超时或网络不可用".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "MiMo API Key 无效或无语音合成权限".into(),
            402 => "MiMo 账户余额或 Token Plan 额度不足".into(),
            421 => "MiMo 服务地域或接入点不匹配，请检查 API 地址".into(),
            429 => "MiMo 语音请求过于频繁，请稍后重试".into(),
            code => format!("MiMo 语音服务暂不可用（HTTP {code}）"),
        });
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "MiMo 语音返回格式无效".to_string())?;
    decode_mimo_response(&payload)
}

fn play_wav_bytes(speech: &Speech, wav_bytes: &[u8]) -> Result<(), String> {
    if wav_bytes.len() < 44 {
        return Err("MiMo 返回的音频文件过短".into());
    }
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("kbot-mimo-{}-{seq}.wav", std::process::id()));
    {
        let mut file = fs::File::create(&path).map_err(|_| "无法写入临时语音文件")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
        file.write_all(wav_bytes)
            .map_err(|_| "无法写入临时语音文件")?;
    }
    let child = match Command::new("/usr/bin/afplay")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Err("无法启动 macOS 音频播放（afplay）".into());
        }
    };
    install_active(
        speech,
        ActivePlayback {
            child,
            temp_file: Some(path),
        },
    )
}

fn validate_speech_text(text: &str) -> Result<(), String> {
    if text.is_empty() || text.chars().all(char::is_whitespace) {
        return Err("没有可以朗读的文本".into());
    }
    if text.chars().count() > MAX_CHARS {
        return Err("朗读文本过长".into());
    }
    if text.contains('\0') {
        return Err("朗读文本无效".into());
    }
    Ok(())
}

fn install_active(speech: &Speech, next: ActivePlayback) -> Result<(), String> {
    let mut guard = speech.0.lock().map_err(|_| "朗读状态不可用")?;
    reap(&mut guard);
    if let Some(mut previous) = guard.take() {
        previous.kill_and_clean();
    }
    *guard = Some(next);
    Ok(())
}

fn stop_speech(speech: &Speech) -> Result<(), String> {
    let mut guard = speech.0.lock().map_err(|_| "朗读状态不可用")?;
    if let Some(mut active) = guard.take() {
        active.kill_and_clean();
    }
    Ok(())
}

fn reap(slot: &mut Option<ActivePlayback>) {
    let done = match slot.as_mut() {
        Some(active) => match active.child.try_wait() {
            Ok(Some(_)) | Err(_) => true,
            Ok(None) => false,
        },
        None => false,
    };
    if done {
        if let Some(mut finished) = slot.take() {
            finished.cleanup_file();
        }
    }
}

pub(crate) fn permission_status() -> DictationStatus {
    DictationStatus {
        implemented: false,
        microphone: microphone_state(),
        speech_recognition: speech_state(),
        message: DICTATION_MESSAGE.into(),
    }
}

pub(crate) fn av_label(code: isize) -> &'static str {
    match code {
        0 => "not_determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        _ => "unknown",
    }
}

pub(crate) fn speech_label(code: isize) -> &'static str {
    match code {
        0 => "not_determined",
        1 => "denied",
        2 => "restricted",
        3 => "authorized",
        _ => "unknown",
    }
}

#[cfg(target_os = "macos")]
fn microphone_state() -> String {
    framework_status(
        "/System/Library/Frameworks/AVFoundation.framework/AVFoundation",
        "AVCaptureDevice",
        true,
    )
    .map(|code| av_label(code).to_string())
    .unwrap_or_else(|| "unknown".into())
}

#[cfg(not(target_os = "macos"))]
fn microphone_state() -> String {
    "unsupported".into()
}

#[cfg(target_os = "macos")]
fn speech_state() -> String {
    framework_status(
        "/System/Library/Frameworks/Speech.framework/Speech",
        "SFSpeechRecognizer",
        false,
    )
    .map(|code| speech_label(code).to_string())
    .unwrap_or_else(|| "unknown".into())
}

#[cfg(not(target_os = "macos"))]
fn speech_state() -> String {
    "unsupported".into()
}

#[cfg(target_os = "macos")]
fn framework_status(path: &str, class_name: &str, audio: bool) -> Option<isize> {
    use objc::runtime::Class;
    unsafe extern "C" {
        fn dlopen(path: *const i8, mode: i32) -> *mut std::ffi::c_void;
    }
    let c_path = std::ffi::CString::new(path).ok()?;
    if unsafe { dlopen(c_path.as_ptr(), 1) }.is_null() {
        return None;
    }
    let cls = Class::get(class_name)?;
    unsafe {
        let pool: *mut objc::runtime::Object = msg_send![class!(NSAutoreleasePool), new];
        let code: isize = if audio {
            let media = ns_string("soun");
            if media.is_null() {
                let _: () = msg_send![pool, drain];
                return None;
            }
            msg_send![cls, authorizationStatusForMediaType: media]
        } else {
            msg_send![cls, authorizationStatus]
        };
        let _: () = msg_send![pool, drain];
        Some(code)
    }
}

#[cfg(target_os = "macos")]
fn ns_string(text: &str) -> *mut objc::runtime::Object {
    let Ok(c_text) = std::ffi::CString::new(text) else {
        return std::ptr::null_mut();
    };
    unsafe {
        let string: *mut objc::runtime::Object =
            msg_send![class!(NSString), stringWithUTF8String: c_text.as_ptr()];
        string
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_text_is_validated_without_shell_arguments() {
        let bubble = "他说\"$HOME\" && rm\n第二行，原文保持";
        assert!(validate_speech_text(bubble).is_ok());
        assert!(validate_speech_text("  ").is_err());
        assert!(validate_speech_text("hello\0world").is_err());
        assert!(validate_speech_text(&"x".repeat(MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn mimo_request_and_response_match_documented_schema() {
        assert_eq!(
            mimo_endpoint("").unwrap(),
            "https://api.xiaomimimo.com/v1/chat/completions"
        );
        assert_eq!(
            mimo_endpoint("https://token-plan-cn.xiaomimimo.com/v1/").unwrap(),
            "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
        );
        assert!(mimo_endpoint("http://api.xiaomimimo.com/v1").is_err());
        assert!(mimo_endpoint("https://api.xiaomimimo.com/v1?api_key=leak").is_err());

        let cfg = MimoTtsConfig {
            enabled: true,
            base: "https://api.xiaomimimo.com/v1".into(),
            model: "mimo-v2.5-tts".into(),
            voice: "冰糖".into(),
            style: "元气可爱".into(),
        };
        let body = mimo_request_body("早安呀！", &cfg, Some("happy"));
        assert_eq!(body["model"], "mimo-v2.5-tts");
        assert_eq!(body["audio"]["voice"], "冰糖");
        assert_eq!(body["audio"]["format"], "wav");
        assert_eq!(body["messages"][1]["role"], "assistant");
        assert_eq!(body["messages"][1]["content"], "早安呀！");
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("笑意"));

        let wav = b"RIFF$\x00\x00\x00WAVEfmt ";
        let encoded = base64::engine::general_purpose::STANDARD.encode(wav);
        let decoded = decode_mimo_response(&json!({
            "choices": [{ "message": { "audio": { "data": encoded } } }]
        }))
        .unwrap();
        assert_eq!(decoded, wav);
        assert!(decode_mimo_response(&json!({ "choices": [] })).is_err());
    }

    #[test]
    fn permission_labels_do_not_prompt() {
        assert_eq!(av_label(2), "denied");
        assert_eq!(speech_label(1), "denied");
        assert_eq!(speech_label(3), "authorized");
        let status = permission_status();
        assert!(!status.implemented);
        assert!(!status.message.is_empty());
        assert!(matches!(
            status.microphone.as_str(),
            "not_determined" | "restricted" | "denied" | "authorized" | "unknown" | "unsupported"
        ));
        assert!(matches!(
            status.speech_recognition.as_str(),
            "not_determined" | "restricted" | "denied" | "authorized" | "unknown" | "unsupported"
        ));
    }

}
