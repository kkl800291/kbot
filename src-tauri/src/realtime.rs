//! Alibaba Cloud DashScope Qwen-Omni-Realtime WebSocket voice client & audio streamer.
//! Streams 16kHz PCM16 microphone audio to DashScope Realtime API, receives
//! incremental text transcripts, tool calls, and 24kHz PCM16 audio responses,
//! and plays responses through `Speech` with full-duplex barge-in interruption.

#[cfg(target_os = "macos")]
use crate::dictation::compute_audio_level;
#[cfg(target_os = "macos")]
use crate::dictation::{
    ensure_audio_frameworks, ensure_microphone_granted, ns_to_string, release,
};
use crate::storage::read_key;
use crate::voice::{play_segment, Speech};
use base64::Engine;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_rustls::TlsConnector;

const EVENT: &str = "voice-realtime";
pub const DEFAULT_REALTIME_BASE: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
pub const DEFAULT_REALTIME_MODEL: &str = "qwen3.5-omni-flash-realtime";
pub const DEFAULT_REALTIME_VOICE: &str = "Tina";
/// Models DashScope has retired ("Model not exist."); silently upgraded to the default.
const RETIRED_MODELS: &[&str] = &["qwen-omni-turbo-realtime", "qwen3-omni-flash-realtime"];
/// Legacy preset voices rejected by Qwen3.5 / Qwen3.8 Omni ("Voice 'X' is not supported").
/// Custom/cloned `voice_id` strings are preserved verbatim.
const RETIRED_VOICES: &[&str] = &[
    "Cherry", "Chelsie", "Serena", "Ethan", "Bella", "Jada", "Dylan", "Sunny", "Nini", "Aiden",
];
const MAX_ENROLL_AUDIO_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_JARVIS_SAMPLE_URL: &str =
    "https://huggingface.co/FuturePresentLabs/tts-jarvis/resolve/main/samples/preview-longform.wav";
/// Hold the mic gate this long after assistant playback so the speaker tail is not
/// picked up as user speech (laptop speakers + mic have no echo cancellation).
pub(crate) const ECHO_TAIL_MS: u64 = 450;

const INPUT_SAMPLE_RATE: f64 = 16_000.0;
pub(crate) const OUTPUT_SAMPLE_RATE: u32 = 24_000;
const STREAM_FIRST_BYTES: usize = 5_760; // ~120ms @ 24kHz PCM16 mono initial jitter buffer
const FIRST_CHUNK_BYTES: usize = 24_000; // ~0.5s fallback afplay first chunk
const NEXT_CHUNK_BYTES: usize = 57_600; // ~1.2s fallback afplay chunk
const MAX_CHUNK_BYTES: usize = 288_000; // ~6.0s @ 24kHz 16-bit mono
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeStartConfig {
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub voice: String,
    #[serde(default)]
    pub instructions: String,
}

pub(crate) enum WsStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for WsStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            WsStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for WsStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            WsStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            WsStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
            WsStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            WsStream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            WsStream::Tls(s) => std::pin::Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

struct AudioEngineSession {
    engine: usize,
    input: usize,
    tapped: bool,
    running: Arc<AtomicBool>,
    #[allow(dead_code)]
    keep: Box<dyn Send>,
}

struct Keep<T>(T);
unsafe impl<T> Send for Keep<T> {}

struct ActiveRealtime {
    id: u64,
    running: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    bridging: Arc<AtomicBool>,
    interrupted: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<WsOut>,
    audio_queue: Arc<AudioPlaybackQueue>,
    #[cfg(target_os = "macos")]
    mic_session: Option<AudioEngineSession>,
    #[cfg(target_os = "windows")]
    mic_session: Option<crate::win_audio::WinMicSession>,
}

#[derive(Clone)]
enum WsOut {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

#[cfg(target_os = "macos")]
struct StreamingPlayerInner {
    engine: *mut objc::runtime::Object,
    player: *mut objc::runtime::Object,
    format: *mut objc::runtime::Object,
}

#[cfg(target_os = "macos")]
unsafe impl Send for StreamingPlayerInner {}

#[cfg(target_os = "macos")]
impl Drop for StreamingPlayerInner {
    fn drop(&mut self) {
        objc::rc::autoreleasepool(|| unsafe {
            if !self.player.is_null() {
                let _: () = msg_send![self.player, stop];
            }
            if !self.engine.is_null() {
                let _: () = msg_send![self.engine, stop];
            }
        });
        release(self.player);
        release(self.format);
        release(self.engine);
    }
}

#[cfg(target_os = "macos")]
struct StreamingPlayer {
    inner: Mutex<Option<StreamingPlayerInner>>,
    play_gen: Arc<AtomicU64>,
    in_flight: Arc<AtomicUsize>,
    gate_until: Arc<AtomicU64>,
    notify: Arc<Notify>,
}

#[cfg(target_os = "macos")]
impl StreamingPlayer {
    fn new(gate_until: Arc<AtomicU64>, notify: Arc<Notify>) -> Result<Self, String> {
        use objc::runtime::{Object, BOOL, NO, YES};
        ensure_audio_frameworks()?;

        objc::rc::autoreleasepool(|| unsafe {
            // AVAudioPCMFormatFloat32 = 1
            let fmt: *mut Object = msg_send![class!(AVAudioFormat), alloc];
            let fmt: *mut Object = msg_send![
                fmt,
                initWithCommonFormat: 1usize
                sampleRate: f64::from(OUTPUT_SAMPLE_RATE)
                channels: 1u32
                interleaved: NO
            ];
            if fmt.is_null() {
                return Err("无法创建实时音频输出格式".into());
            }

            let engine: *mut Object = msg_send![class!(AVAudioEngine), new];
            if engine.is_null() {
                release(fmt);
                return Err("无法创建实时音频输出引擎".into());
            }

            let player: *mut Object = msg_send![class!(AVAudioPlayerNode), new];
            if player.is_null() {
                release(engine);
                release(fmt);
                return Err("无法创建实时音频播放节点".into());
            }

            let mixer: *mut Object = msg_send![engine, mainMixerNode];
            let _: () = msg_send![engine, attachNode: player];
            let _: () = msg_send![engine, connect: player to: mixer format: fmt];
            let _: () = msg_send![engine, prepare];
            let mut err: *mut Object = std::ptr::null_mut();
            let started: BOOL = msg_send![engine, startAndReturnError: &mut err];
            if started != YES {
                let detail = if err.is_null() {
                    String::new()
                } else {
                    ns_to_string(msg_send![err, localizedDescription])
                };
                release(player);
                release(engine);
                release(fmt);
                return Err(if detail.is_empty() {
                    "无法启动实时音频输出".into()
                } else {
                    format!("无法启动实时音频输出（{detail}）")
                });
            }
            let _: () = msg_send![player, play];

            Ok(Self {
                inner: Mutex::new(Some(StreamingPlayerInner {
                    engine,
                    player,
                    format: fmt,
                })),
                play_gen: Arc::new(AtomicU64::new(1)),
                in_flight: Arc::new(AtomicUsize::new(0)),
                gate_until,
                notify,
            })
        })
    }

    fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    fn schedule_pcm(&self, pcm: &[u8]) -> Result<(), String> {
        use objc::runtime::{Object, BOOL, NO, YES};
        let frame_count = (pcm.len() / 2) as u32;
        if frame_count == 0 {
            return Ok(());
        }
        let guard = self
            .inner
            .lock()
            .map_err(|_| "实时音频输出锁不可用".to_string())?;
        let Some(inner) = guard.as_ref() else {
            return Err("实时音频输出已关闭".into());
        };

        let gen = self.play_gen.load(Ordering::Acquire);
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        // Keep the mic gated until CoreAudio confirms playback finished.
        self.gate_until.store(now_ms() + 60_000, Ordering::Release);

        let cb_gen_arc = Arc::clone(&self.play_gen);
        let cb_in_flight = Arc::clone(&self.in_flight);
        let cb_gate = Arc::clone(&self.gate_until);
        let cb_notify = Arc::clone(&self.notify);

        objc::rc::autoreleasepool(|| unsafe {
            let running: BOOL = msg_send![inner.engine, isRunning];
            if running != YES {
                let mut err: *mut Object = std::ptr::null_mut();
                let ok: BOOL = msg_send![inner.engine, startAndReturnError: &mut err];
                if ok != YES {
                    if cb_gen_arc.load(Ordering::Acquire) == gen
                        && cb_in_flight.fetch_sub(1, Ordering::AcqRel) == 1
                    {
                        cb_gate.store(0, Ordering::Release);
                    }
                    return Err("实时音频输出恢复失败".into());
                }
                let _: () = msg_send![inner.player, play];
            }

            let buf: *mut Object = msg_send![class!(AVAudioPCMBuffer), alloc];
            let buf: *mut Object =
                msg_send![buf, initWithPCMFormat: inner.format frameCapacity: frame_count];
            if buf.is_null() {
                if cb_gen_arc.load(Ordering::Acquire) == gen
                    && cb_in_flight.fetch_sub(1, Ordering::AcqRel) == 1
                {
                    cb_gate.store(0, Ordering::Release);
                }
                return Err("无法分配音频输出缓冲区".into());
            }
            let _: () = msg_send![buf, setFrameLength: frame_count];
            let ch_ptrs: *const *mut f32 = msg_send![buf, floatChannelData];
            if ch_ptrs.is_null() || (*ch_ptrs).is_null() {
                release(buf);
                if cb_gen_arc.load(Ordering::Acquire) == gen
                    && cb_in_flight.fetch_sub(1, Ordering::AcqRel) == 1
                {
                    cb_gate.store(0, Ordering::Release);
                }
                return Err("音频输出缓冲区通道不可用".into());
            }
            let dst = std::slice::from_raw_parts_mut(*ch_ptrs, frame_count as usize);
            for (i, pair) in pcm.chunks_exact(2).take(frame_count as usize).enumerate() {
                dst[i] = f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0;
            }

            let block = block::ConcreteBlock::new(move |_cb_type: isize| {
                if cb_gen_arc.load(Ordering::Acquire) == gen {
                    if cb_in_flight.fetch_sub(1, Ordering::AcqRel) == 1 {
                        cb_gate.store(now_ms() + ECHO_TAIL_MS, Ordering::Release);
                        cb_notify.notify_one();
                    }
                }
            })
            .copy();

            // AVAudioPlayerNodeCompletionDataPlayedBack = 2
            let _: () = msg_send![
                inner.player,
                scheduleBuffer: buf
                completionCallbackType: 2isize
                completionHandler: &*block
            ];
            release(buf);
            let _ = NO;
            Ok(())
        })
    }

