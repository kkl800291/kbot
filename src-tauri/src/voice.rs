//! Alibaba Cloud DashScope Qwen3-TTS (`qwen3-tts-flash` / `qwen3-tts-instruct-flash`)
//! sharing the unified DashScope credential (`realtime`, with legacy `tts` fallback).
//! User text is sent as short sentence segments; the next segment is synthesized
//! while the current one plays from a private temp audio file via `afplay`.

use crate::storage::read_key;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Child,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(not(target_os = "windows"))]
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

const MAX_CHARS: usize = 4_000;
/// 预置音色：切成约 120 字的小段边合成边播，首句几百毫秒级即可开口。
const SEGMENT_CHARS: usize = 120;
const INSTRUCT_SEGMENT_CHARS: usize = 320;
const SEGMENT_TIMEOUT: Duration = Duration::from_secs(35);
const DEFAULT_QWEN_TTS_BASE: &str = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_QWEN_TTS_MODEL: &str = "qwen3-tts-flash";
const DEFAULT_QWEN_TTS_VOICE: &str = "Cherry";
#[cfg(target_os = "macos")]
const DICTATION_MESSAGE: &str = "听写使用 macOS 本机语音识别。声音不会发给对话模型，识别结果只写入输入框，不会自动发送。";
#[cfg(not(target_os = "macos"))]
const DICTATION_MESSAGE: &str = "听写使用本机麦克风采集并转为文字。声音不会发给对话模型，识别结果只写入输入框，不会自动发送。";
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

enum ActivePlayback {
    Process {
        child: Child,
        temp_file: Option<PathBuf>,
    },
    #[cfg(target_os = "windows")]
    WinMemory {
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
    },
}

