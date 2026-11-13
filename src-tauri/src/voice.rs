//! Xiaomi MiMo TTS (`mimo-v2.5-tts`) with local `0600` credential vault storage.
//! User text is sent as structured request data, one short sentence segment per
//! request; the next segment is synthesized while the current one plays from a
//! private temp WAV via `afplay`.

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
/// 预置音色：切成约 60 字的小段边合成边播，几秒就能开口；音色固定，段间只有轻微的语气差别。
const SEGMENT_CHARS: usize = 60;
/// “音色设计”模型每次请求都按描述重新生成一个声音，切段就等于换一个人说话。
/// 所以尽量整篇一次合成（自动朗读最多 200 字，正好一段），代价是开口前要等更久。
const DESIGN_SEGMENT_CHARS: usize = 400;
// MiMo 不支持低延迟流式：约 60 字的一段实测要合成 7～8 秒，一整段 270 字要 20～32 秒；400 字的一段留足 60 秒。
const SEGMENT_TIMEOUT: Duration = Duration::from_secs(60);
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

enum Playback {
    Playing,
    Finished,
    Cancelled,
}

/// `generation` changes whenever speech is stopped or a new utterance starts, so a
/// pipeline still synthesizing an older utterance knows to give up.
#[derive(Clone, Default)]
pub struct Speech {
    active: Arc<Mutex<Option<ActivePlayback>>>,
    generation: Arc<AtomicU64>,
}

impl Speech {
    pub fn stop_active(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.kill_playback();
    }