    fn stop(&self) {
        self.play_gen.fetch_add(1, Ordering::AcqRel);
        self.in_flight.store(0, Ordering::Release);
        self.gate_until.store(0, Ordering::Release);
        if let Ok(guard) = self.inner.lock() {
            if let Some(inner) = guard.as_ref() {
                objc::rc::autoreleasepool(|| unsafe {
                    let _: () = msg_send![inner.player, stop];
                    let _: () = msg_send![inner.player, play];
                });
            }
        }
        self.notify.notify_one();
    }

    fn shutdown(&self) {
        self.play_gen.fetch_add(1, Ordering::AcqRel);
        self.in_flight.store(0, Ordering::Release);
        self.gate_until.store(0, Ordering::Release);
        if let Ok(mut guard) = self.inner.lock() {
            let _ = guard.take();
        }
        self.notify.notify_one();
    }
}

#[cfg(target_os = "windows")]
struct StreamingPlayer(crate::win_audio::WinSpeaker);

#[cfg(target_os = "windows")]
impl StreamingPlayer {
    fn new(gate_until: Arc<AtomicU64>, notify: Arc<Notify>) -> Result<Self, String> {
        crate::win_audio::WinSpeaker::new(gate_until, notify).map(Self)
    }
    fn in_flight(&self) -> usize {
        self.0.in_flight()
    }
    fn schedule_pcm(&self, pcm16_le: &[u8]) -> Result<(), String> {
        self.0.schedule_pcm(pcm16_le)
    }
    fn stop(&self) {
        self.0.stop();
    }
    fn shutdown(&self) {
        self.0.shutdown();
    }
}

#[derive(Default)]
struct AudioQueueInner {
    pcm: Vec<u8>,
    turn_finished: bool,
    first_flushed: bool,
    speaking: bool,
    speech_gen: Option<u64>,
}

struct AudioPlaybackQueue {
    inner: Mutex<AudioQueueInner>,
    notify: Arc<Notify>,
    /// Epoch-ms until which microphone audio is not forwarded (echo guard).
    gate_until: Arc<AtomicU64>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    stream_player: Mutex<Option<Arc<StreamingPlayer>>>,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl AudioPlaybackQueue {
    fn new() -> Self {
        Self {
            inner: Mutex::new(AudioQueueInner::default()),
            notify: Arc::new(Notify::new()),
            gate_until: Arc::new(AtomicU64::new(0)),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            stream_player: Mutex::new(None),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn set_streaming_player(&self, player: StreamingPlayer) {
        if let Ok(mut g) = self.stream_player.lock() {
            *g = Some(Arc::new(player));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn player(&self) -> Option<Arc<StreamingPlayer>> {
        self.stream_player.lock().ok().and_then(|g| g.clone())
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn shutdown_player(&self) {
        if let Ok(mut g) = self.stream_player.lock() {
            if let Some(p) = g.take() {
                p.shutdown();
            }
        }
    }

    /// Close the mic gate for the duration of a WAV segment plus the echo tail.
    fn gate_for_wav(&self, wav_len: usize) {
        let pcm_bytes = wav_len.saturating_sub(44) as u64;
        let dur_ms = pcm_bytes * 1000 / (u64::from(OUTPUT_SAMPLE_RATE) * 2);
        self.gate_until
            .store(now_ms() + dur_ms + ECHO_TAIL_MS, Ordering::Release);
    }

    fn push_pcm(&self, bytes: &[u8], speech: &Speech) -> bool {
        let mut started_speaking = false;
        if let Ok(mut g) = self.inner.lock() {
            if g.speech_gen.is_none() {
                g.speech_gen = Some(speech.begin());
                g.first_flushed = false;
                g.turn_finished = false;
            }
            g.pcm.extend_from_slice(bytes);
            if !g.speaking && !bytes.is_empty() {
                g.speaking = true;
                started_speaking = true;
            }
        }
        self.notify.notify_one();
        started_speaking
    }

    fn finish_turn(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.turn_finished = true;
        }
        self.notify.notify_one();
    }

    fn clear_and_stop(&self, speech: &Speech) -> bool {
        let was_speaking = if let Ok(mut g) = self.inner.lock() {
            let s = g.speaking;
            g.pcm.clear();
            g.turn_finished = false;
            g.first_flushed = false;
            g.speaking = false;
            g.speech_gen = None;
            s
        } else {
            false
        };
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(player) = self.player() {
            player.stop();
        }
        speech.stop_active();
        self.gate_until.store(0, Ordering::Release);
        self.notify.notify_one();
        was_speaking
    }

    fn pop_next_stream_pcm(&self) -> Option<Vec<u8>> {
        let mut g = self.inner.lock().ok()?;
        let _ = g.speech_gen?;
        let threshold = if g.first_flushed { 2 } else { STREAM_FIRST_BYTES };
        if g.pcm.len() >= threshold || (g.turn_finished && !g.pcm.is_empty()) {
            let take_len = g.pcm.len().min(MAX_CHUNK_BYTES);
            let take_len = take_len - (take_len % 2);
            if take_len == 0 {
                return None;
            }
            let chunk: Vec<u8> = g.pcm.drain(..take_len).collect();
            g.first_flushed = true;
            return Some(chunk);
        }
        None
    }

    fn pop_next_wav(&self) -> Option<(u64, Vec<u8>)> {
        let mut g = self.inner.lock().ok()?;
        let gen = g.speech_gen?;
        let threshold = if g.first_flushed { NEXT_CHUNK_BYTES } else { FIRST_CHUNK_BYTES };
        if g.pcm.len() >= threshold || (g.turn_finished && !g.pcm.is_empty()) {
            let take_len = g.pcm.len().min(MAX_CHUNK_BYTES);
            // Align to 2-byte PCM16 frame boundary.
            let take_len = take_len - (take_len % 2);
            if take_len == 0 {
                return None;
            }
            let chunk: Vec<u8> = g.pcm.drain(..take_len).collect();
            g.first_flushed = true;
            return Some((gen, pcm16_to_wav(&chunk, OUTPUT_SAMPLE_RATE)));
        }
        None
    }

    fn is_speaking(&self) -> bool {
        self.inner.lock().map(|g| g.speaking).unwrap_or(false)
    }

    fn complete_if_idle(&self) -> bool {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(player) = self.player() {
            if player.in_flight() > 0 {
                return false;
            }
        }
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if g.turn_finished && g.pcm.is_empty() {
            let was = g.speaking;
            g.speaking = false;
            g.first_flushed = false;
            g.turn_finished = false;
            g.speech_gen = None;
            return was;
        }
        false
    }
}

#[derive(Clone, Default)]
pub struct RealtimeManager {
    active: Arc<Mutex<Option<ActiveRealtime>>>,
    next_id: Arc<AtomicU64>,
    cancel_gen: Arc<AtomicU64>,
    starting: Arc<AtomicBool>,
}

impl RealtimeManager {
    pub fn stop_blocking(&self, speech: &Speech) {
        self.cancel_gen.fetch_add(1, Ordering::AcqRel);
        let taken = self.active.lock().ok().and_then(|mut g| g.take());
        if let Some(rt) = taken {
            rt.running.store(false, Ordering::Release);
            let _ = rt.tx.send(WsOut::Close);
            rt.audio_queue.clear_and_stop(speech);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            rt.audio_queue.shutdown_player();
        }
        self.starting.store(false, Ordering::Release);
    }
}

/// Map empty / retired model ids to the current default.
pub(crate) fn normalize_model(raw: &str) -> &str {
    let m = raw.trim();
    if m.is_empty() || RETIRED_MODELS.contains(&m) {
        DEFAULT_REALTIME_MODEL
    } else {
        m
    }
}

fn is_omni_next(model: &str) -> bool {
    model.starts_with("qwen3.5-omni") || model.starts_with("qwen3.8-omni")
}

/// Voice to send for `model`.
/// Legacy preset voices (Cherry/Chelsie/…) are rejected by the 3.5/3.8 family ("Voice 'X' is not supported"),
/// and `qwen3.8-omni-flash-realtime` defaults to `"Chelsie"` unless explicitly overridden, so empty or
/// incompatible preset voices normalize to `DEFAULT_REALTIME_VOICE` ("Tina") while custom cloned voices pass through.
pub(crate) fn voice_for(model: &str, raw_voice: &str) -> Option<String> {
    let v = raw_voice.trim();
    if is_omni_next(model) {
        let invalid_preset = v.is_empty()
            || RETIRED_VOICES.iter().any(|legacy| legacy.eq_ignore_ascii_case(v))
            || (v.eq_ignore_ascii_case("Zane") && !model.starts_with("qwen3.8"));
        return Some(if invalid_preset { DEFAULT_REALTIME_VOICE } else { v }.to_string());
    }
    (!v.is_empty()).then(|| v.to_string())
}

pub(crate) fn realtime_endpoint(raw_base: &str, raw_model: &str) -> Result<url::Url, String> {
    let base = if raw_base.trim().is_empty() {
        DEFAULT_REALTIME_BASE
    } else {
        raw_base.trim()
    };
    let model = normalize_model(raw_model);
    let mut parsed = url::Url::parse(base).map_err(|_| "实时语音地址格式无效".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "实时语音地址缺少主机名".to_string())?;
    let local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if parsed.scheme() != "wss" && !(local && parsed.scheme() == "ws") {
        return Err("实时语音地址必须使用 WSS（本机调试除外）".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("实时语音地址不能包含凭据".into());
    }
    let has_model = parsed.query_pairs().any(|(k, _)| k == "model");
    if !has_model {
        parsed.query_pairs_mut().append_pair("model", model);
    }
    Ok(parsed)
}

pub(crate) fn session_update_payload(cfg: &RealtimeStartConfig) -> Value {
    let model = normalize_model(&cfg.model);
    let instructions = if cfg.instructions.trim().is_empty() {
        "你是 Kbot，用户的桌面搭档与数字生命体（名字连读作一个词 kay-bot，不要逐字母念成 K-B-O-T）。无论用户如何质疑或用其他名字称呼你，你都始终是 Kbot，严禁自称 Qwen、Qwen-Omni、通义千问、DeepSeek 或任何底层模型名称。口语自然简练，少客套，不要客服式收尾，不要主动报天气。"
    } else {
        cfg.instructions.trim()
    };
    let mut payload = json!({
        "event_id": format!("kbot-upd-{}", next_seq()),
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "input_audio_format": "pcm",
            "output_audio_format": "pcm",
            "instructions": instructions,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 650
            },
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "ask_dsh",
                        "description": "委托本地 DeepSeek Harness 智能核心执行桌面或复杂任务：读写 ~/KBOT 工作区记忆与日记、执行终端命令、联网检索最新信息、分析图片或设置定时提醒。",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "task": {
                                    "type": "string",
                                    "description": "需要 DeepSeek Harness 执行的具体任务或完整指令"
                                }
                            },
                            "required": ["task"]
                        }
                    }
                }
            ]
        }
    });
    if let Some(voice) = voice_for(model, &cfg.voice) {
        payload["session"]["voice"] = json!(voice);
    }
    // The 3.5/3.8 family enables its own (better) ASR by default; only legacy
    // models need an explicit transcription model.
    if !is_omni_next(model) {
        payload["session"]["input_audio_transcription"] = json!({ "model": "gummy-realtime-v1" });
    }
    payload
}

