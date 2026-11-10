//! macOS system speech. User text is written to `say`'s stdin, never concatenated
//! into a shell command. Dictation is not implemented; this module only reports
//! the current microphone and speech-recognition permission without prompting.

use serde::Serialize;
use std::{
    io::Write,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

const MAX_CHARS: usize = 4_000;
const DICTATION_MESSAGE: &str = "听写还没有接入。当前只查询麦克风和语音识别权限，不会弹出系统授权框，也不会把声音发给模型。文字输入不受影响。";

#[derive(Clone, Default)]
pub struct Speech(Arc<Mutex<Option<Child>>>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpeechPlan {
    pub args: Vec<String>,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub name: String,
    pub locale: String,
    pub sample: String,
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
    voice: Option<String>,
    rate: Option<f64>,
) -> Result<(), String> {
    let plan = speech_plan(&text, voice.as_deref(), rate)?;
    let speech = speech.inner().clone();
    tauri::async_runtime::spawn_blocking(move || speak_plan(&speech, &plan))
        .await
        .map_err(|_| "朗读任务失败".to_string())?
}

#[tauri::command]
pub async fn voice_stop(speech: tauri::State<'_, Speech>) -> Result<(), String> {
    let speech = speech.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_speech(&speech))
        .await
        .map_err(|_| "停止朗读失败".to_string())?
}

#[tauri::command]
pub async fn voice_list() -> Result<Vec<VoiceInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_voices)
        .await
        .map_err(|_| "无法读取系统声音".to_string())?
}

#[tauri::command]
pub fn voice_permission_status() -> DictationStatus {
    permission_status()
}

pub(crate) fn speech_plan(
    text: &str,
    voice: Option<&str>,
    rate: Option<f64>,
) -> Result<SpeechPlan, String> {
    if text.is_empty() || text.chars().all(char::is_whitespace) {
        return Err("没有可以朗读的文本".into());
    }
    if text.chars().count() > MAX_CHARS {
        return Err("朗读文本过长".into());
    }
    if text.contains('\0') {
        return Err("朗读文本无效".into());
    }
    let mut args = Vec::new();
    if let Some(voice) = voice.map(str::trim).filter(|voice| !voice.is_empty()) {
        validate_voice(voice)?;
        args.push("-v".into());
        args.push(voice.to_string());
    }
    if let Some(rate) = rate {
        args.push("-r".into());
        args.push(validate_rate(rate)?.to_string());
    }
    Ok(SpeechPlan {
        args,
        text: text.to_string(),
    })
}

fn validate_voice(voice: &str) -> Result<(), String> {
    if voice.chars().count() > 80 || voice.starts_with('-') {
        return Err("声音名称无效".into());
    }
    if voice
        .chars()
        .any(|ch| ch.is_control() || "#|&;$`'\"\\".contains(ch))
    {
        return Err("声音名称无效".into());
    }
    Ok(())
}

fn validate_rate(rate: f64) -> Result<u32, String> {
    if !rate.is_finite() {
        return Err("语速无效".into());
    }
    let rate = rate.round();
    if !(80.0..=450.0).contains(&rate) {
        return Err("语速需要在 80 到 450 之间".into());
    }
    Ok(rate as u32)
}

fn speak_plan(speech: &Speech, plan: &SpeechPlan) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/say")
        .args(&plan.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法启动系统朗读")?;
    {
        let mut stdin = child.stdin.take().ok_or("无法把文本交给系统朗读")?;
        stdin
            .write_all(plan.text.as_bytes())
            .map_err(|_| "无法把文本交给系统朗读")?;
    }
    let mut guard = speech.0.lock().map_err(|_| "朗读状态不可用")?;
    reap(&mut guard);
    if let Some(previous) = guard.as_mut() {
        let _ = previous.kill();
        let _ = previous.wait();
    }
    *guard = Some(child);
    Ok(())
}

fn stop_speech(speech: &Speech) -> Result<(), String> {
    let mut guard = speech.0.lock().map_err(|_| "朗读状态不可用")?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn reap(slot: &mut Option<Child>) {
    let done = match slot.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_)) | Err(_) => true,
            Ok(None) => false,
        },
        None => false,
    };
    if done {
        *slot = None;
    }
}

pub(crate) fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    let output = Command::new("/usr/bin/say")
        .arg("-v")
        .arg("?")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "无法读取系统声音")?;
    if !output.status.success() {
        return Err("无法读取系统声音".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let voices = parse_voice_list(&text);
    if voices.is_empty() {
        return Err("系统没有可用的朗读声音".into());
    }
    Ok(voices)
}

pub(crate) fn parse_voice_list(output: &str) -> Vec<VoiceInfo> {
    output.lines().filter_map(parse_voice_line).collect()
}

fn parse_voice_line(line: &str) -> Option<VoiceInfo> {
    let (left, sample) = line.split_once('#')?;
    let left = left.trim();
    let mut parts = left.rsplitn(2, char::is_whitespace);
    let locale = parts.next()?.trim();
    let name = parts.next()?.trim();
    if name.is_empty() || locale.is_empty() || name.starts_with('-') {
        return None;
    }
    Some(VoiceInfo {
        name: name.to_string(),
        locale: locale.to_string(),
        sample: sample.trim().to_string(),
    })
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
    fn speech_text_is_not_placed_on_the_command_line() {
        let bubble = "他说\"$HOME\" && rm\n第二行，原文保持";
        let plan = speech_plan(bubble, Some("Tingting"), Some(180.0)).unwrap();
        assert_eq!(plan.text, bubble);
        assert_eq!(
            plan.args,
            vec![
                "-v".to_string(),
                "Tingting".into(),
                "-r".into(),
                "180".into()
            ]
        );
        assert!(plan
            .args
            .iter()
            .all(|arg| !arg.contains(bubble) && !arg.contains("$HOME")));
        assert!(speech_plan(bubble, Some("-v"), None).is_err());
        assert!(speech_plan(bubble, Some("Bad;rm"), None).is_err());
        assert!(speech_plan("  ", None, None).is_err());
        assert!(speech_plan(bubble, None, Some(10.0)).is_err());
        assert!(speech_plan(bubble, None, Some(f64::NAN)).is_err());
    }

    #[test]
    fn voice_lines_parse_and_permission_labels_do_not_prompt() {
        let voices = parse_voice_list("Albert              en_US    # Hello! My name is Albert.\nAmélie              fr_CA    # Bonjour!\n");
        assert_eq!(voices[0].name, "Albert");
        assert_eq!(voices[0].locale, "en_US");
        assert_eq!(voices[1].name, "Amélie");
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

    #[test]
    fn say_file_receives_the_exact_stdin_text() {
        let plan = speech_plan("hello-exact", None, Some(180.0)).unwrap();
        let dir = std::env::temp_dir().join(format!("kbot-say-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.aiff");
        let mut child = Command::new("/usr/bin/say")
            .args(&plan.args)
            .arg("-o")
            .arg(&out)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("say");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(plan.text.as_bytes())
            .unwrap();
        let status = wait_say(&mut child);
        assert!(status, "say 没有接受标准输入里的原文");
        assert!(out.metadata().unwrap().len() > 32);
        assert!(!plan.args.iter().any(|arg| arg.contains("hello-exact")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn wait_say(child: &mut Child) -> bool {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if start.elapsed() > Duration::from_secs(8) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => return false,
        }
    }
}