    fn begin(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.kill_playback();
        generation
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn kill_playback(&self) {
        if let Ok(mut guard) = self.active.lock() {
            if let Some(mut active) = guard.take() {
                active.kill_and_clean();
            }
        }
    }

    fn poll_playback(&self, generation: u64) -> Playback {
        let Ok(mut guard) = self.active.lock() else {
            return Playback::Cancelled;
        };
        if !self.is_current(generation) {
            return Playback::Cancelled;
        }
        let playing = match guard.as_mut() {
            Some(active) => matches!(active.child.try_wait(), Ok(None)),
            None => false,
        };
        if playing {
            return Playback::Playing;
        }
        if let Some(mut finished) = guard.take() {
            finished.cleanup_file();
        }
        Playback::Finished
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
    let max = segment_chars(&cfg.model);
    let synth = MimoSynth::new(cfg, emotion)?;
    let speech = speech.inner().clone();
    let generation = speech.begin();
    speak_segments(&speech, generation, &synth, split_segments(&text, max))
    .await?;
    Ok(SpeakOutcome {
        provider: "mimo".into(),
    })
}

#[tauri::command]
pub async fn voice_stop(speech: tauri::State<'_, Speech>) -> Result<(), String> {
    let speech = speech.inner().clone();
    tauri::async_runtime::spawn_blocking(move || speech.stop_active())
        .await
        .map_err(|_| "停止朗读失败".to_string())
}

/// Resolves once every segment has played, or early with `Ok` when the utterance was
/// stopped or replaced. Only failures of the still-current utterance are reported.
async fn speak_segments(
    speech: &Speech,
    generation: u64,
    synth: &MimoSynth,
    segments: Vec<String>,
) -> Result<(), String> {
    let spawn = |text: String| tauri::async_runtime::spawn(synth.clone().wav(text));
    let mut queue = segments.into_iter();
    let mut next = queue.next().map(spawn);
    while let Some(task) = next.take() {
        let wav = task.await.map_err(|_| "语音合成任务失败".to_string());
        next = queue.next().map(spawn);
        let played = match wav {
            Ok(Ok(wav)) => play_segment(speech, generation, wav).await,
            Ok(Err(err)) | Err(err) => Err(err),
        };
        match played {
            Ok(true) => {}
            Ok(false) => break,
            Err(err) => {
                if let Some(task) = next.take() {
                    task.abort();
                }
                return if speech.is_current(generation) {
                    Err(err)
                } else {
                    Ok(())
                };
            }
        }
    }
    if let Some(task) = next {
        task.abort();
    }
    Ok(())
}

/// `Ok(true)` when the segment played to the end, `Ok(false)` when it was cancelled.
async fn play_segment(speech: &Speech, generation: u64, wav: Vec<u8>) -> Result<bool, String> {
    if !speech.is_current(generation) {
        return Ok(false);
    }
    let starter = speech.clone();
    let started =
        tauri::async_runtime::spawn_blocking(move || play_wav_bytes(&starter, generation, &wav))
            .await
            .map_err(|_| "音频播放任务失败".to_string())??;
    if !started {
        return Ok(false);
    }
    loop {
        tokio::time::sleep(Duration::from_millis(80)).await;
        match speech.poll_playback(generation) {
            Playback::Playing => {}
            Playback::Finished => return Ok(true),
            Playback::Cancelled => return Ok(false),
        }
    }
}

pub(crate) fn segment_chars(model: &str) -> usize {
    if model.trim() == "mimo-v2.5-tts-voicedesign" {
        DESIGN_SEGMENT_CHARS
    } else {
        SEGMENT_CHARS
    }
}

pub(crate) fn split_segments(text: &str, max: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    push_pieces(
        text,
        max,
        &[is_sentence_end, is_clause_end, is_space],
        &mut pieces,
    );
    let mut segments = Vec::new();
    let mut current = String::new();
    for piece in pieces {
        if !current.trim().is_empty() && current.chars().count() + piece.chars().count() > max {
            segments.push(current.trim().to_string());
            current.clear();
        }
        current.push_str(&piece);
    }
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    segments
}

type Boundary = fn(char, Option<char>) -> bool;

fn push_pieces(text: &str, max: usize, levels: &[Boundary], out: &mut Vec<String>) {
    if text.chars().count() <= max {
        out.push(text.to_string());
        return;
    }
    match levels.split_first() {
        Some((is_end, rest)) => {
            for part in split_after(text, *is_end) {
                push_pieces(&part, max, rest, out);
            }
        }
        None => {
            let chars: Vec<char> = text.chars().collect();
            out.extend(
                chars
                    .chunks(max)
                    .map(|chunk| chunk.iter().collect::<String>()),
            );
        }
    }
}

/// Cuts after each boundary run, keeping the boundary and following whitespace with
/// the left part so the pieces concatenate back to the original text.
fn split_after(text: &str, is_end: Boundary) -> Vec<String> {
    let mut parts = Vec::new();
    let mut buf = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        buf.push(c);
        let next = chars.peek().copied();
        if is_end(c, next) && !next.is_some_and(|n| is_end(n, None)) {
            while let Some(&w) = chars.peek() {
                if !w.is_whitespace() {
                    break;
                }
                buf.push(w);
                chars.next();
            }
            parts.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        parts.push(buf);
    }
    parts
}

fn is_sentence_end(c: char, next: Option<char>) -> bool {
    matches!(c, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '…' | '\n')
        || (c == '.' && next.map_or(true, char::is_whitespace))
}

fn is_clause_end(c: char, _: Option<char>) -> bool {
    matches!(c, '，' | ',' | '、' | '：' | ':')
}

fn is_space(c: char, _: Option<char>) -> bool {
    c.is_whitespace()
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
        "沉稳得体的管家语气，吐字清晰，节奏从容。"
    } else {
        style.trim()
    };
    let mood = match emotion.unwrap_or("").trim() {
        "happy" | "wink" | "coy" => "语气里带一点愉快的笑意，依然克制。",
        "surprised" => "略带意外，随即恢复从容。",
        "confused" | "think" => "边斟酌边作答，语速稍缓。",
        "sad" => "声音放轻，体贴而克制。",
        "sleepy" | "sleep" => "声音放轻，语速放慢，像在道晚安。",
        "remind" => "清晰郑重的提醒，不生硬。",
        "annoyed" => "语气略微收紧，仍然礼貌。",
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

#[derive(Clone)]
struct MimoSynth {
    endpoint: String,
    key: String,
    client: reqwest::Client,
    cfg: MimoTtsConfig,
    emotion: Option<String>,
}

impl MimoSynth {
    fn new(cfg: MimoTtsConfig, emotion: Option<String>) -> Result<Self, String> {
        let endpoint = mimo_endpoint(&cfg.base)?;
        let key = read_key("tts")?.trim().to_string();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(6))
            .timeout(SEGMENT_TIMEOUT)
            .build()
            .map_err(|_| "语音网络组件初始化失败".to_string())?;
        Ok(Self {
            endpoint,
            key,
            client,
            cfg,
            emotion,
        })
    }

    async fn wav(self, text: String) -> Result<Vec<u8>, String> {
        let body = mimo_request_body(&text, &self.cfg, self.emotion.as_deref());
        let response = self
            .client
            .post(&self.endpoint)
            .header("api-key", &self.key)
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .map_err(network_error)?;
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
        let payload: Value = response.json().await.map_err(|err| {
            if err.is_timeout() {
                network_error(err)
            } else {
                "MiMo 语音返回格式无效".to_string()
            }
        })?;
        decode_mimo_response(&payload)
    }
}

fn network_error(err: reqwest::Error) -> String {
    if err.is_timeout() {
        format!("MiMo 语音合成超时（{} 秒）", SEGMENT_TIMEOUT.as_secs())
    } else {
        "MiMo 语音连接失败，请检查网络".to_string()
    }
}

/// `Ok(false)` when the utterance was stopped or replaced before playback could start.
fn play_wav_bytes(speech: &Speech, generation: u64, wav_bytes: &[u8]) -> Result<bool, String> {
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
        generation,
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

fn install_active(
    speech: &Speech,
    generation: u64,
    mut next: ActivePlayback,
) -> Result<bool, String> {
    let mut guard = speech.active.lock().map_err(|_| "朗读状态不可用")?;
    if !speech.is_current(generation) {
        next.kill_and_clean();
        return Ok(false);
    }
    reap(&mut guard);
    if let Some(mut previous) = guard.take() {
        previous.kill_and_clean();
    }
    *guard = Some(next);
    Ok(true)
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
    fn long_text_is_split_into_short_sentence_segments() {
        let text = "好的，先生。我已经检查了你今天的日程安排，上午十点有一个产品评审会议，下午两点需要和设计团队对齐新版本的交互细节。另外，傍晚可能下雨！记得带伞。";
        let segments = split_segments(text, SEGMENT_CHARS);
        assert!(segments.len() > 1);
        assert!(segments.iter().all(|s| s.chars().count() <= SEGMENT_CHARS));
        assert_eq!(segments.concat(), text);

        // 音色设计模型每段都会换一个声音：自动朗读的长度整篇一次合成，更长的只在句末切开
        let design = segment_chars("mimo-v2.5-tts-voicedesign");
        assert_eq!(segment_chars("mimo-v2.5-tts"), SEGMENT_CHARS);
        assert_eq!(split_segments(text, design), vec![text]);
        let long = text.repeat(8);
        let segments = split_segments(&long, design);
        assert!(segments.len() > 1);
        assert!(segments.iter().all(|s| s.ends_with('。') || s.ends_with('！')));
        assert_eq!(segments.concat(), long);

        assert_eq!(
            split_segments("你好。我在。", SEGMENT_CHARS),
            vec!["你好。我在。"]
        );
        assert_eq!(
            split_segments("Version 2.5 is ready. All systems online.", 25),
            vec!["Version 2.5 is ready.", "All systems online."]
        );
        let run = "字".repeat(SEGMENT_CHARS * 2 + 5);
        let segments = split_segments(&run, SEGMENT_CHARS);
        assert_eq!(segments.len(), 3);
        assert!(segments.iter().all(|s| s.chars().count() <= SEGMENT_CHARS));
        assert!(split_segments("  \n ", SEGMENT_CHARS).is_empty());
    }

    #[test]
    fn new_speech_or_stop_cancels_the_running_pipeline() {
        let speech = Speech::default();
        let first = speech.begin();
        assert!(speech.is_current(first));
        let second = speech.begin();
        assert!(!speech.is_current(first));
        assert!(speech.is_current(second));
        speech.stop_active();
        assert!(!speech.is_current(second));
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