pub(crate) fn pcm16_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let byte_rate = sample_rate * 2;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

pub(crate) fn pcm16_audio_level(pcm: &[u8]) -> f32 {
    if pcm.len() < 2 {
        return 0.0;
    }
    let mut sum_sq = 0.0f64;
    let mut count = 0usize;
    for pair in pcm.chunks_exact(2) {
        let sample = i16::from_le_bytes([pair[0], pair[1]]) as f64 / 32768.0;
        sum_sq += sample * sample;
        count += 1;
    }
    if count == 0 {
        return 0.0;
    }
    let rms = (sum_sq / count as f64).sqrt();
    (((rms - 0.0025).max(0.0) * 12.0).sqrt()).clamp(0.0, 1.0) as f32
}

/// Resample float32 mono samples from `input_rate` Hz to 16000Hz signed 16-bit little-endian PCM.
pub(crate) fn downsample_f32_to_pcm16_16k(
    samples: &[f32],
    input_rate: f64,
    phase: &mut f64,
) -> Vec<u8> {
    if samples.is_empty() || !input_rate.is_finite() || input_rate <= 0.0 {
        return Vec::new();
    }
    let step = input_rate / INPUT_SAMPLE_RATE;
    if !step.is_finite() || step <= 0.0 {
        return Vec::new();
    }
    let est = ((samples.len() as f64 / step).ceil() as usize + 2) * 2;
    let mut out = Vec::with_capacity(est);
    let len = samples.len();
    let mut pos = if *phase >= 0.0 && phase.is_finite() {
        *phase
    } else {
        0.0
    };

    while (pos as usize) < len {
        let idx = pos as usize;
        let sample = if step >= 2.5 {
            // Simple box average across the stride window to curb high-frequency aliasing.
            let half = ((step * 0.5) as usize).max(1);
            let start = idx.saturating_sub(half);
            let end = (idx + half + 1).min(len);
            let mut sum = 0.0f64;
            let mut n = 0usize;
            for &s in &samples[start..end] {
                if s.is_finite() {
                    sum += f64::from(s);
                    n += 1;
                }
            }
            if n > 0 {
                sum / n as f64
            } else {
                0.0
            }
        } else {
            let frac = pos - (idx as f64);
            let s0 = if samples[idx].is_finite() {
                f64::from(samples[idx])
            } else {
                0.0
            };
            let s1 = if idx + 1 < len && samples[idx + 1].is_finite() {
                f64::from(samples[idx + 1])
            } else {
                s0
            };
            s0 + (s1 - s0) * frac
        };
        let clamped = sample.clamp(-1.0, 1.0);
        let q = (clamped * 32767.0).round() as i16;
        out.extend_from_slice(&q.to_le_bytes());
        pos += step;
    }

    *phase = (pos - len as f64).max(0.0);
    out
}

pub(crate) fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    #[cfg(unix)]
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        if f.read_exact(&mut buf).is_ok() {
            return buf;
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1)
        ^ u128::from(next_seq());
    for (i, b) in buf.iter_mut().enumerate() {
        *b = ((nanos >> ((i % 16) * 8)) & 0xff) as u8;
    }
    buf
}

/// Minimal pure-Rust SHA-1 (RFC 3174) exclusively for WebSocket `Sec-WebSocket-Accept` verification.
pub(crate) fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub(crate) fn websocket_accept(key: &str) -> String {
    let input = format!("{}{WS_GUID}", key.trim());
    base64::engine::general_purpose::STANDARD.encode(sha1_digest(input.as_bytes()))
}

pub(crate) fn encode_ws_frame(opcode: u8, payload: &[u8], mask_key: [u8; 4]) -> Vec<u8> {
    let len = payload.len();
    let header_len = if len < 126 {
        6
    } else if len <= 65_535 {
        8
    } else {
        14
    };
    let mut frame = Vec::with_capacity(header_len + len);
    frame.push(0x80 | (opcode & 0x0f));
    if len < 126 {
        frame.push(0x80 | (len as u8));
    } else if len <= 65_535 {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    frame.extend_from_slice(&mask_key);
    for (i, &b) in payload.iter().enumerate() {
        frame.push(b ^ mask_key[i % 4]);
    }
    frame
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RawWsFrame {
    pub fin: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Try decoding one complete RFC 6455 frame from `buf`, draining consumed bytes.
pub(crate) fn try_decode_ws_frame(buf: &mut Vec<u8>) -> Result<Option<RawWsFrame>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let b0 = buf[0];
    let b1 = buf[1];
    let fin = (b0 & 0x80) != 0;
    let opcode = b0 & 0x0f;
    let masked = (b1 & 0x80) != 0;
    let len_code = b1 & 0x7f;

    let mut offset = 2usize;
    let payload_len: usize = match len_code {
        0..=125 => len_code as usize,
        126 => {
            if buf.len() < offset + 2 {
                return Ok(None);
            }
            let v = u16::from_be_bytes([buf[offset], buf[offset + 1]]) as usize;
            offset += 2;
            v
        }
        127 => {
            if buf.len() < offset + 8 {
                return Ok(None);
            }
            let v = u64::from_be_bytes([
                buf[offset],
                buf[offset + 1],
                buf[offset + 2],
                buf[offset + 3],
                buf[offset + 4],
                buf[offset + 5],
                buf[offset + 6],
                buf[offset + 7],
            ]);
            offset += 8;
            usize::try_from(v).map_err(|_| "WebSocket 帧长度超出范围".to_string())?
        }
        _ => unreachable!(),
    };
    if payload_len > 32 * 1024 * 1024 {
        return Err("WebSocket 帧过大".into());
    }
    let mask_len = if masked { 4 } else { 0 };
    if buf.len() < offset + mask_len + payload_len {
        return Ok(None);
    }
    let mask = if masked {
        let m = [
            buf[offset],
            buf[offset + 1],
            buf[offset + 2],
            buf[offset + 3],
        ];
        offset += 4;
        Some(m)
    } else {
        None
    };
    let mut payload = buf[offset..offset + payload_len].to_vec();
    if let Some(m) = mask {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= m[i % 4];
        }
    }
    buf.drain(..offset + payload_len);
    Ok(Some(RawWsFrame {
        fin,
        opcode,
        payload,
    }))
}

pub(crate) async fn connect_ws(url: &url::Url, api_key: &str) -> Result<(WsStream, Vec<u8>), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "实时语音地址缺少主机名".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "无法确定实时语音端口".to_string())?;
    let addr = format!("{host}:{port}");
    let tcp = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect(&addr))
        .await
        .map_err(|_| "连接实时语音服务超时".to_string())?
        .map_err(|_| "无法连接实时语音服务，请检查网络".to_string())?;
    let _ = tcp.set_nodelay(true);

    let mut stream = if url.scheme() == "wss" {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let connector = TlsConnector::from(Arc::new(config));
        let server_name = ServerName::try_from(host.to_string())
            .map_err(|_| "实时语音服务器域名无效".to_string())?;
        let tls = tokio::time::timeout(Duration::from_secs(8), connector.connect(server_name, tcp))
            .await
            .map_err(|_| "实时语音连接握手超时".to_string())?
            .map_err(|_| "实时语音安全连接失败".to_string())?;
        WsStream::Tls(Box::new(tls))
    } else {
        WsStream::Plain(tcp)
    };

    let path = if let Some(q) = url.query() {
        format!("{}?{q}", url.path())
    } else {
        url.path().to_string()
    };
    let host_header = if (url.scheme() == "wss" && port == 443) || (url.scheme() == "ws" && port == 80) {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let ws_key = base64::engine::general_purpose::STANDARD.encode(random_bytes::<16>());
    let req = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host_header}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {ws_key}\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Authorization: Bearer {api_key}\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|_| "发送实时语音连接请求失败".to_string())?;
    stream
        .flush()
        .await
        .map_err(|_| "发送实时语音连接请求失败".to_string())?;

    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 16 * 1024 {
            return Err("实时语音响应头过长".into());
        }
        let n = tokio::time::timeout(Duration::from_secs(8), stream.read(&mut tmp))
            .await
            .map_err(|_| "实时语音连接响应超时".to_string())?
            .map_err(|_| "读取实时语音响应失败".to_string())?;
        if n == 0 {
            return Err("实时语音服务关闭了连接".into());
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if status_code != 101 {
        return Err(match status_code {
            401 | 403 => "实时语音凭据无效或已过期，请检查登录状态或 API Key".into(),
            402 => "平台体验额度或点数已用完，请充值点数或切换自带 API Key".into(),
            404 => "实时语音服务地址或模型不可用，请到设置 → 语音中检查".into(),
            429 => "实时语音连接过于频繁，请稍后重试".into(),
            _ => format!("实时语音连接失败（HTTP {status_code}）"),
        });
    }
    let expected_accept = websocket_accept(&ws_key);
    let accept_ok = lines.any(|line| {
        if let Some((k, v)) = line.split_once(':') {
            k.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == expected_accept
        } else {
            false
        }
    });
    if !accept_ok {
        return Err("实时语音连接校验失败".into());
    }

    let leftover = buf[header_end + 4..].to_vec();
    Ok((stream, leftover))
}

#[tauri::command]
pub async fn voice_realtime_start(
    app: AppHandle,
    realtime: tauri::State<'_, RealtimeManager>,
    speech: tauri::State<'_, Speech>,
    config: RealtimeStartConfig,
) -> Result<u64, String> {
    if realtime.starting.swap(true, Ordering::AcqRel) {
        return Err("实时语音正在连接中".into());
    }
    let start_gen = realtime.cancel_gen.load(Ordering::Acquire);
    let result = start_inner(
        app,
        realtime.inner().clone(),
        speech.inner().clone(),
        config,
        start_gen,
    )
    .await;
    realtime.starting.store(false, Ordering::Release);
    result
}

#[tauri::command]
pub async fn voice_realtime_stop(
    app: AppHandle,
    realtime: tauri::State<'_, RealtimeManager>,
    speech: tauri::State<'_, Speech>,
) -> Result<(), String> {
    realtime.cancel_gen.fetch_add(1, Ordering::AcqRel);
    stop_inner(&app, realtime.inner(), speech.inner(), true).await;
    Ok(())
}