impl ActivePlayback {
    fn cleanup_file(&mut self) {
        #[allow(irrefutable_let_patterns)]
        if let ActivePlayback::Process { temp_file, .. } = self {
            if let Some(path) = temp_file.take() {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn kill_and_clean(&mut self) {
        match self {
            ActivePlayback::Process { child, .. } => {
                let _ = child.kill();
                let _ = child.wait();
                self.cleanup_file();
            }
            #[cfg(target_os = "windows")]
            ActivePlayback::WinMemory { stop, .. } => {
                stop.store(true, Ordering::Release);
            }
        }
    }

    fn is_running(&mut self) -> bool {
        match self {
            ActivePlayback::Process { child, .. } => matches!(child.try_wait(), Ok(None)),
            #[cfg(target_os = "windows")]
            ActivePlayback::WinMemory { finished, .. } => !finished.load(Ordering::Acquire),
        }
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

    pub(crate) fn begin(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.kill_playback();
        generation
    }

    pub(crate) fn is_current(&self, generation: u64) -> bool {
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
            Some(active) => active.is_running(),
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
pub struct QwenTtsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub managed: bool,
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
    tts: Option<QwenTtsConfig>,
    mimo: Option<QwenTtsConfig>,
    emotion: Option<String>,
) -> Result<SpeakOutcome, String> {
    validate_speech_text(&text)?;
    let cfg = tts
        .or(mimo)
        .filter(|cfg| cfg.enabled)
        .ok_or_else(|| "尚未配置千问语音服务，请先登录或到设置 → 语音中配置 API Key".to_string())?;
    let max = segment_chars(&cfg.model);
    let synth = QwenSynth::new(cfg, emotion)?;
    let speech = speech.inner().clone();
    let generation = speech.begin();
    speak_segments(&speech, generation, &synth, split_segments(&text, max)).await?;
    Ok(SpeakOutcome {
        provider: "qwen".into(),
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
    synth: &QwenSynth,
    segments: Vec<String>,
) -> Result<(), String> {
    let spawn = |text: String| tauri::async_runtime::spawn(synth.clone().audio(text));
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
pub(crate) async fn play_segment(speech: &Speech, generation: u64, wav: Vec<u8>) -> Result<bool, String> {
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
        tokio::time::sleep(Duration::from_millis(20)).await;
        match speech.poll_playback(generation) {
            Playback::Playing => {}
            Playback::Finished => return Ok(true),
            Playback::Cancelled => return Ok(false),
        }
    }
}

pub(crate) fn segment_chars(model: &str) -> usize {
    if model.trim().contains("instruct") {
        INSTRUCT_SEGMENT_CHARS
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

pub(crate) fn qwen_tts_endpoint(raw_base: &str) -> Result<String, String> {
    let raw = raw_base.trim();
    let base = if raw.is_empty() || raw.contains("xiaomimimo.com") {
        DEFAULT_QWEN_TTS_BASE
    } else {
        raw
    };
    let mut parsed = url::Url::parse(base).map_err(|_| "千问语音 API 地址格式无效")?;
    let host = parsed.host_str().ok_or("千问语音 API 地址缺少主机名")?;
    let local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if parsed.scheme() == "wss" {
        parsed.set_scheme("https").map_err(|_| "千问语音 API 地址协议无效")?;
    } else if parsed.scheme() == "ws" && local {
        parsed.set_scheme("http").map_err(|_| "千问语音 API 地址协议无效")?;
    }
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        return Err("千问语音 API 地址必须使用 HTTPS（本机调试除外）".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() {
        return Err("千问语音 API 地址不能包含凭据或查询参数".into());
    }
    let path = parsed.path().trim_end_matches('/');
    if path.ends_with("/services/aigc/multimodal-generation/generation") {
        return Ok(parsed.to_string());
    }
    if path.is_empty()
        || path == "/api-ws/v1/realtime"
        || path == "/api/v1"
        || path == "/compatible-mode/v1"
    {
        parsed.set_path("/api/v1/services/aigc/multimodal-generation/generation");
    } else {
        parsed.set_path(&format!("{path}/services/aigc/multimodal-generation/generation"));
    }
    Ok(parsed.to_string())
}

pub(crate) fn normalize_qwen_tts_model(raw: &str) -> &str {
    let m = raw.trim();
    if m.is_empty() || m.starts_with("mimo") {
        DEFAULT_QWEN_TTS_MODEL
    } else {
        m
    }
}

pub(crate) fn normalize_qwen_tts_voice(raw: &str) -> &str {
    let v = raw.trim();
    if v.is_empty()
        || matches!(
            v,
            "冰糖" | "茉莉" | "苏打" | "白桦" | "mimo_default" | "Mia" | "Chloe" | "Milo" | "Dean"
        )
    {
        DEFAULT_QWEN_TTS_VOICE
    } else {
        v
    }
}

pub(crate) fn qwen_style_prompt(style: &str, emotion: Option<&str>) -> String {
    let base = if style.trim().is_empty() {
        "自然干练的桌面搭档口吻，吐字清晰，节奏从容；英文名 Kbot 连读作一个词，不要逐字母拼读。"
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

pub(crate) fn qwen_tts_request_body(
    text: &str,
    cfg: &QwenTtsConfig,
    emotion: Option<&str>,
) -> Value {
    let model = normalize_qwen_tts_model(&cfg.model);
    let voice = normalize_qwen_tts_voice(&cfg.voice);
    let mut input = json!({
        "text": text,
        "voice": voice,
        "language_type": "Auto",
    });
    if model.contains("instruct") {
        input["instructions"] = json!(qwen_style_prompt(&cfg.style, emotion));
        return json!({
            "model": model,
            "input": input,
            "parameters": {
                "optimize_instructions": true
            }
        });
    }
    json!({
        "model": model,
        "input": input
    })
}

pub(crate) enum QwenAudioPayload {
    Bytes(Vec<u8>),
    Url(String),
}

pub(crate) fn decode_qwen_tts_response(data: &Value) -> Result<QwenAudioPayload, String> {
    if let Some(encoded) = data["output"]["audio"]["data"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "千问语音音频数据解码失败".to_string())?;
        return Ok(QwenAudioPayload::Bytes(bytes));
    }
    if let Some(url) = data["output"]["audio"]["url"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(QwenAudioPayload::Url(url.to_string()));
    }
    let message = data["message"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Err(message
        .map(|m| format!("千问语音合成失败：{m}"))
        .unwrap_or_else(|| "千问语音服务未返回音频数据".to_string()))
}

fn read_tts_auth_key(managed: bool) -> Result<String, String> {
    if managed {
        let key = read_key("managed")
            .map_err(|_| "尚未建立云端托管会话，请先免费领取体验额度或登录账号".to_string())?;
        let trimmed = key.trim().to_string();
        if trimmed.is_empty() {
            return Err("云端托管会话无效，请重新连接或切换自带 API Key".into());
        }
        return Ok(trimmed);
    }
    if let Ok(key) = read_key("realtime") {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    if let Ok(key) = read_key("tts") {
        let trimmed = key.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    Err("尚未配置千问语音 API Key，请先领取体验额度或到设置 → 语音中填写".into())
}

pub(crate) fn format_qwen_http_error(code: u16, raw_body: &str) -> String {
    let detail = serde_json::from_str::<Value>(raw_body)
        .ok()
        .and_then(|v| {
            let err_code = v["code"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let err_msg = v["message"].as_str().map(str::trim).filter(|s| !s.is_empty());
            match (err_code, err_msg) {
                (Some(c), Some(m)) => Some(format!("{c}: {m}")),
                (None, Some(m)) => Some(m.to_string()),
                (Some(c), None) => Some(c.to_string()),
                (None, None) => None,
            }
        });
    match (code, detail) {
        (401 | 403, Some(d)) => format!("千问语音 API Key 无效或尚未开通权限（{d}）"),
        (401 | 403, None) => "千问语音 API Key 无效或尚未开通权限".into(),
        (402, _) => "千问语音账户额度不足，请充值或检查配额".into(),
        (429, _) => "千问语音请求过于频繁，请稍后重试".into(),
        (_, Some(d)) => format!("千问语音服务暂不可用（HTTP {code} · {d}）"),
        (_, None) => format!("千问语音服务暂不可用（HTTP {code}）"),
    }
}

#[derive(Clone)]
struct QwenSynth {
    endpoint: String,
    key: String,
    client: reqwest::Client,
    cfg: QwenTtsConfig,
    emotion: Option<String>,
}

impl QwenSynth {
    fn new(cfg: QwenTtsConfig, emotion: Option<String>) -> Result<Self, String> {
        let endpoint = qwen_tts_endpoint(&cfg.base)?;
        let key = read_tts_auth_key(cfg.managed)?;
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

    async fn post_tts(&self, body: &Value) -> Result<Value, (u16, String)> {
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .json(body)
            .send()
            .await
            .map_err(|err| (0, network_error(err)))?;
        let status = response.status();
        let raw_text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let code = status.as_u16();
            return Err((code, format_qwen_http_error(code, &raw_text)));
        }
        serde_json::from_str::<Value>(&raw_text)
            .map_err(|_| (0, "千问语音返回格式无效".to_string()))
    }

    async fn audio(self, text: String) -> Result<Vec<u8>, String> {
        let body = qwen_tts_request_body(&text, &self.cfg, self.emotion.as_deref());
        let payload = match self.post_tts(&body).await {
            Ok(v) => v,
            Err((404, _))
                if normalize_qwen_tts_model(&self.cfg.model) != DEFAULT_QWEN_TTS_MODEL =>
            {
                let mut fallback_cfg = self.cfg.clone();
                fallback_cfg.model = DEFAULT_QWEN_TTS_MODEL.to_string();
                let fallback_body =
                    qwen_tts_request_body(&text, &fallback_cfg, self.emotion.as_deref());
                self.post_tts(&fallback_body)
                    .await
                    .map_err(|(_, msg)| msg)?
            }
            Err((_, msg)) => return Err(msg),
        };
        match decode_qwen_tts_response(&payload)? {
            QwenAudioPayload::Bytes(bytes) => Ok(bytes),
            QwenAudioPayload::Url(url) => {
                let parsed = url::Url::parse(&url).map_err(|_| "千问语音音频链接无效".to_string())?;
                if !matches!(parsed.scheme(), "https" | "http") {
                    return Err("千问语音音频链接协议无效".into());
                }
                let audio_resp = self
                    .client
                    .get(parsed)
                    .send()
                    .await
                    .map_err(network_error)?;
                if !audio_resp.status().is_success() {
                    return Err(format!(
                        "下载千问语音音频失败（HTTP {}）",
                        audio_resp.status().as_u16()
                    ));
                }
                let bytes = audio_resp
                    .bytes()
                    .await
                    .map_err(|_| "读取千问语音音频数据失败".to_string())?;
                Ok(bytes.to_vec())
            }
        }
    }
}

fn network_error(err: reqwest::Error) -> String {
    if err.is_timeout() {
        format!("千问语音合成超时（{} 秒）", SEGMENT_TIMEOUT.as_secs())
    } else {
        "千问语音连接失败，请检查网络".to_string()
    }
}

fn audio_extension(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        "wav"
    } else if bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0) {
        "mp3"
    } else {
        "wav"
    }
}

/// `Ok(false)` when the utterance was stopped or replaced before playback could start.
fn play_wav_bytes(speech: &Speech, generation: u64, audio_bytes: &[u8]) -> Result<bool, String> {
    if audio_bytes.len() < 44 {
        return Err("千问语音返回的音频文件过短".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::AtomicBool;
        let stop = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        crate::win_audio::play_audio_bytes(
            audio_bytes.to_vec(),
            Arc::clone(&stop),
            Arc::clone(&finished),
        )?;
        return install_active(
            speech,
            generation,
            ActivePlayback::WinMemory { stop, finished },
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let ext = audio_extension(audio_bytes);
        let path = std::env::temp_dir().join(format!("kbot-qwen-tts-{}-{seq}.{ext}", std::process::id()));
        {
            let mut file = fs::File::create(&path).map_err(|_| "无法写入临时语音文件")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
            }
            file.write_all(audio_bytes)
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
                return Err("无法启动音频播放组件".into());
            }
        };
        install_active(
            speech,
            generation,
            ActivePlayback::Process {
                child,
                temp_file: Some(path),
            },
        )
    }
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
        Some(active) => !active.is_running(),
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
        implemented: cfg!(any(target_os = "macos", target_os = "windows")),
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
pub(crate) fn microphone_state() -> String {
    framework_status(
        "/System/Library/Frameworks/AVFoundation.framework/AVFoundation",
        "AVCaptureDevice",
        true,
    )
    .map(|code| av_label(code).to_string())
    .unwrap_or_else(|| "unknown".into())
}

#[cfg(target_os = "windows")]
pub(crate) fn microphone_state() -> String {
    crate::win_audio::input_device_state()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(crate) fn microphone_state() -> String {
    "unsupported".into()
}

#[cfg(target_os = "macos")]
pub(crate) fn speech_state() -> String {
    framework_status(
        "/System/Library/Frameworks/Speech.framework/Speech",
        "SFSpeechRecognizer",
        false,
    )
    .map(|code| speech_label(code).to_string())
    .unwrap_or_else(|| "unknown".into())
}

#[cfg(target_os = "windows")]
pub(crate) fn speech_state() -> String {
    "authorized".into()
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub(crate) fn speech_state() -> String {
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
    fn qwen_tts_request_and_response_match_documented_schema() {
        assert_eq!(
            qwen_tts_endpoint("").unwrap(),
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(
            qwen_tts_endpoint("https://api.xiaomimimo.com/v1").unwrap(),
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(
            qwen_tts_endpoint("wss://dashscope.aliyuncs.com/api-ws/v1/realtime").unwrap(),
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(
            qwen_tts_endpoint("https://gateway.example.com/qwen").unwrap(),
            "https://gateway.example.com/qwen/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(
            qwen_tts_endpoint("https://dashscope.aliyuncs.com/compatible-mode/v1").unwrap(),
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
        assert!(format_qwen_http_error(404, r#"{"code":"ModelNotFound","message":"no model"}"#)
            .contains("ModelNotFound: no model"));
        assert!(qwen_tts_endpoint("http://dashscope.aliyuncs.com/api/v1").is_err());
        assert!(qwen_tts_endpoint("https://dashscope.aliyuncs.com/api/v1?api_key=leak").is_err());

        let cfg = QwenTtsConfig {
            enabled: true,
            managed: false,
            base: "https://dashscope.aliyuncs.com/api/v1".into(),
            model: "qwen3-tts-flash".into(),
            voice: "Cherry".into(),
            style: "沉稳自然".into(),
        };
        let body = qwen_tts_request_body("早安呀！", &cfg, Some("happy"));
        assert_eq!(body["model"], "qwen3-tts-flash");
        assert_eq!(body["input"]["voice"], "Cherry");
        assert_eq!(body["input"]["text"], "早安呀！");
        assert_eq!(body["input"]["language_type"], "Auto");
        assert!(body["input"]["instructions"].is_null());

        let instruct_cfg = QwenTtsConfig {
            model: "qwen3-tts-instruct-flash".into(),
            voice: "冰糖".into(),
            ..cfg
        };
        let instruct_body = qwen_tts_request_body("早安呀！", &instruct_cfg, Some("happy"));
        assert_eq!(instruct_body["model"], "qwen3-tts-instruct-flash");
        assert_eq!(instruct_body["input"]["voice"], "Cherry");
        assert!(instruct_body["input"]["instructions"]
            .as_str()
            .unwrap()
            .contains("笑意"));
        assert_eq!(instruct_body["parameters"]["optimize_instructions"], true);

        let wav = b"RIFF$\x00\x00\x00WAVEfmt ";
        let encoded = base64::engine::general_purpose::STANDARD.encode(wav);
        match decode_qwen_tts_response(&json!({
            "output": { "audio": { "data": encoded } }
        }))
        .unwrap()
        {
            QwenAudioPayload::Bytes(bytes) => assert_eq!(bytes, wav),
            QwenAudioPayload::Url(_) => panic!("expected bytes"),
        }
        match decode_qwen_tts_response(&json!({
            "output": { "audio": { "data": "", "url": "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav" } }
        }))
        .unwrap()
        {
            QwenAudioPayload::Url(url) => assert!(url.ends_with("test.wav")),
            QwenAudioPayload::Bytes(_) => panic!("expected url"),
        }
        assert!(decode_qwen_tts_response(&json!({ "output": {} })).is_err());
    }

    #[test]
    fn long_text_is_split_into_short_sentence_segments() {
        let text = "好的，先生。我已经检查了你今天的日程安排，上午十点有一个产品评审会议，下午两点需要和设计团队对齐新版本的交互细节。另外，傍晚可能下雨！记得带伞。";
        let segments = split_segments(text, SEGMENT_CHARS);
        assert_eq!(split_segments(text, SEGMENT_CHARS), vec![text]);
        assert!(segments.iter().all(|s| s.chars().count() <= SEGMENT_CHARS));
        assert_eq!(segments.concat(), text);

        let instruct = segment_chars("qwen3-tts-instruct-flash");
        assert_eq!(segment_chars("qwen3-tts-flash"), SEGMENT_CHARS);
        assert_eq!(split_segments(text, instruct), vec![text]);
        let long = text.repeat(8);
        let segments = split_segments(&long, instruct);
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
        assert_eq!(status.implemented, cfg!(any(target_os = "macos", target_os = "windows")));
        assert!(status.message.contains("不会发给对话模型"));
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
