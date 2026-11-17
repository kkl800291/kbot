//! Windows audio backend (WASAPI via `cpal` and `rodio`) shared across
//! streaming realtime voice, Qwen3-TTS playback, and voice dictation.

use crate::dictation::compute_audio_level;
use crate::realtime::{downsample_f32_to_pcm16_16k, now_ms, ECHO_TAIL_MS, OUTPUT_SAMPLE_RATE};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::{mpsc, Notify};

pub(crate) fn input_device_state() -> String {
    let host = cpal::default_host();
    match host.default_input_device().and_then(|d| d.default_input_config().ok()) {
        Some(_) => "authorized".into(),
        None => "unsupported".into(),
    }
}

/// Play WAV/MP3 audio bytes in memory on a background thread using `rodio`.
pub(crate) fn play_audio_bytes(
    bytes: Vec<u8>,
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
) -> Result<(), String> {
    let (ready_tx, ready_rx) = std_mpsc::sync_channel::<Result<(), String>>(1);
    std::thread::Builder::new()
        .name("kbot-win-tts".into())
        .spawn(move || {
            let result = (|| -> Result<(rodio::OutputStream, rodio::Sink), String> {
                let (stream, handle) = rodio::OutputStream::try_default()
                    .map_err(|e| format!("无法打开 Windows 音频输出设备（{e}）"))?;
                let sink = rodio::Sink::try_new(&handle)
                    .map_err(|e| format!("无法创建音频播放通道（{e}）"))?;
                let source = rodio::Decoder::new(Cursor::new(bytes))
                    .map_err(|_| "无法解码语音音频数据".to_string())?;
                sink.append(source);
                sink.play();
                Ok((stream, sink))
            })();

            match result {
                Ok((_stream, sink)) => {
                    let _ = ready_tx.send(Ok(()));
                    while !stop.load(Ordering::Acquire) && !sink.empty() {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    sink.stop();
                    finished.store(true, Ordering::Release);
                }
                Err(err) => {
                    finished.store(true, Ordering::Release);
                    let _ = ready_tx.send(Err(err));
                }
            }
        })
        .map_err(|_| "无法创建音频播放线程".to_string())?;

    ready_rx
        .recv()
        .map_err(|_| "音频播放初始化失败".to_string())?
}

pub(crate) struct WinMicSession {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WinMicSession {
    pub(crate) fn start(
        running: Arc<AtomicBool>,
        muted: Arc<AtomicBool>,
        bridging: Arc<AtomicBool>,
        level_bits: Arc<AtomicU32>,
        gate_until: Option<Arc<AtomicU64>>,
        pcm_tx: mpsc::Sender<Vec<u8>>,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let thr_stop = Arc::clone(&stop);
        let (ready_tx, ready_rx) = std_mpsc::sync_channel::<Result<(), String>>(1);

        let handle = std::thread::Builder::new()
            .name("kbot-win-mic".into())
            .spawn(move || {
                let setup = (|| -> Result<cpal::Stream, String> {
                    let host = cpal::default_host();
                    let device = host.default_input_device().ok_or_else(|| {
                        "当前没有检测到可用的麦克风输入设备，请连接麦克风或耳机后再试。文字输入不受影响。".to_string()
                    })?;
                    let supported = device.default_input_config().map_err(|e| {
                        format!("无法读取麦克风配置（{e}）。请检查 Windows 隐私 → 麦克风权限。")
                    })?;
                    let sample_format = supported.sample_format();
                    let channels = supported.channels().max(1) as usize;
                    let sample_rate = f64::from(supported.sample_rate().0.max(1));
                    let config: cpal::StreamConfig = supported.into();

                    let err_cb = |err: cpal::StreamError| {
                        eprintln!("[kbot-win-mic] stream error: {err}");
                    };

                    let stream = match sample_format {
                        SampleFormat::F32 => build_input_stream::<f32>(
                            &device, &config, channels, sample_rate,
                            Arc::clone(&running), Arc::clone(&thr_stop),
                            muted, bridging, level_bits, gate_until, pcm_tx, err_cb,
                        )?,
                        SampleFormat::I16 => build_input_stream::<i16>(
                            &device, &config, channels, sample_rate,
                            Arc::clone(&running), Arc::clone(&thr_stop),
                            muted, bridging, level_bits, gate_until, pcm_tx, err_cb,
                        )?,
                        SampleFormat::U16 => build_input_stream::<u16>(
                            &device, &config, channels, sample_rate,
                            Arc::clone(&running), Arc::clone(&thr_stop),
                            muted, bridging, level_bits, gate_until, pcm_tx, err_cb,
                        )?,
                        other => {
                            return Err(format!("不支持的麦克风采样格式: {other:?}"));
                        }
                    };
                    stream
                        .play()
                        .map_err(|e| format!("无法开启麦克风采集（{e}）"))?;
                    Ok(stream)
                })();

                match setup {
                    Ok(stream) => {
                        let _ = ready_tx.send(Ok(()));
                        while !thr_stop.load(Ordering::Acquire) && running.load(Ordering::Relaxed) {
                            std::thread::sleep(Duration::from_millis(40));
                        }
                        drop(stream);
                    }
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                    }
                }
            })
            .map_err(|_| "无法启动麦克风采集线程".to_string())?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(handle),
            }),
            Ok(Err(err)) => {
                let _ = handle.join();
                Err(err)
            }
            Err(_) => {
                let _ = handle.join();
                Err("无法初始化麦克风采集".into())
            }
        }
    }

    pub(crate) fn shutdown(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for WinMicSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    sample_rate: f64,
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    bridging: Arc<AtomicBool>,
    level_bits: Arc<AtomicU32>,
    gate_until: Option<Arc<AtomicU64>>,
    pcm_tx: mpsc::Sender<Vec<u8>>,
    err_cb: fn(cpal::StreamError),
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut phase = 0.0f64;
    let mut mono = Vec::with_capacity(1024);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if stop.load(Ordering::Relaxed)
                    || !running.load(Ordering::Relaxed)
                    || muted.load(Ordering::Relaxed)
                    || bridging.load(Ordering::Relaxed)
                {
                    return;
                }
                if let Some(ref gate) = gate_until {
                    if now_ms() < gate.load(Ordering::Relaxed) {
                        return;
                    }
                }
                mono.clear();
                if channels <= 1 {
                    mono.extend(data.iter().map(|s| s.to_sample::<f32>()));
                } else {
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                        mono.push(sum / frame.len() as f32);
                    }
                }
                if mono.is_empty() {
                    return;
                }
                let lvl = compute_audio_level(&mono);
                let prev = f32::from_bits(level_bits.load(Ordering::Relaxed));
                if lvl > prev {
                    level_bits.store(lvl.to_bits(), Ordering::Relaxed);
                }
                let pcm = downsample_f32_to_pcm16_16k(&mono, sample_rate, &mut phase);
                if !pcm.is_empty() {
                    let _ = pcm_tx.try_send(pcm);
                }
            },
            err_cb,
            None,
        )
        .map_err(|e| format!("无法创建麦克风采集流（{e}）"))
}