#[tauri::command]
pub async fn voice_realtime_interrupt(
    realtime: tauri::State<'_, RealtimeManager>,
    speech: tauri::State<'_, Speech>,
) -> Result<(), String> {
    let maybe = {
        let guard = realtime.active.lock().map_err(|_| "实时语音状态不可用")?;
        guard.as_ref().map(|rt| {
            (
                rt.tx.clone(),
                Arc::clone(&rt.audio_queue),
                Arc::clone(&rt.interrupted),
            )
        })
    };
    if let Some((tx, queue, interrupted)) = maybe {
        interrupted.store(true, Ordering::Release);
        queue.clear_and_stop(speech.inner());
        let cancel_msg = json!({
            "event_id": format!("kbot-cancel-{}", next_seq()),
            "type": "response.cancel"
        });
        let _ = tx.send(WsOut::Text(cancel_msg.to_string()));
    } else {
        speech.stop_active();
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_realtime_set_muted(
    realtime: tauri::State<'_, RealtimeManager>,
    muted: bool,
) -> Result<(), String> {
    let guard = realtime.active.lock().map_err(|_| "实时语音状态不可用")?;
    if let Some(rt) = guard.as_ref() {
        rt.muted.store(muted, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_realtime_set_bridging(
    realtime: tauri::State<'_, RealtimeManager>,
    bridging: bool,
) -> Result<(), String> {
    let guard = realtime.active.lock().map_err(|_| "实时语音状态不可用")?;
    if let Some(rt) = guard.as_ref() {
        rt.bridging.store(bridging, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_realtime_send_text(
    realtime: tauri::State<'_, RealtimeManager>,
    speech: tauri::State<'_, Speech>,
    text: String,
) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("发送内容不能为空".into());
    }
    let (tx, queue, interrupted) = {
        let guard = realtime.active.lock().map_err(|_| "实时语音状态不可用")?;
        let rt = guard
            .as_ref()
            .ok_or_else(|| "实时语音尚未连接".to_string())?;
        (
            rt.tx.clone(),
            Arc::clone(&rt.audio_queue),
            Arc::clone(&rt.interrupted),
        )
    };
    interrupted.store(false, Ordering::Release);
    let was_speaking = queue.is_speaking();
    queue.clear_and_stop(speech.inner());
    let item_msg = json!({
        "event_id": format!("kbot-txt-{}", next_seq()),
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [{ "type": "input_text", "text": trimmed }]
        }
    });
    let resp_msg = json!({
        "event_id": format!("kbot-rsp-{}", next_seq()),
        "type": "response.create"
    });
    if was_speaking {
        let cancel_msg = json!({
            "event_id": format!("kbot-cancel-{}", next_seq()),
            "type": "response.cancel"
        });
        tx.send(WsOut::Text(cancel_msg.to_string()))
            .map_err(|_| "实时语音通道已断开".to_string())?;
    }
    tx.send(WsOut::Text(item_msg.to_string()))
        .map_err(|_| "实时语音通道已断开".to_string())?;
    tx.send(WsOut::Text(resp_msg.to_string()))
        .map_err(|_| "实时语音通道已断开".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn voice_realtime_tool_output(
    realtime: tauri::State<'_, RealtimeManager>,
    call_id: String,
    output: String,
) -> Result<(), String> {
    let tx = {
        let guard = realtime.active.lock().map_err(|_| "实时语音状态不可用")?;
        let rt = guard
            .as_ref()
            .ok_or_else(|| "实时语音尚未连接".to_string())?;
        rt.bridging.store(false, Ordering::Release);
        rt.tx.clone()
    };
    let item_msg = json!({
        "event_id": format!("kbot-tool-{}", next_seq()),
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output
        }
    });
    let resp_msg = json!({
        "event_id": format!("kbot-tool-rsp-{}", next_seq()),
        "type": "response.create"
    });
    tx.send(WsOut::Text(item_msg.to_string()))
        .map_err(|_| "实时语音通道已断开".to_string())?;
    tx.send(WsOut::Text(resp_msg.to_string()))
        .map_err(|_| "实时语音通道已断开".to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeEnrollRequest {
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub target_model: String,
    #[serde(default)]
    pub preferred_name: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub audio_base64: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnrolledVoice {
    pub voice: String,
    pub target_model: String,
    pub preferred_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnrolledVoiceInfo {
    pub voice: String,
    pub target_model: String,
    pub created_at: String,
}

pub(crate) fn customization_endpoint(raw_base: &str) -> Result<url::Url, String> {
    let mut parsed = realtime_endpoint(raw_base, "")?;
    let scheme = if parsed.scheme() == "ws" { "http" } else { "https" };
    parsed
        .set_scheme(scheme)
        .map_err(|_| "声音复刻接口协议无效".to_string())?;
    let raw_path = parsed.path().trim_end_matches('/').to_string();
    let prefix = raw_path
        .strip_suffix("/api-ws/v1/realtime")
        .unwrap_or("");
    parsed.set_path(&format!("{prefix}/api/v1/services/audio/tts/customization"));
    parsed.set_query(None);
    Ok(parsed)
}

pub(crate) fn sanitize_preferred_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    if cleaned.is_empty() {
        "kbotvoice".into()
    } else {
        cleaned
    }
}

pub(crate) fn validate_sample_url(raw_url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw_url.trim()).map_err(|_| "参考音频地址格式无效".to_string())?;
    let host = parsed.host_str().ok_or("参考音频地址缺少主机名")?;
    let local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        return Err("参考音频地址必须使用 HTTPS".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("参考音频地址不能包含凭据".into());
    }
    Ok(parsed)
}

pub(crate) fn detect_audio_mime(
    bytes: &[u8],
    hint_mime: Option<&str>,
    hint_name: Option<&str>,
) -> Result<&'static str, String> {
    if bytes.len() < 1024 {
        return Err("参考音频过短或为空，请提供至少 10 秒的清晰干声（WAV / MP3 / M4A）".into());
    }
    if bytes.len() > MAX_ENROLL_AUDIO_BYTES {
        return Err("参考音频大小不能超过 10 MB".into());
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Ok("audio/wav");
    }
    if bytes.starts_with(b"ID3") || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0) {
        return Ok("audio/mpeg");
    }
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return Ok("audio/mp4");
    }
    let mime = hint_mime.unwrap_or("").trim().to_ascii_lowercase();
    let name = hint_name.unwrap_or("").trim().to_ascii_lowercase();
    if mime.contains("wav") || name.ends_with(".wav") {
        return Ok("audio/wav");
    }
    if mime.contains("mpeg") || mime.contains("mp3") || name.ends_with(".mp3") {
        return Ok("audio/mpeg");
    }
    if mime.contains("mp4") || mime.contains("m4a") || name.ends_with(".m4a") || name.ends_with(".mp4") {
        return Ok("audio/mp4");
    }
    Err("仅支持 WAV、MP3 或 M4A 格式的参考音频".into())
}

pub(crate) fn enroll_request_body(
    target_model: &str,
    preferred_name: &str,
    mime: &str,
    bytes: &[u8],
) -> Value {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({
        "model": "qwen-voice-enrollment",
        "input": {
            "action": "create",
            "target_model": target_model,
            "preferred_name": preferred_name,
            "audio": {
                "data": format!("data:{mime};base64,{b64}")
            }
        }
    })
}

fn friendly_enroll_error(code: &str, message: &str) -> String {
    let blob = format!("{code} {message}").to_ascii_lowercase();
    if blob.contains("arrearage") || blob.contains("overdue") || blob.contains("quota") {
        return "账号欠费或自定义音色数量已达上限".into();
    }
    if blob.contains("access denied") || blob.contains("unauthorized") || blob.contains("invalid api") {
        return "实时语音 API Key 无效或尚未开通声音复刻权限".into();
    }
    if blob.contains("duration") || blob.contains("audio") && blob.contains("invalid") {
        return format!("参考音频不符合百炼要求：{message}");
    }
    if message.trim().is_empty() {
        format!("声音复刻请求失败（{code}）")
    } else {
        message.trim().to_string()
    }
}

pub(crate) fn parse_enroll_response(status_ok: bool, data: &Value) -> Result<String, String> {
    if let Some(voice) = data["output"]["voice"]
        .as_str()
        .or_else(|| data["output"]["voice_id"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if status_ok {
            return Ok(voice.to_string());
        }
    }
    let code = data["code"].as_str().unwrap_or("");
    let message = data["message"].as_str().unwrap_or("声音复刻未返回音色 ID");
    Err(friendly_enroll_error(code, message))
}

pub(crate) fn parse_voice_list_response(
    status_ok: bool,
    data: &Value,
) -> Result<Vec<EnrolledVoiceInfo>, String> {
    if !status_ok {
        let code = data["code"].as_str().unwrap_or("");
        let message = data["message"].as_str().unwrap_or("查询自定义音色失败");
        return Err(friendly_enroll_error(code, message));
    }
    let items = data["output"]["voice_list"]
        .as_array()
        .or_else(|| data["output"]["voices"].as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let voice = item["voice"]
                        .as_str()
                        .or_else(|| item["voice_id"].as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?
                        .to_string();
                    let target_model = item["target_model"].as_str().unwrap_or("").trim().to_string();
                    let created_at = item["gmt_create"]
                        .as_str()
                        .or_else(|| item["created_at"].as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(EnrolledVoiceInfo {
                        voice,
                        target_model,
                        created_at,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(items)
}

async fn resolve_enroll_audio(req: &RealtimeEnrollRequest) -> Result<(Vec<u8>, &'static str), String> {
    if let Some(raw_b64) = req.audio_base64.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let encoded = raw_b64
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,").map(|(_, b)| b))
            .unwrap_or(raw_b64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| "音频数据解码失败".to_string())?;
        let mime = detect_audio_mime(&bytes, req.mime_type.as_deref(), req.file_name.as_deref())?;
        return Ok((bytes, mime));
    }

    let raw_url = req
        .source_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_JARVIS_SAMPLE_URL);
    let url = validate_sample_url(raw_url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "音频下载组件初始化失败".to_string())?;
    let resp = client
        .get(url.clone())
        .send()
        .await
        .map_err(|err| format!("无法下载参考音频（请检查网络连接）：{err}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载参考音频失败（HTTP {}）", resp.status().as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_ENROLL_AUDIO_BYTES as u64 {
            return Err("参考音频大小不能超过 10 MB".into());
        }
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| "读取参考音频数据失败".to_string())?
        .to_vec();
    let mime = detect_audio_mime(
        &bytes,
        req.mime_type.as_deref().or(content_type.as_deref()),
        req.file_name.as_deref().or(Some(url.path())),
    )?;
    Ok((bytes, mime))
}

pub(crate) fn read_realtime_auth_key(managed: bool) -> Result<String, String> {
    let slot = if managed { "managed" } else { "realtime" };
    let key = read_key(slot).map_err(|_| {
        if managed {
            "尚未建立云端托管会话，请先领取体验额度或登录账号".to_string()
        } else {
            "尚未配置实时语音 API Key，请到设置 → 语音中保存".to_string()
        }
    })?;
    let trimmed = key.trim().to_string();
    if trimmed.is_empty() {
        return Err(if managed {
            "云端托管会话无效，请重新连接".into()
        } else {
            "尚未配置实时语音 API Key，请到设置 → 语音中保存".into()
        });
    }
    Ok(trimmed)
}

async fn post_customization(
    base: &str,
    managed: bool,
    payload: &Value,
    timeout: Duration,
) -> Result<(bool, Value), String> {
    let key = read_realtime_auth_key(managed)?;
    let endpoint = customization_endpoint(base)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .build()
        .map_err(|_| "声音复刻网络组件初始化失败".to_string())?;
    let resp = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {key}"))
        .json(payload)
        .send()
        .await
        .map_err(|err| format!("连接声音复刻服务失败：{err}"))?;
    let status = resp.status();
    let status_ok = status.is_success();
    if status.as_u16() == 402 {
        return Err("平台体验额度或点数已用完，请充值点数或切换自带 API Key".into());
    }
    let data: Value = resp
        .json()
        .await
        .map_err(|_| "声音复刻服务返回格式无效".to_string())?;
    Ok((status_ok, data))
}

#[tauri::command]
pub async fn voice_realtime_enroll(req: RealtimeEnrollRequest) -> Result<EnrolledVoice, String> {
    let target_model = normalize_model(&req.target_model).to_string();
    let preferred_name = sanitize_preferred_name(&req.preferred_name);
    let (bytes, mime) = resolve_enroll_audio(&req).await?;
    let payload = enroll_request_body(&target_model, &preferred_name, mime, &bytes);
    let (status_ok, data) =
        post_customization(&req.base, req.managed, &payload, Duration::from_secs(45)).await?;
    let voice = parse_enroll_response(status_ok, &data)?;
    Ok(EnrolledVoice {
        voice,
        target_model,
        preferred_name,
    })
}

#[tauri::command]
pub async fn voice_realtime_list_voices(
    base: String,
    managed: Option<bool>,
) -> Result<Vec<EnrolledVoiceInfo>, String> {
    let payload = json!({
        "model": "qwen-voice-enrollment",
        "input": {
            "action": "list",
            "page_size": 50,
            "page_index": 0
        }
    });
    let (status_ok, data) =
        post_customization(&base, managed.unwrap_or(false), &payload, Duration::from_secs(20))
            .await?;
    parse_voice_list_response(status_ok, &data)
}

pub(crate) fn delete_request_body(voice: &str) -> Value {
    json!({
        "model": "qwen-voice-enrollment",
        "input": {
            "action": "delete",
            "voice": voice
        }
    })
}

pub(crate) fn parse_delete_response(status_ok: bool, data: &Value) -> Result<(), String> {
    if status_ok {
        return Ok(());
    }
    let code = data["code"].as_str().unwrap_or("");
    let message = data["message"].as_str().unwrap_or("删除自定义音色失败");
    let blob = format!("{code} {message}").to_ascii_lowercase();
    // If the voice was already removed from DashScope, allow the UI to clean up its stale local entry.
    if blob.contains("not found") || blob.contains("not exist") || blob.contains("voicenotfound") {
        return Ok(());
    }
    Err(friendly_enroll_error(code, message))
}

#[tauri::command]
pub async fn voice_realtime_delete_voice(
    base: String,
    voice: String,
    managed: Option<bool>,
) -> Result<(), String> {
    let trimmed = voice.trim();
    if trimmed.is_empty() {
        return Err("缺少要删除的音色 ID".into());
    }
    let payload = delete_request_body(trimmed);
    let (status_ok, data) =
        post_customization(&base, managed.unwrap_or(false), &payload, Duration::from_secs(20))
            .await?;
    parse_delete_response(status_ok, &data)
}

/// Tear down the active session. `ended` is only emitted when a session was
/// actually running, so a fresh start never receives a stale "ended" that
/// would make the frontend drop its listener (the old "no reaction" bug).
async fn stop_inner(app: &AppHandle, manager: &RealtimeManager, speech: &Speech, emit: bool) {
    let taken = manager.active.lock().ok().and_then(|mut g| g.take());
    if let Some(rt) = taken {
        let sid = rt.id;
        rt.running.store(false, Ordering::Release);
        let _ = rt.tx.send(WsOut::Close);
        rt.audio_queue.clear_and_stop(speech);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let queue = Arc::clone(&rt.audio_queue);
            let mic_opt = rt.mic_session;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                queue.shutdown_player();
                if let Some(mic) = mic_opt {
                    #[cfg(target_os = "macos")]
                    objc::rc::autoreleasepool(|| shutdown_mic(mic));
                    #[cfg(target_os = "windows")]
                    mic.shutdown();
                }
            })
            .await;
        }
        if emit {
            let _ = app.emit(EVENT, json!({ "phase": "ended", "sid": sid }));
        }
    } else {
        speech.stop_active();
    }
}

async fn start_inner(
    app: AppHandle,
    manager: RealtimeManager,
    speech: Speech,
    config: RealtimeStartConfig,
    start_gen: u64,
) -> Result<u64, String> {
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = (app, manager, speech, config, start_gen);
        return Err("实时语音采集仅在 macOS 与 Windows 上可用".into());
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let api_key = read_realtime_auth_key(config.managed)?;
        let endpoint = realtime_endpoint(&config.base, &config.model)?;
        #[cfg(target_os = "macos")]
        ensure_microphone_granted(&app).await?;
        if manager.cancel_gen.load(Ordering::Acquire) != start_gen {
            return Err("实时语音启动已取消".into());
        }
        stop_inner(&app, &manager, &speech, false).await;

        let (stream, leftover) = connect_ws(&endpoint, &api_key).await?;
        if manager.cancel_gen.load(Ordering::Acquire) != start_gen {
            return Err("实时语音连接已取消".into());
        }
        let (mut reader, mut writer) = tokio::io::split(stream);

        let running = Arc::new(AtomicBool::new(true));
        let muted = Arc::new(AtomicBool::new(false));
        let bridging = Arc::new(AtomicBool::new(false));
        let interrupted = Arc::new(AtomicBool::new(false));
        let level_bits = Arc::new(AtomicU32::new(0));
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsOut>();
        let audio_queue = Arc::new(AudioPlaybackQueue::new());
        let id = manager.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        let sp_gate = Arc::clone(&audio_queue.gate_until);
        let sp_notify = Arc::clone(&audio_queue.notify);
        if let Ok(Ok(player)) = tauri::async_runtime::spawn_blocking(move || {
            StreamingPlayer::new(sp_gate, sp_notify)
        })
        .await
        {
            audio_queue.set_streaming_player(player);
        }

        let (pcm_tx, mut pcm_rx) = mpsc::channel::<Vec<u8>>(32);
        let mic_running = Arc::clone(&running);
        let mic_muted = Arc::clone(&muted);
        let mic_bridging = Arc::clone(&bridging);
        let mic_level = Arc::clone(&level_bits);
        let mic_gate = Arc::clone(&audio_queue.gate_until);
        let mic_session = match tauri::async_runtime::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            return objc::rc::autoreleasepool(|| {
                start_mic_engine(mic_running, mic_muted, mic_bridging, mic_level, mic_gate, pcm_tx)
            });
            #[cfg(target_os = "windows")]
            return crate::win_audio::WinMicSession::start(
                mic_running,
                mic_muted,
                mic_bridging,
                mic_level,
                Some(mic_gate),
                pcm_tx,
            );
        })
        .await
        {
            Ok(Ok(session)) => session,
            Ok(Err(err)) => {
                running.store(false, Ordering::Release);
                return Err(err);
            }
            Err(_) => {
                running.store(false, Ordering::Release);
                return Err("无法初始化麦克风采集".into());
            }
        };

        if manager.cancel_gen.load(Ordering::Acquire) != start_gen {
            running.store(false, Ordering::Release);
            let queue = Arc::clone(&audio_queue);
            let _ = tauri::async_runtime::spawn_blocking(move || {
                queue.shutdown_player();
                #[cfg(target_os = "macos")]
                objc::rc::autoreleasepool(|| shutdown_mic(mic_session));
                #[cfg(target_os = "windows")]
                mic_session.shutdown();
            })
            .await;
            return Err("实时语音启动已取消".into());
        }

        // Send initial session.update immediately after connecting.
        let _ = out_tx.send(WsOut::Text(session_update_payload(&config).to_string()));

        {
            let mut guard = manager.active.lock().map_err(|_| "实时语音状态不可用")?;
            *guard = Some(ActiveRealtime {
                id,
                running: Arc::clone(&running),
                muted: Arc::clone(&muted),
                bridging: Arc::clone(&bridging),
                interrupted: Arc::clone(&interrupted),
                tx: out_tx.clone(),
                audio_queue: Arc::clone(&audio_queue),
                mic_session: Some(mic_session),
            });
        }

        // 1. WebSocket writer task
        let writer_running = Arc::clone(&running);
        tauri::async_runtime::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                match msg {
                    WsOut::Text(text) => {
                        let frame = encode_ws_frame(0x01, text.as_bytes(), random_bytes::<4>());
                        if writer.write_all(&frame).await.is_err() {
                            break;
                        }
                    }
                    WsOut::Pong(data) => {
                        let frame = encode_ws_frame(0x0A, &data, random_bytes::<4>());
                        if writer.write_all(&frame).await.is_err() {
                            break;
                        }
                    }
                    WsOut::Close => {
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

        // 2. Mic PCM16 batcher -> input_audio_buffer.append (~100ms per packet)
        let mic_tx = out_tx.clone();
        let mic_loop_running = Arc::clone(&running);
        tauri::async_runtime::spawn(async move {
            let mut batch = Vec::with_capacity(6400);
            while mic_loop_running.load(Ordering::Relaxed) {
                let first = tokio::time::timeout(Duration::from_millis(120), pcm_rx.recv()).await;
                match first {
                    Ok(Some(chunk)) => batch.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(_) => {
                        if !batch.is_empty() && batch.len() < 1600 {
                            batch.clear();
                        }
                    }
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
                        "event_id": format!("kbot-aud-{}", next_seq()),
                        "type": "input_audio_buffer.append",
                        "audio": encoded
                    });
                    if mic_tx.send(WsOut::Text(ev.to_string())).is_err() {
                        break;
                    }
                }
            }
        });

        // 3. Level emitter (~45ms throttle, zero allocation on audio thread)
        let lvl_running = Arc::clone(&running);
        let lvl_bits = Arc::clone(&level_bits);
        let lvl_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut sent_nonzero = false;
            while lvl_running.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(45)).await;
                if !lvl_running.load(Ordering::Relaxed) {
                    break;
                }
                let level = f32::from_bits(lvl_bits.swap(0, Ordering::Relaxed));
                if level > 0.005 {
                    sent_nonzero = true;
                    let _ = lvl_app.emit(EVENT, json!({ "sid": id, "phase": "level", "level": level }));
                } else if sent_nonzero {
                    sent_nonzero = false;
                    let _ = lvl_app.emit(EVENT, json!({ "sid": id, "phase": "level", "level": 0.0 }));
                }
            }
        });

        // 4. Audio output playback worker (gapless AVAudioPlayerNode streaming, with afplay fallback)
        let play_running = Arc::clone(&running);
        let play_queue = Arc::clone(&audio_queue);
        let play_speech = speech.clone();
        let play_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while play_running.load(Ordering::Relaxed) {
                if let Some(player) = play_queue.player() {
                    if let Some(pcm) = play_queue.pop_next_stream_pcm() {
                        let p = Arc::clone(&player);
                        let res = tauri::async_runtime::spawn_blocking(move || p.schedule_pcm(&pcm)).await;
                        match res {
                            Ok(Ok(())) => continue,
                            Ok(Err(_)) | Err(_) => {
                                // Drop broken streaming player and fall back cleanly.
                                play_queue.shutdown_player();
                            }
                        }
                    }
                } else if let Some((gen, wav)) = play_queue.pop_next_wav() {
                    play_queue.gate_for_wav(wav.len());
                    match play_segment(&play_speech, gen, wav).await {
                        Ok(true) => {}
                        Ok(false) => {
                            play_queue.clear_and_stop(&play_speech);
                        }
                        Err(err) => {
                            play_queue.clear_and_stop(&play_speech);
                            let _ = play_app.emit(EVENT, json!({ "sid": id, "phase": "error", "message": err }));
                        }
                    }
                    continue;
                }
                if play_queue.complete_if_idle() {
                    let _ = play_app.emit(EVENT, json!({ "sid": id, "phase": "speaking_done" }));
                }
                tokio::select! {
                    _ = play_queue.notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(80)) => {}
                }
            }
        });

        // 5. WebSocket reader loop
        let rd_running = Arc::clone(&running);
        let rd_manager = manager.clone();
        let rd_app = app.clone();
        let rd_speech = speech.clone();
        let rd_queue = Arc::clone(&audio_queue);
        let rd_level = Arc::clone(&level_bits);
        let rd_interrupted = Arc::clone(&interrupted);
        let rd_tx = out_tx;
        tauri::async_runtime::spawn(async move {
            let mut buf = leftover;
            let mut frag_buf: Vec<u8> = Vec::new();
            let mut frag_is_text = false;
            let mut seen_tool_calls: HashSet<String> = HashSet::new();
            let mut tmp = [0u8; 8192];

            'outer: while rd_running.load(Ordering::Relaxed) {
                loop {
                    match try_decode_ws_frame(&mut buf) {
                        Ok(Some(frame)) => match frame.opcode {
                            0x01 | 0x02 => {
                                let is_text = frame.opcode == 0x01;
                                if frame.fin {
                                    if is_text {
                                        if let Ok(txt) = String::from_utf8(frame.payload) {
                                            handle_server_event(
                                                id,
                                                &txt,
                                                &rd_app,
                                                &rd_speech,
                                                &rd_queue,
                                                &rd_level,
                                                &rd_interrupted,
                                                &mut seen_tool_calls,
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
                                            handle_server_event(
                                                id,
                                                &txt,
                                                &rd_app,
                                                &rd_speech,
                                                &rd_queue,
                                                &rd_level,
                                                &rd_interrupted,
                                                &mut seen_tool_calls,
                                            );
                                        }
                                    }
                                }
                            }
                            0x09 => {
                                let _ = rd_tx.send(WsOut::Pong(frame.payload));
                            }
                            0x08 => {
                                let code = (frame.payload.len() >= 2)
                                    .then(|| u16::from_be_bytes([frame.payload[0], frame.payload[1]]))
                                    .unwrap_or(1000);
                                let reason = String::from_utf8_lossy(frame.payload.get(2..).unwrap_or(&[]))
                                    .trim()
                                    .to_string();
                                if rd_running.load(Ordering::Relaxed) && (code != 1000 || !reason.is_empty()) {
                                    let message = friendly_server_error(if reason.is_empty() {
                                        "实时语音服务关闭了连接"
                                    } else {
                                        &reason
                                    });
                                    let _ = rd_app.emit(EVENT, json!({ "sid": id, "phase": "error", "message": message, "fatal": true }));
                                }
                                break 'outer;
                            }
                            _ => {}
                        },
                        Ok(None) => break,
                        Err(err) => {
                            let _ = rd_app.emit(EVENT, json!({ "sid": id, "phase": "error", "message": err }));
                            break 'outer;
                        }
                    }
                }
                match reader.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    Err(_) => {
                        if rd_running.load(Ordering::Relaxed) {
                            let _ = rd_app.emit(
                                EVENT,
                                json!({ "sid": id, "phase": "error", "message": "实时语音连接已中断" }),
                            );
                        }
                        break;
                    }
                }
            }

            // Cleanup only if this session is still the active one.
            let is_still_active = rd_manager
                .active
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|r| r.id == id))
                .unwrap_or(false);
            if is_still_active {
                stop_inner(&rd_app, &rd_manager, &rd_speech, true).await;
            }
        });

        Ok(id)
    }
}

/// Turn raw DashScope error strings into actionable Chinese hints.
pub(crate) fn friendly_server_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("model not exist") || lower.contains("model not found") {
        return "当前实时语音模型不可用，请到设置 → 语音中切换模型".into();
    }
    if lower.contains("voice") && lower.contains("not supported") {
        return "当前实时模型不支持所选音色，请到设置 → 语音中重新选择音色".into();
    }
    if lower.contains("arrearage") || lower.contains("overdue") || lower.contains("quota") {
        return "实时语音账户欠费或额度不足，请到设置 → 语音中检查".into();
    }
    if lower.contains("access denied") || lower.contains("unauthorized") || lower.contains("invalid api") {
        return "实时语音 API Key 无效或未开通权限，请到设置 → 语音中检查".into();
    }
    raw.to_string()
}

fn handle_server_event(
    sid: u64,
    raw: &str,
    app: &AppHandle,
    speech: &Speech,
    audio_queue: &AudioPlaybackQueue,
    level_bits: &Arc<AtomicU32>,
    interrupted: &Arc<AtomicBool>,
    seen_tool_calls: &mut HashSet<String>,
) {
    let Ok(ev) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let kind = ev["type"].as_str().unwrap_or("");
    if kind.is_empty() {
        // DashScope sometimes sends bare `{code, message}` before closing.
        if let Some(msg) = ev["message"].as_str() {
            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "error", "message": friendly_server_error(msg) }));
        }
        return;
    }
    match kind {
        // Only report ready once our session.update was accepted.
        "session.updated" => {
            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "ready", "event": kind }));
        }
        "response.created" => {
            interrupted.store(false, Ordering::Release);
        }
        "input_audio_buffer.speech_started" => {
            interrupted.store(false, Ordering::Release);
            audio_queue.clear_and_stop(speech);
            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "listening" }));
        }
        "input_audio_buffer.speech_stopped" => {
            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "thinking" }));
        }
        "conversation.item.input_audio_transcription.delta" => {
            if let Some(delta) = ev["delta"].as_str() {
                if !delta.is_empty() {
                    let _ = app.emit(
                        EVENT,
                        json!({ "sid": sid, "phase": "user_transcript", "delta": delta, "isFinal": false }),
                    );
                }
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let text = ev["transcript"].as_str().unwrap_or("").trim();
            if !text.is_empty() {
                let _ = app.emit(
                    EVENT,
                    json!({ "sid": sid, "phase": "user_transcript", "text": text, "isFinal": true }),
                );
            }
        }
        "response.audio_transcript.delta"
        | "response.output_audio_transcript.delta"
        | "response.text.delta"
        | "response.output_text.delta" => {
            if interrupted.load(Ordering::Acquire) {
                return;
            }
            if let Some(delta) = ev["delta"].as_str() {
                if !delta.is_empty() {
                    let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "assistant_delta", "delta": delta }));
                }
            }
        }
        "response.audio.delta" | "response.output_audio.delta" => {
            if interrupted.load(Ordering::Acquire) {
                return;
            }
            if let Some(b64) = ev["delta"].as_str() {
                if let Ok(pcm) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                    if !pcm.is_empty() {
                        let lvl = pcm16_audio_level(&pcm);
                        let prev = f32::from_bits(level_bits.load(Ordering::Relaxed));
                        if lvl > prev {
                            level_bits.store(lvl.to_bits(), Ordering::Relaxed);
                        }
                        if audio_queue.push_pcm(&pcm, speech) {
                            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "speaking" }));
                        }
                    }
                }
            }
        }
        "response.function_call_arguments.done" => {
            if interrupted.load(Ordering::Acquire) {
                return;
            }
            let call_id = ev["call_id"].as_str().unwrap_or("").trim();
            let name = ev["name"].as_str().unwrap_or("").trim();
            let args = ev["arguments"].as_str().unwrap_or("{}");
            if !call_id.is_empty() && !name.is_empty() && seen_tool_calls.insert(call_id.to_string()) {
                let _ = app.emit(
                    EVENT,
                    json!({
                        "sid": sid,
                        "phase": "tool_call",
                        "callId": call_id,
                        "name": name,
                        "arguments": args
                    }),
                );
            }
        }
        "response.output_item.done" => {
            if interrupted.load(Ordering::Acquire) {
                return;
            }
            let item = &ev["item"];
            if item["type"].as_str() == Some("function_call") {
                let call_id = item["call_id"].as_str().unwrap_or("").trim();
                let name = item["name"].as_str().unwrap_or("").trim();
                let args = item["arguments"].as_str().unwrap_or("{}");
                if !call_id.is_empty()
                    && !name.is_empty()
                    && seen_tool_calls.insert(call_id.to_string())
                {
                    let _ = app.emit(
                        EVENT,
                        json!({
                            "sid": sid,
                            "phase": "tool_call",
                            "callId": call_id,
                            "name": name,
                            "arguments": args
                        }),
                    );
                }
            }
        }
        "response.done" => {
            if interrupted.swap(false, Ordering::AcqRel) {
                return;
            }
            audio_queue.finish_turn();
            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "turn_done" }));
        }
        "error" => {
            let code = ev["error"]["code"].as_str().unwrap_or("");
            let msg = ev["error"]["message"]
                .as_str()
                .or_else(|| ev["message"].as_str())
                .unwrap_or("实时语音服务返回错误");
            if code == "response_cancel_not_active" || msg.to_ascii_lowercase().contains("no active response") {
                return;
            }
            let _ = app.emit(EVENT, json!({ "sid": sid, "phase": "error", "message": friendly_server_error(msg) }));
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn try_objc<F: FnOnce() -> T, T>(f: F) -> Result<T, String> {
    use core::ffi::c_void;
    use core::mem::MaybeUninit;
    struct State<F, T> {
        f: Option<F>,
        out: MaybeUninit<T>,
    }
    extern "C-unwind" fn invoke<F: FnOnce() -> T, T>(ctx: *mut c_void) {
        unsafe {
            let state = &mut *(ctx as *mut State<F, T>);
            if let Some(func) = state.f.take() {
                state.out.write(func());
            }
        }
    }
    let mut state = State {
        f: Some(f),
        out: MaybeUninit::uninit(),
    };
    let mut exc: *mut c_void = std::ptr::null_mut();
    let failed = unsafe {
        objc2_exception_helper::try_catch(
            invoke::<F, T>,
            (&mut state as *mut State<F, T>).cast::<c_void>(),
            &mut exc,
        )
    };
    if failed == 0 {
        return Ok(unsafe { state.out.assume_init() });
    }
    let detail = if exc.is_null() {
        String::new()
    } else {
        unsafe { ns_to_string(msg_send![exc as *mut objc::runtime::Object, reason]) }
    };
    Err(if detail.is_empty() {
        "音频设备异常".into()
    } else {
        detail
    })
}

#[cfg(target_os = "macos")]
fn has_audio_input_device() -> bool {
    objc::rc::autoreleasepool(|| unsafe {
        if let Some(cls) = objc::runtime::Class::get("AVCaptureDevice") {
            let media = crate::dictation::ns_string("soun");
            if !media.is_null() {
                let dev: *mut objc::runtime::Object =
                    msg_send![cls, defaultDeviceWithMediaType: media];
                return !dev.is_null();
            }
        }
        true
    })
}

#[cfg(target_os = "macos")]
fn start_mic_engine(
    running: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    bridging: Arc<AtomicBool>,
    level_bits: Arc<AtomicU32>,
    gate_until: Arc<AtomicU64>,
    pcm_tx: mpsc::Sender<Vec<u8>>,
) -> Result<AudioEngineSession, String> {
    use objc::runtime::Object;
    ensure_audio_frameworks()?;

    if !has_audio_input_device() {
        return Err("当前没有检测到可用的麦克风输入设备，请连接麦克风或耳机后再试。文字输入不受影响。".into());
    }

    let engine: *mut Object = unsafe { msg_send![class!(AVAudioEngine), new] };
    if engine.is_null() {
        return Err("无法启动麦克风采集引擎".into());
    }
    let (input, sample_rate, channel_count) = match try_objc(|| unsafe {
        let input: *mut Object = msg_send![engine, inputNode];
        let in_fmt: *mut Object = if input.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![input, inputFormatForBus: 0usize]
        };
        let out_fmt: *mut Object = if input.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![input, outputFormatForBus: 0usize]
        };
        let fmt = if !in_fmt.is_null() { in_fmt } else { out_fmt };
        let (sr, ch) = if fmt.is_null() {
            (0.0f64, 0u32)
        } else {
            let sr: f64 = msg_send![fmt, sampleRate];
            let ch: u32 = msg_send![fmt, channelCount];
            (sr, ch)
        };
        (input, sr, ch)
    }) {
        Ok(vals) => vals,
        Err(detail) => {
            release(engine);
            return Err(format!("麦克风还没有准备好（{detail}）。文字输入不受影响。"));
        }
    };
    if input.is_null() || sample_rate <= 0.0 || channel_count == 0 {
        release(engine);
        return Err("当前没有检测到可用的麦克风输入设备，请连接麦克风或耳机后再试。文字输入不受影响。".into());
    }

    let tap_running = Arc::clone(&running);
    let tap_muted = Arc::clone(&muted);
    let tap_bridging = Arc::clone(&bridging);
    let tap_level = Arc::clone(&level_bits);
    let tap_phase = AtomicU64::new(0.0f64.to_bits());
    let tap = block::ConcreteBlock::new(move |buffer: *mut Object, _when: *mut Object| {
        if !tap_running.load(Ordering::Relaxed)
            || tap_muted.load(Ordering::Relaxed)
            || tap_bridging.load(Ordering::Relaxed)
            || buffer.is_null()
        {
            return;
        }
        // Echo guard: while KBOT's own voice is playing, don't feed it back to
        // the server VAD (it would interrupt itself mid-sentence).
        if now_ms() < gate_until.load(Ordering::Relaxed) {
            return;
        }
        unsafe {
            let frame_len: u32 = msg_send![buffer, frameLength];
            let channels: *const *const f32 = msg_send![buffer, floatChannelData];
            if frame_len == 0 || channels.is_null() {
                return;
            }
            let first_ch = *channels;
            if first_ch.is_null() {
                return;
            }
            let buf_fmt: *mut Object = msg_send![buffer, format];
            let buf_sr: f64 = if buf_fmt.is_null() {
                sample_rate
            } else {
                let sr: f64 = msg_send![buf_fmt, sampleRate];
                if sr > 0.0 { sr } else { sample_rate }
            };
            let samples = std::slice::from_raw_parts(first_ch, frame_len as usize);
            let lvl = compute_audio_level(samples);
            let prev = f32::from_bits(tap_level.load(Ordering::Relaxed));
            if lvl > prev {
                tap_level.store(lvl.to_bits(), Ordering::Relaxed);
            }
            let mut phase = f64::from_bits(tap_phase.load(Ordering::Relaxed));
            let pcm = downsample_f32_to_pcm16_16k(samples, buf_sr, &mut phase);
            tap_phase.store(phase.to_bits(), Ordering::Relaxed);
            if !pcm.is_empty() {
                let _ = pcm_tx.try_send(pcm);
            }
        }
    })
    .copy();

    let start_res = try_objc(|| unsafe {
        let nil_fmt: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![input, installTapOnBus: 0usize bufferSize: 1024u32 format: nil_fmt block: &*tap];
        let _: () = msg_send![engine, prepare];
        let mut err: *mut Object = std::ptr::null_mut();
        let started: bool = msg_send![engine, startAndReturnError: &mut err];
        if started {
            Ok(())
        } else {
            let detail = if err.is_null() {
                String::new()
            } else {
                ns_to_string(msg_send![err, localizedDescription])
            };
            Err(detail)
        }
    });
    match start_res {
        Ok(Ok(())) => {}
        Ok(Err(detail)) => {
            let _ = try_objc(|| unsafe {
                let _: () = msg_send![input, removeTapOnBus: 0usize];
            });
            release(engine);
            let extra = if detail.is_empty() {
                String::new()
            } else {
                format!("（{detail}）")
            };
            return Err(format!("无法开启实时麦克风{extra}"));
        }
        Err(exc_detail) => {
            let _ = try_objc(|| unsafe {
                let _: () = msg_send![input, removeTapOnBus: 0usize];
            });
            release(engine);
            if exc_detail.contains("format mismatch") || exc_detail.contains("AVAudioFormat") {
                return Err("麦克风音频格式切换中或当前无可用输入设备，请稍后重试。文字输入不受影响。".into());
            }
            return Err(format!("无法开启实时麦克风（{exc_detail}）"));
        }
    }

    Ok(AudioEngineSession {
        engine: engine as usize,
        input: input as usize,
        tapped: true,
        running,
        keep: Box::new(Keep(tap)),
    })
}