pub(crate) struct WinSpeaker {
    stop: Arc<AtomicBool>,
    queue: Arc<Mutex<VecDeque<f32>>>,
    in_flight: Arc<AtomicUsize>,
    out_sample_rate: u32,
    gate_until: Arc<AtomicU64>,
    notify: Arc<Notify>,
    resample_phase: Mutex<f64>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl WinSpeaker {
    pub(crate) fn new(gate_until: Arc<AtomicU64>, notify: Arc<Notify>) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let queue = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(48_000)));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let (ready_tx, ready_rx) = std_mpsc::sync_channel::<Result<u32, String>>(1);

        let thr_stop = Arc::clone(&stop);
        let thr_queue = Arc::clone(&queue);
        let thr_flight = Arc::clone(&in_flight);
        let thr_notify = Arc::clone(&notify);

        let handle = std::thread::Builder::new()
            .name("kbot-win-speaker".into())
            .spawn(move || {
                let setup = (|| -> Result<(cpal::Stream, u32), String> {
                    let host = cpal::default_host();
                    let device = host
                        .default_output_device()
                        .ok_or_else(|| "未检测到可用的音频输出设备".to_string())?;
                    let supported = device
                        .default_output_config()
                        .map_err(|e| format!("无法读取扬声器配置（{e}）"))?;
                    let sample_format = supported.sample_format();
                    let channels = supported.channels().max(1) as usize;
                    let out_sr = supported.sample_rate().0.max(1);
                    let config: cpal::StreamConfig = supported.into();
                    let err_cb = |err: cpal::StreamError| {
                        eprintln!("[kbot-win-speaker] stream error: {err}");
                    };

                    let stream = match sample_format {
                        SampleFormat::F32 => build_output_stream::<f32>(
                            &device,
                            &config,
                            channels,
                            Arc::clone(&thr_queue),
                            Arc::clone(&thr_flight),
                            Arc::clone(&thr_notify),
                            err_cb,
                        )?,
                        SampleFormat::I16 => build_output_stream::<i16>(
                            &device,
                            &config,
                            channels,
                            Arc::clone(&thr_queue),
                            Arc::clone(&thr_flight),
                            Arc::clone(&thr_notify),
                            err_cb,
                        )?,
                        SampleFormat::U16 => build_output_stream::<u16>(
                            &device,
                            &config,
                            channels,
                            Arc::clone(&thr_queue),
                            Arc::clone(&thr_flight),
                            Arc::clone(&thr_notify),
                            err_cb,
                        )?,
                        other => return Err(format!("不支持的音频输出格式: {other:?}")),
                    };
                    stream
                        .play()
                        .map_err(|e| format!("无法启动实时音频输出（{e}）"))?;
                    Ok((stream, out_sr))
                })();

                match setup {
                    Ok((stream, out_sr)) => {
                        let _ = ready_tx.send(Ok(out_sr));
                        while !thr_stop.load(Ordering::Acquire) {
                            std::thread::sleep(Duration::from_millis(40));
                        }
                        drop(stream);
                    }
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                    }
                }
            })
            .map_err(|_| "无法创建实时音频输出线程".to_string())?;

        match ready_rx.recv() {
            Ok(Ok(out_sample_rate)) => Ok(Self {
                stop,
                queue,
                in_flight,
                out_sample_rate,
                gate_until,
                notify,
                resample_phase: Mutex::new(0.0),
                thread: Mutex::new(Some(handle)),
            }),
            Ok(Err(err)) => {
                let _ = handle.join();
                Err(err)
            }
            Err(_) => {
                let _ = handle.join();
                Err("实时音频输出初始化失败".into())
            }
        }
    }

    pub(crate) fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    pub(crate) fn schedule_pcm(&self, pcm16_le: &[u8]) -> Result<(), String> {
        if self.stop.load(Ordering::Acquire) {
            return Err("实时音频输出已关闭".into());
        }
        let sample_count = pcm16_le.len() / 2;
        if sample_count == 0 {
            return Ok(());
        }
        let mut src = Vec::with_capacity(sample_count);
        for pair in pcm16_le.chunks_exact(2) {
            let s = i16::from_le_bytes([pair[0], pair[1]]);
            src.push(f32::from(s) / 32768.0);
        }

        let out_sr = f64::from(self.out_sample_rate);
        let in_sr = f64::from(OUTPUT_SAMPLE_RATE);
        let resampled = if (self.out_sample_rate - OUTPUT_SAMPLE_RATE) == 0 {
            src
        } else {
            let mut phase_guard = self.resample_phase.lock().map_err(|_| "重采样锁不可用")?;
            let step = in_sr / out_sr;
            let mut pos = *phase_guard;
            let mut dst = Vec::with_capacity(((src.len() as f64 / step).ceil() as usize) + 2);
            while pos < src.len() as f64 {
                let idx = pos as usize;
                let frac = pos - (idx as f64);
                let s0 = f64::from(src[idx]);
                let s1 = if idx + 1 < src.len() { f64::from(src[idx + 1]) } else { s0 };
                dst.push((s0 + (s1 - s0) * frac) as f32);
                pos += step;
            }
            *phase_guard = (pos - src.len() as f64).max(0.0);
            dst
        };

        let queued_total = {
            let mut q = self.queue.lock().map_err(|_| "音频输出队列不可用")?;
            q.extend(resampled);
            q.len()
        };
        self.in_flight.store(queued_total, Ordering::Release);
        let remaining_ms = (queued_total as u64 * 1000) / u64::from(self.out_sample_rate.max(1));
        self.gate_until
            .store(now_ms() + remaining_ms + ECHO_TAIL_MS, Ordering::Release);
        Ok(())
    }

    pub(crate) fn stop(&self) {
        if let Ok(mut q) = self.queue.lock() {
            q.clear();
        }
        if let Ok(mut p) = self.resample_phase.lock() {
            *p = 0.0;
        }
        self.in_flight.store(0, Ordering::Release);
        self.gate_until.store(0, Ordering::Release);
        self.notify.notify_one();
    }

    pub(crate) fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        self.stop();
        if let Ok(mut thr) = self.thread.lock() {
            if let Some(handle) = thr.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for WinSpeaker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn build_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    queue: Arc<Mutex<VecDeque<f32>>>,
    in_flight: Arc<AtomicUsize>,
    notify: Arc<Notify>,
    err_cb: fn(cpal::StreamError),
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                let mut remaining = 0usize;
                let mut emptied = false;
                if let Ok(mut q) = queue.lock() {
                    let was_non_empty = !q.is_empty();
                    for frame in output.chunks_mut(channels) {
                        let sample = q.pop_front().unwrap_or(0.0);
                        let converted = T::from_sample(sample);
                        for ch in frame.iter_mut() {
                            *ch = converted;
                        }
                    }
                    remaining = q.len();
                    emptied = was_non_empty && remaining == 0;
                } else {
                    for slot in output.iter_mut() {
                        *slot = T::from_sample(0.0);
                    }
                }
                in_flight.store(remaining, Ordering::Release);
                if emptied {
                    notify.notify_one();
                }
            },
            err_cb,
            None,
        )
        .map_err(|e| format!("无法创建音频输出流（{e}）"))
}