#[cfg(target_os = "macos")]
fn shutdown_mic(session: AudioEngineSession) {
    session.running.store(false, Ordering::Relaxed);
    let engine = session.engine as *mut objc::runtime::Object;
    let input = session.input as *mut objc::runtime::Object;
    unsafe {
        if session.tapped && !input.is_null() {
            let _: () = msg_send![input, removeTapOnBus: 0usize];
        }
        if !engine.is_null() {
            let _: () = msg_send![engine, stop];
        }
    }
    release(engine);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live protocol probe against DashScope using the locally saved key.
    /// Run: cargo test --offline --lib live_dashscope_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_dashscope_probe() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let key = read_key("realtime").unwrap();
            assert!(!key.trim().is_empty(), "no realtime key saved");
            let model = std::env::var("RT_MODEL").unwrap_or_default();
            let url = realtime_endpoint("", &model).unwrap();
            println!("url = {url}");
            let (stream, mut buf) = connect_ws(&url, key.trim()).await.expect("connect");
            let (mut reader, mut writer) = tokio::io::split(stream);
            let cfg = RealtimeStartConfig {
                model: model.clone(),
                instructions: std::env::var("RT_INST").unwrap_or_default(),
                ..Default::default()
            };
            let mut updv = session_update_payload(&cfg);
            if let Ok(v) = std::env::var("RT_VOICE") { if v == "none" { updv["session"].as_object_mut().unwrap().remove("voice"); } else { updv["session"]["voice"] = json!(v); } }
            if let Ok(v) = std::env::var("RT_TRANS") { if v == "none" { updv["session"].as_object_mut().unwrap().remove("input_audio_transcription"); } else { updv["session"]["input_audio_transcription"]["model"] = json!(v); } }
            if let Ok(v) = std::env::var("RT_FMT") { if v == "none" { let o = updv["session"].as_object_mut().unwrap(); o.remove("input_audio_format"); o.remove("output_audio_format"); } else { updv["session"]["input_audio_format"] = json!(v); updv["session"]["output_audio_format"] = json!("pcm24"); } }
            if std::env::var("RT_NOTOOLS").is_ok() { updv["session"].as_object_mut().unwrap().remove("tools"); }
            let upd = updv.to_string();
            let steps = std::env::var("RT_STEPS").unwrap_or_else(|_| "uat".into());
            if steps.contains('u') { writer.write_all(&encode_ws_frame(1, upd.as_bytes(), random_bytes::<4>())).await.unwrap(); }
            let silence = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 3200]);
            for _ in 0..(if steps.contains('a') { 5 } else { 0 }) {
                let ev = json!({"type":"input_audio_buffer.append","audio": silence}).to_string();
                writer.write_all(&encode_ws_frame(1, ev.as_bytes(), random_bytes::<4>())).await.unwrap();
            }
            if steps.contains('t') {
            let prompt_text = std::env::var("RT_TEXT").unwrap_or_else(|_| "你好，用一句话介绍你自己".into());
            let item = json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":prompt_text}]}}).to_string();
            writer.write_all(&encode_ws_frame(1, item.as_bytes(), random_bytes::<4>())).await.unwrap();
            let rsp = json!({"type":"response.create"}).to_string();
            writer.write_all(&encode_ws_frame(1, rsp.as_bytes(), random_bytes::<4>())).await.unwrap();
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            let mut tmp = [0u8; 8192];
            let mut audio_deltas = 0;
            let mut replied_tool = false;
            loop {
                while let Ok(Some(f)) = try_decode_ws_frame(&mut buf) {
                    if f.opcode == 1 {
                        let v: Value = serde_json::from_slice(&f.payload).unwrap_or(Value::Null);
                        let t = v["type"].as_str().unwrap_or("?").to_string();
                        if t.ends_with("audio.delta") { audio_deltas += 1; continue; }
                        let mut s = String::from_utf8_lossy(&f.payload).to_string();
                        if s.len() > 1500 { let mut i = 1500; while !s.is_char_boundary(i) { i -= 1; } s.truncate(i); }
                        println!("<< {t}: {s}");
                        if t == "response.function_call_arguments.done" && std::env::var("RT_TOOL_REPLY").is_ok() && !replied_tool {
                            replied_tool = true;
                            let call_id = v["call_id"].as_str().unwrap_or("");
                            let item_msg = json!({
                                "event_id": "probe-tool-out",
                                "type": "conversation.item.create",
                                "item": {
                                    "type": "function_call_output",
                                    "call_id": call_id,
                                    "output": "已查到：今天科技头条是某开源多模态模型发布；MEMORY.md 里记录了用户偏好的称呼是老大。"
                                }
                            });
                            let rsp_msg = json!({ "event_id": "probe-tool-rsp", "type": "response.create" });
                            writer.write_all(&encode_ws_frame(1, item_msg.to_string().as_bytes(), random_bytes::<4>())).await.unwrap();
                            writer.write_all(&encode_ws_frame(1, rsp_msg.to_string().as_bytes(), random_bytes::<4>())).await.unwrap();
                        }
                        if t == "response.done" {
                            println!("audio deltas: {audio_deltas}");
                            if !replied_tool || audio_deltas > 0 { return; }
                        }
                    } else {
                        println!("<< opcode {} len {} {:?}", f.opcode, f.payload.len(), String::from_utf8_lossy(&f.payload.get(2..).unwrap_or(&[])));
                        if f.opcode == 8 { return; }
                    }
                }
                let n = match tokio::time::timeout_at(deadline, reader.read(&mut tmp)).await {
                    Ok(Ok(n)) if n > 0 => n,
                    other => { println!("read end: {:?}", other.map(|r| r.map_err(|e| e.to_string()))); return; }
                };
                buf.extend_from_slice(&tmp[..n]);
            }
        });
    }

    #[test]
    fn validates_realtime_endpoint_and_appends_model() {
        let url = realtime_endpoint("", "").unwrap();
        assert_eq!(
            url.as_str(),
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime"
        );
        let retired = realtime_endpoint("", "qwen-omni-turbo-realtime").unwrap();
        assert_eq!(
            retired.as_str(),
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-flash-realtime"
        );
        let custom = realtime_endpoint(
            "wss://ws-cn-beijing.dashscope.aliyuncs.com/api-ws/v1/realtime",
            "qwen3.8-omni-flash-realtime",
        )
        .unwrap();
        assert_eq!(
            custom.as_str(),
            "wss://ws-cn-beijing.dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime"
        );
        assert!(realtime_endpoint("ws://dashscope.aliyuncs.com/api-ws/v1/realtime", "").is_err());
        assert!(realtime_endpoint("ws://127.0.0.1:8080/realtime", "").is_ok());
        assert!(realtime_endpoint("wss://user:pass@example.com/rt", "").is_err());
    }

    #[test]
    fn resamples_48k_float_to_16k_pcm16_with_phase_continuity() {
        let mut phase = 0.0;
        let samples = vec![0.5f32; 480];
        let pcm = downsample_f32_to_pcm16_16k(&samples, 48_000.0, &mut phase);
        assert_eq!(pcm.len(), 160 * 2);
        let first = i16::from_le_bytes([pcm[0], pcm[1]]);
        assert!((first - 16383).abs() <= 2, "got {first}");

        // 44.1kHz fractional step preserves sample count continuity across chunks
        let mut phase44 = 0.0;
        let chunk = vec![0.25f32; 441];
        let pcm1 = downsample_f32_to_pcm16_16k(&chunk, 44_100.0, &mut phase44);
        let pcm2 = downsample_f32_to_pcm16_16k(&chunk, 44_100.0, &mut phase44);
        assert_eq!(pcm1.len() + pcm2.len(), 320 * 2);
    }

    #[test]
    fn builds_valid_24khz_wav_header() {
        let pcm = vec![0u8; 480];
        let wav = pcm16_to_wav(&pcm, 24_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 24_000);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 480);
        assert_eq!(wav.len(), 44 + 480);
    }

    #[test]
    fn builds_session_update_with_dsh_tool_and_vad() {
        // Legacy retired model & voice migrate cleanly to qwen3.5 + Tina.
        let migrated = session_update_payload(&RealtimeStartConfig {
            managed: false,
            base: "".into(),
            model: "qwen3-omni-flash-realtime".into(),
            voice: "Cherry".into(),
            instructions: "自定义管家指令".into(),
        });
        assert_eq!(migrated["type"], "session.update");
        assert_eq!(migrated["session"]["voice"], "Tina");
        assert!(migrated["session"].get("input_audio_transcription").is_none());
        assert_eq!(migrated["session"]["input_audio_format"], "pcm");
        assert_eq!(migrated["session"]["output_audio_format"], "pcm");
        assert_eq!(migrated["session"]["turn_detection"]["type"], "server_vad");
        assert_eq!(
            migrated["session"]["tools"][0]["function"]["name"],
            "ask_dsh"
        );

        let zane_on_35 = voice_for("qwen3.5-omni-flash-realtime", "Zane");
        assert_eq!(zane_on_35.as_deref(), Some("Tina"));
        let zane_on_38 = voice_for("qwen3.8-omni-flash-realtime", "Zane");
        assert_eq!(zane_on_38.as_deref(), Some("Zane"));
        let empty_on_38 = voice_for("qwen3.8-omni-flash-realtime", "");
        assert_eq!(empty_on_38.as_deref(), Some("Tina"));
        let custom_on_35 = voice_for("qwen3.5-omni-flash-realtime", "qwen-omni-vc-jarvis-123");
        assert_eq!(custom_on_35.as_deref(), Some("qwen-omni-vc-jarvis-123"));
        assert!(friendly_server_error("Model not exist.").contains("切换模型"));
        assert!(friendly_server_error("Voice 'Cherry' is not supported.").contains("重新选择音色"));
    }

    #[test]
    fn voice_enrollment_helpers_validate_urls_audio_and_payloads() {
        assert_eq!(
            customization_endpoint("").unwrap().as_str(),
            "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization"
        );
        assert_eq!(
            customization_endpoint("wss://ws-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime")
                .unwrap()
                .as_str(),
            "https://ws-abc.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization"
        );
        assert_eq!(sanitize_preferred_name("jarvis_uk-v1!!"), "jarvisukv1");
        assert_eq!(sanitize_preferred_name(""), "kbotvoice");
        assert!(validate_sample_url("http://example.com/a.wav").is_err());
        assert!(validate_sample_url("https://huggingface.co/FuturePresentLabs/tts-jarvis/resolve/main/samples/preview-longform.wav").is_ok());

        let mut wav = vec![0u8; 1024];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert_eq!(detect_audio_mime(&wav, None, None).unwrap(), "audio/wav");

        let mut mp3 = vec![0u8; 1024];
        mp3[0..3].copy_from_slice(b"ID3");
        assert_eq!(detect_audio_mime(&mp3, None, None).unwrap(), "audio/mpeg");

        assert!(detect_audio_mime(&[0u8; 100], Some("audio/wav"), None).is_err());

        let body = enroll_request_body("qwen3.5-omni-flash-realtime", "jarvis", "audio/wav", &wav);
        assert_eq!(body["model"], "qwen-voice-enrollment");
        assert_eq!(body["input"]["action"], "create");
        assert_eq!(body["input"]["target_model"], "qwen3.5-omni-flash-realtime");
        assert!(body["input"]["audio"]["data"]
            .as_str()
            .unwrap()
            .starts_with("data:audio/wav;base64,"));

        assert_eq!(
            parse_enroll_response(true, &json!({ "output": { "voice": "qwen-omni-vc-jarvis-1" } })).unwrap(),
            "qwen-omni-vc-jarvis-1"
        );
        assert!(parse_enroll_response(false, &json!({ "code": "InvalidApiKey", "message": "Invalid API-key" })).is_err());

        let listed = parse_voice_list_response(
            true,
            &json!({
                "output": {
                    "voice_list": [
                        { "voice": "v1", "target_model": "qwen3.5-omni-flash-realtime", "gmt_create": "2026-11-16" }
                    ]
                }
            }),
        )
        .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].voice, "v1");

        let del = delete_request_body("qwen-omni-vc-jarvis-1");
        assert_eq!(del["model"], "qwen-voice-enrollment");
        assert_eq!(del["input"]["action"], "delete");
        assert_eq!(del["input"]["voice"], "qwen-omni-vc-jarvis-1");
        assert!(parse_delete_response(true, &json!({ "request_id": "r1" })).is_ok());
        assert!(parse_delete_response(false, &json!({ "code": "InvalidParameter", "message": "Voice not found" })).is_ok());
        assert!(parse_delete_response(false, &json!({ "code": "InvalidApiKey", "message": "Invalid API-key" })).is_err());
    }

    #[test]
    fn encodes_and_decodes_websocket_frames_and_accept_hash() {
        // RFC 6455 Section 1.3 test vector
        assert_eq!(
            websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        let msg = "hello 百炼";
        let mut frame = encode_ws_frame(0x01, msg.as_bytes(), [0x12, 0x34, 0x56, 0x78]);
        let decoded = try_decode_ws_frame(&mut frame).unwrap().unwrap();
        assert!(decoded.fin);
        assert_eq!(decoded.opcode, 0x01);
        assert_eq!(String::from_utf8(decoded.payload).unwrap(), msg);
        assert!(frame.is_empty());

        // Extended 16-bit payload length (>125 bytes)
        let long = vec![b'a'; 300];
        let mut long_frame = encode_ws_frame(0x01, &long, [1, 2, 3, 4]);
        let decoded_long = try_decode_ws_frame(&mut long_frame).unwrap().unwrap();
        assert_eq!(decoded_long.payload, long);
    }

    #[test]
    fn stream_queue_buffers_initial_jitter_then_flushes_immediately() {
        let speech = Speech::default();
        let queue = AudioPlaybackQueue::new();
        assert!(queue.push_pcm(&vec![0u8; 1000], &speech));
        // Below STREAM_FIRST_BYTES before turn_finished -> wait for initial cushion
        assert!(queue.pop_next_stream_pcm().is_none());
        assert!(!queue.push_pcm(&vec![0u8; STREAM_FIRST_BYTES], &speech));
        let first = queue.pop_next_stream_pcm().unwrap();
        assert_eq!(first.len(), 1000 + STREAM_FIRST_BYTES);

        // Subsequent deltas flush immediately without waiting for big chunks
        queue.push_pcm(&vec![1u8; 120], &speech);
        let next = queue.pop_next_stream_pcm().unwrap();
        assert_eq!(next.len(), 120);

        queue.finish_turn();
        assert!(queue.complete_if_idle());

        #[cfg(target_os = "macos")]
        if let Ok(player) = StreamingPlayer::new(Arc::clone(&queue.gate_until), Arc::clone(&queue.notify)) {
            let silence = vec![0u8; 1920]; // 40ms @ 24kHz PCM16
            player.schedule_pcm(&silence).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while player.in_flight() > 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(player.in_flight(), 0, "player completion handler fired");
            player.stop();
            player.shutdown();
        }
    }
}
