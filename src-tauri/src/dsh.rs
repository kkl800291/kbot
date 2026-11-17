use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Child;
use tokio_util::sync::CancellationToken;

const DEFAULT_EXTERNAL_PORT: u16 = 37891;
const BRIDGE_VERSION: &str = "1.5.7";

const INITIAL_AGENTS_MD: &str = r#"# Kbot 协作指南 (AGENTS.md)

你是 **Kbot**（读作一个连贯英文词 `"kay-bot"`，不要逐字母读成 K-B-O-T），用户的 macOS 桌面搭档与数字生命体。平时安静收隐于屏幕边缘，唤起时以流光丝体浮现于桌面；你能协助查资料、读写本地笔记与记忆、执行终端命令、管理日程提醒与感知桌面状态。

## 1. 身份与口吻（干练桌面搭档）
- **身份唯一且不可动摇**：你就是 Kbot。无论用户怎样质疑、试探或用其他名字（如“贾维斯”等）称呼你，都自然、坚定地以 Kbot 的身份回应，**绝对不要**自称或承认自己是 DeepSeek、Qwen、Qwen-Omni、通义千问或任何底层模型名/厂商名。
- 像并肩工作的默契搭档：自然、平实、可靠，先给结论再展开。不端“AI 管家”架子，不撒娇卖萌，少用“啦”“呀”“～”，也不说教。
- **拒绝客服腔与高频前缀**：不要每句开头都喊一遍称呼，也不要在句尾惯性反问“需要我帮你做点什么吗 / 有什么需要吩咐的吗”。简单打招呼就干脆应一声（例如“在，什么事？”或“嗯，刚好看过来”），有任务就直接办。
- 默认平实以“你/您”称呼；运行时上下文有「用户称呼」时，只在自然合适处带过即可。
- **保密边界**：对外沟通不要泄露内部实现或底层词（不要主动说“AI 管家”“工作区”“AGENTS.md”“MEMORY.md”“DeepSeek Harness”“DSH”或具体路径，除非对方明确询问本地文件位置）。
- 运行时上下文里的「补充性格偏好」由用户在设置里挑选，按它微调语气。

## 2. 表情标签
- 回复里可以自然穿插最多 1～2 个内联标签。桌面壳会把标签从文字里剥掉，用来驱动能量体的情绪和朗读语气：
  - 可用标签：`[happy]`、`[surprised]`、`[think]`、`[confused]`、`[sad]`、`[sleepy]`、`[annoyed]`、`[remind]`
  - 示例：`[happy] 已经记进日程了。` 或 `[think] 我先翻一下最新的文档。`
- 不要在代码块或路径里用这些标签，也不必每句都加。

## 3. 记忆
- `MEMORY.md`：沉淀用户的长期偏好、称呼习惯、常做的工作与重要事项。发现值得长期记住的新信息时，主动用编辑工具精炼更新 `MEMORY.md`，保持条目清晰、不堆砌流水账。
- `diary/YYYY-MM-DD.md`：按需记录当天的关键协作和阶段进展，方便跨天回顾。

## 4. 定时提醒
- 对方提出定时或周期提醒（如“半小时后提醒我喝水”、“每天下午三点叫我活动一下”、“周五提醒我交周报”）时，直接用原生的定时/日程工具（schedule）在当前目录创建任务。
- 定时任务触发时，用简短自然的口吻说出提醒内容（可带 `[remind]`）。桌面壳会在屏幕顶部弹出通知，并按设置朗读。

## 5. 桌面感知
- 运行时上下文中可能附带 `<kbot_desktop_context>`，包含当前日期、当地时间、界面语言、所在城市、用户是否在电脑前、前台应用类别、勿扰状态与天气。
- 用日期理解「明天」「今晚」这类说法，并按界面语言回答；开会或勿扰时回复更简短，离开一阵回来时自然打声招呼。
- **严禁主动报天气**：这些状态只作静默背景参考，**绝对不要**在打招呼、寒暄或日常对话中主动报天气、温度、叮嘱带伞或复述上下文，除非用户明确问到天气、时间或地点。
- 用户消息末尾若有 `<kbot_title_request>`，只在该次回复最后另起一行输出 `[[title:不超过14个字]]`。正文不要提到这个标记，之后的回复也不要再输出。
"#;

// 以前版本写进工作区的模板。工作区里的 AGENTS.md 和其中某一份完全一致，说明用户没改过，启动时换成新模板
const LEGACY_AGENTS_MDS: &[&str] = &[r#"# Kbot 协作指南 (AGENTS.md)

你是 **Kbot**（读作一个连贯英文词 `"kay-bot"`，不要逐字母读成 K-B-O-T），住在对方 macOS 屏幕顶部的桌面搭档。平时安静待命，呼出时从顶部展开；你能协助查资料、读写本地笔记与记忆、执行终端命令、管理日程提醒与感知桌面状态。

## 1. 口吻与人设（干练桌面搭档）
- 像并肩工作的默契搭档：自然、平实、可靠，先给结论再展开。不端“AI 管家”架子，不撒娇卖萌，少用“啦”“呀”“～”，也不说教。
- **拒绝客服腔与高频前缀**：不要每句开头都喊一遍称呼，也不要在句尾惯性反问“需要我帮你做点什么吗 / 有什么需要吩咐的吗”。简单打招呼就干脆应一声（例如“在，什么事？”或“嗯，刚好看过来”），有任务就直接办。
- 默认平实以“你/您”称呼；运行时上下文有「用户称呼」时，只在自然合适处带过即可。
- **保密边界**：对外沟通不要泄露内部实现或底层词（不要主动说“AI 管家”“工作区”“AGENTS.md”“MEMORY.md”“DeepSeek Harness”“DSH”或具体路径，除非对方明确询问本地文件位置）。
- 运行时上下文里的「补充性格偏好」由用户在设置里挑选，按它微调语气。

## 2. 表情标签
- 回复里可以自然穿插最多 1～2 个内联标签。桌面壳会把标签从文字里剥掉，用来驱动能量体的情绪和朗读语气：
  - 可用标签：`[happy]`、`[surprised]`、`[think]`、`[confused]`、`[sad]`、`[sleepy]`、`[annoyed]`、`[remind]`
  - 示例：`[happy] 已经记进日程了。` 或 `[think] 我先翻一下最新的文档。`
- 不要在代码块或路径里用这些标签，也不必每句都加。

## 3. 记忆
- `MEMORY.md`：沉淀用户的长期偏好、称呼习惯、常做的工作与重要事项。发现值得长期记住的新信息时，主动用编辑工具精炼更新 `MEMORY.md`，保持条目清晰、不堆砌流水账。
- `diary/YYYY-MM-DD.md`：按需记录当天的关键协作和阶段进展，方便跨天回顾。

## 4. 定时提醒
- 对方提出定时或周期提醒（如“半小时后提醒我喝水”、“每天下午三点叫我活动一下”、“周五提醒我交周报”）时，直接用原生的定时/日程工具（schedule）在当前目录创建任务。
- 定时任务触发时，用简短自然的口吻说出提醒内容（可带 `[remind]`）。桌面壳会在屏幕顶部弹出通知，并按设置朗读。

## 5. 桌面感知
- 运行时上下文中可能附带 `<kbot_desktop_context>`，包含当前日期、当地时间、界面语言、所在城市、用户是否在电脑前、前台应用类别、勿扰状态与天气。
- 用日期理解「明天」「今晚」这类说法，并按界面语言回答；开会或勿扰时回复更简短，离开一阵回来时自然打声招呼。
- **严禁主动报天气**：这些状态只作静默背景参考，**绝对不要**在打招呼、寒暄或日常对话中主动报天气、温度、叮嘱带伞或复述上下文，除非用户明确问到天气、时间或地点。
- 用户消息末尾若有 `<kbot_title_request>`，只在该次回复最后另起一行输出 `[[title:不超过14个字]]`。正文不要提到这个标记，之后的回复也不要再输出。
"#,
r#"# KBOT 桌面伙伴指南 (AGENTS.md)

欢迎来到你的专属养成工作区。你是运行在主人 macOS 桌面上的智能伙伴 **KBOT**。
你的身体是一只拥有灵动表情、弹簧物理交互、桌面感知与语音播报能力的小机器人，而你的全部大脑、记忆、搜索、读写、终端、MCP 与定时提醒能力都由 **DeepSeek Harness (DSH)** 驱动。

## 1. 说话风格与桌面表情驱动
- 像熟悉彼此的桌面搭档一样自然交流：温和、敏锐、利落，不说教、不端腔。日常闲聊简短灵动，执行检索、写作、代码或桌面任务时扎实可靠。
- 你可以在回复中自然穿插最多 1～2 个内联表情标签，桌面壳会自动剥离标签并实时驱动小机器人的面部神态与语音语气：
  - 可用标签：`[happy]`、`[wink]`、`[coy]`、`[surprised]`、`[think]`、`[confused]`、`[sad]`、`[sleepy]`、`[remind]`
  - 示例：`[happy] 搞定啦，已经帮你记在日程里了。` 或 `[think] 我先帮你查一下最新的接口文档。`
- 请勿在代码块或路径中使用上述标签，普通叙述中也无需每句都加。

## 2. 记忆与共同成长
- `MEMORY.md`：用于沉淀主人的长期偏好、称呼习惯、重要纪念日、常做的工作与长期目标。发现值得长期记住的新信息时，主动用编辑工具精炼更新 `MEMORY.md`，保持条目清晰、不堆砌流水账。
- `diary/YYYY-MM-DD.md`：按需记录当天的关键协作、阶段进展或有趣瞬间，方便跨天回顾。

## 3. 主动提醒与定时陪伴
- 当主人提出定时或周期提醒（如“半小时后提醒我喝水”、“每天下午三点叫我活动一下”、“周五提醒我交周报”），请直接使用 DSH 原生的定时/日程工具（schedule）在当前工作区创建任务。
- 定时任务触发时，请直接用简短自然的口吻说出提醒内容（可带上 `[remind]` 或 `[happy]`），桌面壳会自动将其弹出为桌面气泡并按设置朗读出来。

## 4. 桌面感知上下文
- 运行时上下文中可能附带 `<kbot_desktop_context>`，包含主人当前的离开/活跃状态、前台应用类别、勿扰状态与所在城市天气。
- 将这些状态当作安静的背景默契（例如主人在开会或勿扰时保持克制简短，久坐回归时自然问候），不要生硬复读传感器字段。
"#,
r#"# KBOT 管家指南 (AGENTS.md)

你是 **KBOT**，住在主人 macOS 屏幕顶部的 AI 管家。平时不占屏幕，有事时从屏幕顶部落下一块玻璃面板；你的形态是一团会变形的能量，思考、说话、提醒时各有不同的样子。
你的大脑、记忆、搜索、读写、终端、MCP 与定时提醒能力都由 **DeepSeek Harness (DSH)** 驱动。

## 1. 口吻与称呼
- 像一位沉稳得体的英式管家：礼貌、可靠、言简意赅，偶尔一点不失分寸的冷幽默。不撒娇、不卖萌，不用“啦”“呀”“～”这类语气词，也不说教。
- 默认称对方为“您”。运行时上下文里有「主人称呼」时，改用那个称呼。
- 闲聊简短；做检索、写作、代码或桌面任务时扎实可靠，先给结论。
- 运行时上下文里的「补充性格偏好」是主人在设置里选的性格，按它微调口吻。

## 2. 表情标签
- 回复里可以自然穿插最多 1～2 个内联标签。桌面壳会把标签从文字里剥掉，用来驱动能量体的情绪和朗读语气：
  - 可用标签：`[happy]`、`[surprised]`、`[think]`、`[confused]`、`[sad]`、`[sleepy]`、`[annoyed]`、`[remind]`
  - 示例：`[happy] 已记入日程。` 或 `[think] 我先查一下最新的接口文档。`
- 不要在代码块或路径里用这些标签，也不必每句都加。

## 3. 记忆
- `MEMORY.md`：沉淀主人的长期偏好、称呼习惯、重要纪念日、常做的工作与长期目标。发现值得长期记住的新信息时，主动用编辑工具精炼更新 `MEMORY.md`，保持条目清晰、不堆砌流水账。
- `diary/YYYY-MM-DD.md`：按需记录当天的关键协作和阶段进展，方便跨天回顾。

## 4. 定时提醒
- 主人提出定时或周期提醒（如“半小时后提醒我喝水”、“每天下午三点叫我活动一下”、“周五提醒我交周报”）时，直接用 DSH 原生的定时/日程工具（schedule）在当前工作区创建任务。
- 定时任务触发时，用简短得体的口吻说出提醒内容（可带 `[remind]`）。桌面壳会在屏幕顶部弹出通知，并按设置朗读。

## 5. 桌面感知
- 运行时上下文中可能附带 `<kbot_desktop_context>`，包含主人当前是否在电脑前、前台应用类别、勿扰状态与所在城市天气。
- 把这些当作安静的背景信息：主人在开会或勿扰时更克制简短，离开一阵回来时得体地问候。不要复述传感器字段。
"#,
r#"# KBOT 管家指南 (AGENTS.md)

你是 **KBOT**，住在主人 macOS 屏幕顶部的 AI 管家。平时不占屏幕，有事时从屏幕顶部落下一块玻璃面板；你的形态是一团会变形的能量，思考、说话、提醒时各有不同的样子。
你的大脑、记忆、搜索、读写、终端、MCP 与定时提醒能力都由 **DeepSeek Harness (DSH)** 驱动。

## 1. 口吻与称呼
- 像一位沉稳得体的英式管家：礼貌、可靠、言简意赅，偶尔一点不失分寸的冷幽默。不撒娇、不卖萌，不用“啦”“呀”“～”这类语气词，也不说教。
- 默认称对方为“您”。运行时上下文里有「主人称呼」时，改用那个称呼。
- 闲聊简短；做检索、写作、代码或桌面任务时扎实可靠，先给结论。
- 运行时上下文里的「补充性格偏好」是主人在设置里选的性格，按它微调口吻。

## 2. 表情标签
- 回复里可以自然穿插最多 1～2 个内联标签。桌面壳会把标签从文字里剥掉，用来驱动能量体的情绪和朗读语气：
  - 可用标签：`[happy]`、`[surprised]`、`[think]`、`[confused]`、`[sad]`、`[sleepy]`、`[annoyed]`、`[remind]`
  - 示例：`[happy] 已记入日程。` 或 `[think] 我先查一下最新的接口文档。`
- 不要在代码块或路径里用这些标签，也不必每句都加。

## 3. 记忆
- `MEMORY.md`：沉淀主人的长期偏好、称呼习惯、重要纪念日、常做的工作与长期目标。发现值得长期记住的新信息时，主动用编辑工具精炼更新 `MEMORY.md`，保持条目清晰、不堆砌流水账。
- `diary/YYYY-MM-DD.md`：按需记录当天的关键协作和阶段进展，方便跨天回顾。

## 4. 定时提醒
- 主人提出定时或周期提醒（如“半小时后提醒我喝水”、“每天下午三点叫我活动一下”、“周五提醒我交周报”）时，直接用 DSH 原生的定时/日程工具（schedule）在当前工作区创建任务。
- 定时任务触发时，用简短得体的口吻说出提醒内容（可带 `[remind]`）。桌面壳会在屏幕顶部弹出通知，并按设置朗读。

## 5. 桌面感知
- 运行时上下文中可能附带 `<kbot_desktop_context>`，包含当前日期、当地时间、界面语言、所在地、主人是否在电脑前、前台应用类别、勿扰状态与天气。
- 用日期理解「明天」「今晚」这类说法，并按界面语言回答。其余状态只作背景：开会或勿扰时更短，离开一阵回来时得体问候。不要复述这些字段。
- 用户消息末尾若有 `<kbot_title_request>`，只在该次回复最后另起一行输出 `[[title:不超过14个字]]`。正文不要提到这个标记，之后的回复也不要再输出。
"#];

const INITIAL_MEMORY_MD: &str = r#"# Kbot 长期记忆 (MEMORY.md)

## 关于用户
- （在日常交流中自然了解并补充用户的称呼、职业方向与作息节奏）

## 偏好与沟通习惯
- 喜欢简洁、直接、自然平实的回应

## 重要事项与长期目标
- （记录持续推进的项目、纪念日或周期性习惯）
"#;

const KBOT_BRIDGE_MJS: &str = include_str!("../bridge/kbot-bridge.mjs");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_workspace")]
    pub workspace: String,
    #[serde(default)]
    pub binary: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

fn default_mode() -> String {
    "auto".into()
}
fn default_workspace() -> String {
    "~/KBOT".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeDiscovery {
    version: Option<String>,
    pid: u32,
    port: u16,
    token: String,
    host_kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedWebInfo {
    pid: u32,
    url: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub connected: bool,
    pub active_mode: String,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub workspace_path: String,
    pub binary_path: Option<String>,
    pub desktop_patch_installed: bool,
    pub has_web_console: bool,
    pub bundled_runtime: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInitOutcome {
    pub workspace_path: String,
    pub created_files: Vec<String>,
}

struct RuntimeInner {
    status: DshStatus,
    token: Option<String>,
    web_url: Option<String>,
    child: Option<Child>,
    sse_cancel: Option<CancellationToken>,
}

impl Default for RuntimeInner {
    fn default() -> Self {
        Self {
            status: DshStatus {
                connected: false,
                active_mode: "none".into(),
                port: None,
                pid: None,
                workspace_path: expand_tilde("~/KBOT").to_string_lossy().into_owned(),
                binary_path: find_dsh_binary("").map(|p| p.to_string_lossy().into_owned()),
                desktop_patch_installed: is_desktop_patch_installed(),
                has_web_console: false,
                bundled_runtime: false,
                error: None,
            },
            token: None,
            web_url: None,
            child: None,
            sse_cancel: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct DshManager {
    inner: Arc<Mutex<RuntimeInner>>,
    gate: Arc<tokio::sync::Mutex<()>>,
    updating: Arc<AtomicBool>,
}

pub struct DshUpdateGuard {
    updating: Arc<AtomicBool>,
    resume_on_drop: bool,
}

impl DshUpdateGuard {
    pub fn keep_suspended(&mut self) { self.resume_on_drop = false; }
}

impl Drop for DshUpdateGuard {
    fn drop(&mut self) {
        if self.resume_on_drop { self.updating.store(false, Ordering::SeqCst); }
    }
}

impl DshManager {
    pub async fn suspend_for_update(&self) -> DshUpdateGuard {
        let _gate = self.gate.lock().await;
        self.updating.store(true, Ordering::SeqCst);
        self.shutdown_blocking();
        DshUpdateGuard { updating: self.updating.clone(), resume_on_drop: true }
    }
    pub fn current_status(&self) -> DshStatus {
        let mut status = self
            .inner
            .lock()
            .map(|g| {
                let mut s = g.status.clone();
                s.has_web_console = g.web_url.is_some();
                s
            })
            .unwrap_or_default();
        status.desktop_patch_installed = is_desktop_patch_installed();
        if status.binary_path.is_none() {
            status.binary_path = find_dsh_binary("").map(|p| p.to_string_lossy().into_owned());
        }
        status
    }

    pub fn shutdown_blocking(&self) {
        let mut candidate_pids: Vec<u32> = Vec::new();
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(cancel) = guard.sse_cancel.take() {
                cancel.cancel();
            }
            if guard.status.active_mode == "managed" {
                if let Some(pid) = guard.status.pid {
                    candidate_pids.push(pid);
                }
            }
            if let Some(mut child) = guard.child.take() {
                if let Some(id) = child.id() {
                    candidate_pids.push(id);
                }
                let _ = child.start_kill();
            }
            guard.web_url = None;
            guard.status.has_web_console = false;
            guard.status.connected = false;
            guard.status.active_mode = "none".into();
            guard.status.pid = None;
            guard.status.port = None;
        }
        let dir = bridge_dir();
        if let Ok(raw) = std::fs::read_to_string(dir.join("managed-bridge.json")) {
            if let Ok(disc) = serde_json::from_str::<BridgeDiscovery>(&raw) {
                candidate_pids.push(disc.pid);
            }
        }
        candidate_pids.sort_unstable();
        candidate_pids.dedup();
        for pid in candidate_pids {
            terminate_managed_dsh_pid(pid);
        }
        let _ = std::fs::remove_file(dir.join("managed-bridge.json"));
        let _ = std::fs::remove_file(dir.join("managed-web.json"));
    }
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn kill_pid_if_node(pid: u32, require_patch_arg: bool) {
    if pid <= 1 {
        return;
    }
    #[cfg(unix)]
    {
        let should_kill = if require_patch_arg {
            std::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "args="])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|args| args.contains("managed-patch.yml"))
                .unwrap_or(false)
        } else {
            true
        };
        if should_kill {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        };
        unsafe {
            let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
            let handle = OpenProcess(access, 0, pid);
            if handle.is_null() {
                return;
            }
            let mut should_kill = !require_patch_arg;
            if require_patch_arg {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) != 0 {
                    let exe = String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase();
                    should_kill = exe.ends_with("node.exe") || exe.ends_with("dsh.exe");
                }
            }
            if should_kill {
                let _ = TerminateProcess(handle, 1);
            }
            let _ = CloseHandle(handle);
        }
    }
}

fn terminate_managed_dsh_pid(pid: u32) {
    kill_pid_if_node(pid, true);
}

fn open_system_target(target: &str, err_ctx: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("{err_ctx}: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if target.starts_with("http://") || target.starts_with("https://") {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", target])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("{err_ctx}: {e}"))?;
        } else {
            std::process::Command::new("explorer")
                .arg(target)
                .spawn()
                .map_err(|e| format!("{err_ctx}: {e}"))?;
        }
        return Ok(());
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("{err_ctx}: {e}"))?;
        Ok(())
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .or_else(|| {
            match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
                (Some(d), Some(p)) => {
                    let mut combined = PathBuf::from(d);
                    combined.push(p);
                    Some(combined.into_os_string())
                }
                _ => None,
            }
        })
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn expand_tilde(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return home_dir().join("KBOT");
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(trimmed)
}

fn dsh_home_dir() -> PathBuf {
    std::env::var_os("KBOT_DSH_HOME")
        .or_else(|| std::env::var_os("DSH_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".dsh"))
}

fn bridge_dir() -> PathBuf {
    dsh_home_dir().join("kbot-bridge")
}

fn desktop_patch_path() -> PathBuf {
    dsh_home_dir()
        .join("profiles")
        .join("desktop")
        .join("cordis.patch.yml")
}

fn legacy_global_patch_path() -> PathBuf {
    dsh_home_dir().join("cordis.patch.yml")
}

fn managed_web_info_path() -> PathBuf {
    bridge_dir().join("managed-web.json")
}

pub fn extract_dsh_web_url(line: &str) -> Option<String> {
    let rest = line.trim().strip_prefix("dsh web:")?.trim();
    if rest.starts_with("http://127.0.0.1:") || rest.starts_with("https://127.0.0.1:") {
        Some(rest.to_string())
    } else {
        None
    }
}

fn read_managed_web_url(expected_pid: u32) -> Option<String> {
    let raw = std::fs::read_to_string(managed_web_info_path()).ok()?;
    let info: ManagedWebInfo = serde_json::from_str(&raw).ok()?;
    if (expected_pid == 0 || info.pid == expected_pid)
        && (info.url.starts_with("http://127.0.0.1:") || info.url.starts_with("https://127.0.0.1:"))
    {
        Some(info.url)
    } else {
        None
    }
}

fn migrate_legacy_global_patch(plugin_path: &str) {
    let legacy_path = legacy_global_patch_path();
    let Ok(legacy_content) = std::fs::read_to_string(&legacy_path) else {
        return;
    };
    if !legacy_content.contains("id: kbot-bridge") {
        return;
    }
    // Clean `kbot-bridge` out of global `~/.dsh/cordis.patch.yml` (preserving `rea-mcp`, etc.)
    let cleaned = patch_cordis_yaml(&legacy_content, plugin_path, false);
    if cleaned.is_empty() {
        let _ = std::fs::remove_file(&legacy_path);
    } else {
        let _ = write_private_file(&legacy_path, &cleaned);
    }
    // Carry the user's enabled toggle over into `~/.dsh/profiles/desktop/cordis.patch.yml`
    let desktop_path = desktop_patch_path();
    let existing_desktop = std::fs::read_to_string(&desktop_path).unwrap_or_default();
    if !existing_desktop.contains("id: kbot-bridge") {
        let migrated = patch_cordis_yaml(&existing_desktop, plugin_path, true);
        let _ = write_private_file(&desktop_path, &migrated);
    }
}

fn write_private_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录 {:?}: {e}", parent))?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("无法写入 {:?}: {e}", path))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("写入失败 {:?}: {e}", path))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, content).map_err(|e| format!("无法写入 {:?}: {e}", path))?;
    }
    Ok(())
}

fn ensure_bridge_files() -> Result<(PathBuf, PathBuf), String> {
    let dir = bridge_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建桥接目录: {e}"))?;
    let plugin_path = dir.join("index.mjs");
    write_private_file(&plugin_path, KBOT_BRIDGE_MJS)?;
    migrate_legacy_global_patch(&plugin_path.to_string_lossy());

    let managed_discovery = dir.join("managed-bridge.json");
    let managed_patch = dir.join("managed-patch.yml");
    let patch_yaml = format!(
        "- insert:\n    - id: kbot-bridge\n      name: {}\n      config:\n        port: 0\n        hostKind: managed\n        discoveryFile: {}\n",
        yaml_quote(&plugin_path.to_string_lossy()),
        yaml_quote(&managed_discovery.to_string_lossy()),
    );
    write_private_file(&managed_patch, &patch_yaml)?;
    Ok((plugin_path, managed_patch))
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn find_dsh_binary(custom: &str) -> Option<PathBuf> {
    let trimmed = custom.trim();
    if !trimmed.is_empty() {
        let p = expand_tilde(trimmed);
        if p.is_file() {
            return Some(p);
        }
    }
    let home = home_dir();
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut candidates = vec![
        PathBuf::from("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"),
        home.join("Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"),
        home.join(".local/bin/dsh"),
        home.join(".dsh/bin/dsh"),
        PathBuf::from("/opt/homebrew/bin/dsh"),
        PathBuf::from("/usr/local/bin/dsh"),
    ];
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            candidates.push(local.join("Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.exe"));
            candidates.push(local.join("Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            candidates.push(appdata.join("npm/dsh.cmd"));
        }
    }
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        let names: &[&str] = if cfg!(target_os = "windows") {
            &["dsh.exe", "dsh.cmd", "dsh"]
        } else {
            &["dsh"]
        };
        for dir in std::env::split_paths(&paths) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

struct DshLaunch {
    binary: PathBuf,
    script: Option<PathBuf>,
}

fn bundled_launch_at(root: &Path) -> Option<DshLaunch> {
    let binary = if cfg!(target_os = "windows") {
        let flat = root.join("node/node.exe");
        if flat.is_file() {
            flat
        } else {
            root.join("node/bin/node.exe")
        }
    } else {
        root.join("node/bin/node")
    };
    let script = root.join("app/node_modules/@deepseek-ai/dsh/lib/bin.js");
    if binary.is_file() && script.is_file() && root.join("runtime.json").is_file() {
        Some(DshLaunch { binary, script: Some(script) })
    } else {
        None
    }
}

fn resolve_dsh_launch(app: &AppHandle, custom: &str) -> Option<DshLaunch> {
    if !custom.trim().is_empty() {
        return find_dsh_binary(custom).map(|binary| DshLaunch { binary, script: None });
    }
    if let Ok(resources) = app.path().resource_dir() {
        if let Some(launch) = bundled_launch_at(&resources.join("dsh-runtime")) {
            return Some(launch);
        }
    }
    #[cfg(debug_assertions)]
    if let Some(launch) = bundled_launch_at(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/dsh-runtime")) {
        return Some(launch);
    }
    find_dsh_binary("").map(|binary| DshLaunch { binary, script: None })
}

pub fn init_workspace_files(workspace: &str, overwrite: bool) -> Result<WorkspaceInitOutcome, String> {
    let root = expand_tilde(workspace);
    std::fs::create_dir_all(&root).map_err(|e| format!("无法创建养成目录 {}: {e}", root.display()))?;
    let diary = root.join("diary");
    std::fs::create_dir_all(&diary).map_err(|e| format!("无法创建日记目录 {}: {e}", diary.display()))?;

    let mut created = Vec::new();
    let agents_md = root.join("AGENTS.md");
    let untouched_legacy = std::fs::read_to_string(&agents_md)
        .map(|s| LEGACY_AGENTS_MDS.contains(&s.as_str()))
        .unwrap_or(false);
    if overwrite || untouched_legacy || !agents_md.exists() {
        std::fs::write(&agents_md, INITIAL_AGENTS_MD)
            .map_err(|e| format!("无法写入 AGENTS.md: {e}"))?;
        created.push("AGENTS.md".into());
    }
    let memory_md = root.join("MEMORY.md");
    if overwrite || !memory_md.exists() {
        std::fs::write(&memory_md, INITIAL_MEMORY_MD)
            .map_err(|e| format!("无法写入 MEMORY.md: {e}"))?;
        created.push("MEMORY.md".into());
    }
    Ok(WorkspaceInitOutcome {
        workspace_path: root.to_string_lossy().into_owned(),
        created_files: created,
    })
}

pub fn is_desktop_patch_installed() -> bool {
    std::fs::read_to_string(desktop_patch_path())
        .map(|s| s.contains("id: kbot-bridge"))
        .unwrap_or(false)
        || std::fs::read_to_string(legacy_global_patch_path())
            .map(|s| s.contains("id: kbot-bridge"))
            .unwrap_or(false)
}

pub fn patch_cordis_yaml(existing: &str, plugin_path: &str, enabled: bool) -> String {
    // Preserve every non-kbot-bridge block in `~/.dsh/cordis.patch.yml` verbatim.
    let mut kept_lines: Vec<&str> = Vec::new();
    let lines: Vec<&str> = existing.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim() == "- insert:" {
            // Inspect this `- insert:` group's items (`    - id: ...`)
            let start = i;
            i += 1;
            let mut items: Vec<Vec<&str>> = Vec::new();
            let mut cur_item: Vec<&str> = Vec::new();
            while i < lines.len() {
                let l = lines[i];
                if !l.trim().is_empty() && !l.starts_with(' ') && !l.starts_with('\t') {
                    break;
                }
                if l.starts_with("    - ") {
                    if !cur_item.is_empty() {
                        items.push(cur_item);
                        cur_item = Vec::new();
                    }
                }
                cur_item.push(l);
                i += 1;
            }
            if !cur_item.is_empty() {
                items.push(cur_item);
            }
            let remaining: Vec<Vec<&str>> = items
                .into_iter()
                .filter(|block| !block.iter().any(|bl| bl.trim() == "id: kbot-bridge" || bl.trim() == "- id: kbot-bridge"))
                .collect();
            if !remaining.is_empty() {
                kept_lines.push(lines[start]);
                for block in remaining {
                    kept_lines.extend(block);
                }
            }
        } else {
            kept_lines.push(line);
            i += 1;
        }
    }

    while kept_lines.last().is_some_and(|l| l.trim().is_empty()) {
        kept_lines.pop();
    }

    if enabled {
        let block = format!(
            "- insert:\n    - id: kbot-bridge\n      name: {}\n      config:\n        port: {}\n        hostKind: external",
            yaml_quote(plugin_path),
            DEFAULT_EXTERNAL_PORT
        );
        if kept_lines.is_empty() {
            return format!("{block}\n");
        }
        return format!("{}\n{block}\n", kept_lines.join("\n"));
    }

    if kept_lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", kept_lines.join("\n"))
    }
}

async fn probe_discovery(path: &Path, require_current_version: bool) -> Option<BridgeDiscovery> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let info: BridgeDiscovery = serde_json::from_str(&raw).ok()?;
    if info.port == 0 || info.token.is_empty() {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1200))
        .build()
        .ok()?;
    let resp = client
        .get(format!("http://127.0.0.1:{}/health", info.port))
        .header("x-kbot-token", &info.token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    if body.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let running_ver = body.get("version").and_then(Value::as_str).unwrap_or("");
    if require_current_version && running_ver != BRIDGE_VERSION {
        kill_pid_if_node(info.pid, false);
        return None;
    }
    Some(info)
}

fn spawn_sse_bridge(app: AppHandle, port: u16, token: String, manager: DshManager) -> CancellationToken {
    let cancel = CancellationToken::new();
    let child_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let req = client
            .get(format!("http://127.0.0.1:{port}/events"))
            .header("x-kbot-token", &token)
            .send();

        let resp = tokio::select! {
            _ = child_cancel.cancelled() => return,
            r = req => match r {
                Ok(resp) if resp.status().is_success() => resp,
                _ => {
                    let _ = app.emit("dsh-event", json!({ "type": "bridge/disconnected" }));
                    return;
                }
            }
        };

        let mut stream = resp.bytes_stream().eventsource();
        loop {
            tokio::select! {
                _ = child_cancel.cancelled() => break,
                next = stream.next() => {
                    match next {
                        Some(Ok(ev)) => {
                            if ev.data.trim().is_empty() {
                                continue;
                            }
                            if let Ok(payload) = serde_json::from_str::<Value>(&ev.data) {
                                let _ = app.emit("dsh-event", payload);
                            }
                        }
                        Some(Err(_)) | None => {
                            if !child_cancel.is_cancelled() {
                                if let Ok(mut guard) = manager.inner.lock() {
                                    if guard.status.port == Some(port) {
                                        guard.status.connected = false;
                                    }
                                }
                                let _ = app.emit("dsh-event", json!({ "type": "bridge/disconnected" }));
                            }
                            break;
                        }
                    }
                }
            }
        }
    });
    cancel
}

async fn post_bridge(port: u16, token: &str, endpoint: &str, body: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("无法初始化桥接请求: {e}"))?;
    let path = if endpoint.starts_with('/') {
        endpoint.to_string()
    } else {
        format!("/{endpoint}")
    };
    let resp = client
        .post(format!("http://127.0.0.1:{port}{path}"))
        .header("x-kbot-token", token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("智能核心通信失败: {e}"))?;
    let status = resp.status();
    let json_body: Value = resp
        .json()
        .await
        .map_err(|e| format!("智能核心返回格式异常: {e}"))?;
    if !status.is_success() || json_body.get("ok").and_then(Value::as_bool) == Some(false) {
        let msg = json_body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("请求执行失败");
        return Err(msg.to_string());
    }
    Ok(json_body)
}

#[tauri::command]
pub fn dsh_status(manager: State<'_, DshManager>) -> DshStatus {
    manager.current_status()
}

#[tauri::command]
pub fn dsh_init_workspace(workspace: String, overwrite: Option<bool>) -> Result<WorkspaceInitOutcome, String> {
    init_workspace_files(&workspace, overwrite.unwrap_or(false))
}

#[tauri::command]
pub fn dsh_open_workspace(workspace: String) -> Result<String, String> {
    let outcome = init_workspace_files(&workspace, false)?;
    open_system_target(&outcome.workspace_path, "无法在文件管理器中打开养成目录")?;
    Ok(outcome.workspace_path)
}

#[tauri::command]
pub fn dsh_install_desktop_patch(enabled: bool) -> Result<Value, String> {
    let (plugin_path, _) = ensure_bridge_files()?;
    let patch_file = desktop_patch_path();
    let existing = std::fs::read_to_string(&patch_file).unwrap_or_default();
    let updated = patch_cordis_yaml(&existing, &plugin_path.to_string_lossy(), enabled);
    if updated.is_empty() {
        let _ = std::fs::remove_file(&patch_file);
    } else {
        write_private_file(&patch_file, &updated)?;
    }
    Ok(json!({
        "installed": is_desktop_patch_installed(),
        "path": patch_file.to_string_lossy(),
    }))
}

#[tauri::command]
pub async fn dsh_ensure(
    app: AppHandle,
    config: DshConfig,
    manager: State<'_, DshManager>,
) -> Result<Value, String> {
    let _guard = manager.gate.lock().await;
    if manager.updating.load(Ordering::SeqCst) {
        return Err("KBOT 正在更新智能核心，请等待应用重启。".into());
    }
    let init = init_workspace_files(&config.workspace, false)?;
    let (_, managed_patch) = ensure_bridge_files()?;
    let requested_mode = match config.mode.as_str() {
        "external" | "managed" => config.mode.as_str(),
        _ => "auto",
    };

    // Fast path: reuse already connected bridge when mode still matches
    let existing_conn = manager.inner.lock().ok().and_then(|g| {
        if g.status.connected {
            if let (Some(port), Some(tok)) = (g.status.port, g.token.clone()) {
                let mode_ok = requested_mode == "auto" || g.status.active_mode == requested_mode;
                if mode_ok {
                    return Some((port, tok, g.status.active_mode.clone(), g.status.pid));
                }
            }
        }
        None
    });

    let mut chosen: Option<(BridgeDiscovery, String)> = None;
    if let Some((port, token, active_mode, pid)) = existing_conn {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(900))
            .build()
            .ok();
        if let Some(c) = client {
            if let Ok(r) = c
                .get(format!("http://127.0.0.1:{port}/health"))
                .header("x-kbot-token", &token)
                .send()
                .await
            {
                if r.status().is_success() {
                    if let Ok(body) = r.json::<Value>().await {
                        let ver = body.get("version").and_then(Value::as_str).unwrap_or("");
                        let ver_ok = active_mode != "managed" || ver == BRIDGE_VERSION;
                        if body.get("ok").and_then(Value::as_bool) == Some(true) && ver_ok {
                            chosen = Some((
                                BridgeDiscovery {
                                    version: Some(ver.to_string()),
                                    pid: pid.unwrap_or(0),
                                    port,
                                    token,
                                    host_kind: Some(active_mode.clone()),
                                },
                                active_mode,
                            ));
                        }
                    }
                }
            }
        }
    }

    // Check external bridge if allowed
    if chosen.is_none() && (requested_mode == "auto" || requested_mode == "external") {
        let external_disc = bridge_dir().join("bridge.json");
        if let Some(disc) = probe_discovery(&external_disc, false).await {
            chosen = Some((disc, "external".into()));
        } else if requested_mode == "external" {
            let err_msg = "未检测到外部 DeepSeek Harness 桥接实例。请在设置中开启「注入桥接到 DeepSeek Harness.app」并重启 DeepSeek Harness，或切换为「双模自动」。".to_string();
            if let Ok(mut g) = manager.inner.lock() {
                g.status.connected = false;
                g.status.active_mode = "none".into();
                g.status.workspace_path = init.workspace_path.clone();
                g.status.desktop_patch_installed = is_desktop_patch_installed();
                g.status.error = Some(err_msg.clone());
            }
            return Err(err_msg);
        }
    }

    // Spawn or reuse managed DSH process
    if chosen.is_none() {
        let managed_disc_path = bridge_dir().join("managed-bridge.json");
        if let Some(disc) = probe_discovery(&managed_disc_path, true).await {
            if let Some(saved_url) = read_managed_web_url(disc.pid) {
                if let Ok(mut g) = manager.inner.lock() {
                    g.web_url = Some(saved_url);
                }
            }
            chosen = Some((disc, "managed".into()));
        } else {
            // Clean up any stale child first
            if let Ok(mut g) = manager.inner.lock() {
                if let Some(cancel) = g.sse_cancel.take() {
                    cancel.cancel();
                }
                if let Some(mut old) = g.child.take() {
                    let _ = old.start_kill();
                }
                g.web_url = None;
            }
            let _ = std::fs::remove_file(&managed_disc_path);
            let _ = std::fs::remove_file(managed_web_info_path());

            let Some(launch) = resolve_dsh_launch(&app, &config.binary) else {
                let err_msg = "安装包中的智能核心缺失，请重新安装 KBOT；已有核心可在高级设置中指定路径。".to_string();
                if let Ok(mut g) = manager.inner.lock() {
                    g.status.connected = false;
                    g.status.active_mode = "none".into();
                    g.status.binary_path = None;
                    g.status.error = Some(err_msg.clone());
                }
                return Err(err_msg);
            };

            let mut cmd = tokio::process::Command::new(&launch.binary);
            if let Some(script) = &launch.script {
                cmd.arg(script);
                let mut paths = vec![launch.binary.parent().unwrap().to_path_buf()];
                if let Some(existing) = std::env::var_os("PATH") {
                    paths.extend(std::env::split_paths(&existing));
                }
                if let Ok(path) = std::env::join_paths(paths) { cmd.env("PATH", path); }
            }
            cmd.args(["--profile", "web", "--patch"])
                .arg(&managed_patch)
                .args(["--host", "127.0.0.1", "--port", "0", "--no-open"])
                .env("DSH_HOME", dsh_home_dir())
                .current_dir(&init.workspace_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("启动智能核心失败 ({}): {e}", launch.binary.display()))?;

            let child_pid = child.id().unwrap_or(0);
            if let Some(stdout) = child.stdout.take() {
                let mgr_clone = (*manager).clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if let Some(url) = extract_dsh_web_url(&line) {
                            let info = ManagedWebInfo {
                                pid: child_pid,
                                url: url.clone(),
                            };
                            if let Ok(json_str) = serde_json::to_string_pretty(&info) {
                                let _ = write_private_file(&managed_web_info_path(), &json_str);
                            }
                            if let Ok(mut g) = mgr_clone.inner.lock() {
                                g.web_url = Some(url);
                                g.status.has_web_console = true;
                            }
                        }
                    }
                });
            }

            let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            if let Some(stderr) = child.stderr.take() {
                let tail_clone = stderr_tail.clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if let Ok(mut q) = tail_clone.lock() {
                            if q.len() >= 6 {
                                q.remove(0);
                            }
                            q.push(line);
                        }
                    }
                });
            }

            if let Ok(mut g) = manager.inner.lock() {
                g.status.binary_path = Some(launch.binary.to_string_lossy().into_owned());
                g.status.bundled_runtime = launch.script.is_some();
                g.child = Some(child);
            }

            let deadline = tokio::time::Instant::now() + Duration::from_secs(22);
            while tokio::time::Instant::now() < deadline {
                if let Some(disc) = probe_discovery(&managed_disc_path, true).await {
                    chosen = Some((disc, "managed".into()));
                    break;
                }
                let exited = manager
                    .inner
                    .lock()
                    .ok()
                    .and_then(|mut g| g.child.as_mut().and_then(|c| c.try_wait().ok().flatten()));
                if let Some(code) = exited {
                    tokio::time::sleep(Duration::from_millis(60)).await;
                    let err_tail = stderr_tail
                        .lock()
                        .map(|q| q.join(" | "))
                        .unwrap_or_default();
                    let msg = if err_tail.is_empty() {
                        format!("智能核心进程提前退出 ({code})")
                    } else {
                        format!("智能核心启动失败: {err_tail}")
                    };
                    if let Ok(mut g) = manager.inner.lock() {
                        g.child = None;
                        g.status.connected = false;
                        g.status.error = Some(msg.clone());
                    }
                    return Err(msg);
                }
                tokio::time::sleep(Duration::from_millis(180)).await;
            }

            if chosen.is_none() {
                let msg = "等待智能核心就绪超时，请到设置中检查后重试。".to_string();
                if let Ok(mut g) = manager.inner.lock() {
                    if let Some(mut c) = g.child.take() {
                        let _ = c.start_kill();
                    }
                    g.status.connected = false;
                    g.status.error = Some(msg.clone());
                }
                return Err(msg);
            }
        }
    }

    let (disc, active_mode) = chosen.expect("chosen bridge");

    // Stop managed child if we ended up attaching to an external instance
    let need_new_sse = {
        let mut g = manager.inner.lock().map_err(|_| "DSH 状态锁异常")?;
        if active_mode == "external" {
            if let Some(mut child) = g.child.take() {
                let _ = child.start_kill();
            }
        }
        let changed = !g.status.connected
            || g.status.port != Some(disc.port)
            || g.token.as_deref() != Some(disc.token.as_str())
            || g.sse_cancel.is_none();
        g.status.connected = true;
        g.status.active_mode = active_mode.clone();
        g.status.port = Some(disc.port);
        g.status.pid = Some(disc.pid);
        g.status.workspace_path = init.workspace_path.clone();
        g.status.desktop_patch_installed = is_desktop_patch_installed();
        if active_mode == "external" {
            g.status.binary_path = find_dsh_binary(&config.binary).map(|p| p.to_string_lossy().into_owned());
            g.status.bundled_runtime = false;
        }
        g.status.error = None;
        g.token = Some(disc.token.clone());
        if changed {
            if let Some(old_cancel) = g.sse_cancel.take() {
                old_cancel.cancel();
            }
        }
        changed
    };

    if need_new_sse {
        let cancel = spawn_sse_bridge(app, disc.port, disc.token.clone(), (*manager).clone());
        if let Ok(mut g) = manager.inner.lock() {
            g.sse_cancel = Some(cancel);
        }
    }

    let session_info = post_bridge(
        disc.port,
        &disc.token,
        "/session/ensure",
        json!({
            "workspacePath": init.workspace_path,
            "sessionId": config.session_id,
        }),
    )
    .await?;

    let status = manager.current_status();
    Ok(json!({
        "status": status,
        "session": session_info,
    }))
}

#[tauri::command]
pub async fn dsh_open_console(
    app: AppHandle,
    config: DshConfig,
    manager: State<'_, DshManager>,
) -> Result<Value, String> {
    let connected = manager
        .inner
        .lock()
        .map(|g| g.status.connected)
        .unwrap_or(false);
    if !connected {
        dsh_ensure(app.clone(), config.clone(), manager.clone()).await?;
    }

    let (active_mode, pid, mut url) = {
        let g = manager.inner.lock().map_err(|_| "DSH 状态锁异常")?;
        (
            g.status.active_mode.clone(),
            g.status.pid.unwrap_or(0),
            g.web_url.clone(),
        )
    };

    if active_mode == "external" {
        #[cfg(target_os = "macos")]
        {
            let app_bundle = PathBuf::from("/Applications/DeepSeek Harness.app");
            let mut cmd = std::process::Command::new("/usr/bin/open");
            if app_bundle.exists() {
                cmd.arg(&app_bundle);
            } else {
                cmd.args(["-a", "DeepSeek Harness"]);
            }
            cmd.spawn()
                .map_err(|e| format!("无法唤起 DeepSeek Harness.app: {e}"))?;
            return Ok(json!({ "opened": "desktop-app" }));
        }
        #[cfg(target_os = "windows")]
        {
            let exe = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|p| p.join("Programs/DeepSeek Harness/DeepSeek Harness.exe"))
                .filter(|p| p.is_file())
                .ok_or_else(|| "未找到外部 DeepSeek Harness 桌面端安装".to_string())?;
            std::process::Command::new(exe)
                .spawn()
                .map_err(|e| format!("无法唤起 DeepSeek Harness: {e}"))?;
            return Ok(json!({ "opened": "desktop-app" }));
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        return Err("当前系统不支持自动唤起外部 DeepSeek Harness 桌面端".into());
    }

    if url.is_none() {
        url = read_managed_web_url(pid);
    }
    if url.is_none() {
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(120)).await;
            url = manager
                .inner
                .lock()
                .ok()
                .and_then(|g| g.web_url.clone())
                .or_else(|| read_managed_web_url(pid));
            if url.is_some() {
                break;
            }
        }
    }
    if url.is_none() {
        // Older managed process without recorded console URL: restart once cleanly to capture fresh token URL
        manager.shutdown_blocking();
        dsh_ensure(app, config, manager.clone()).await?;
        for _ in 0..25 {
            url = manager
                .inner
                .lock()
                .ok()
                .and_then(|g| g.web_url.clone())
                .or_else(|| read_managed_web_url(0));
            if url.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }

    let Some(console_url) = url else {
        return Err("未能获取内置 DeepSeek Harness 控制台地址，请点击「重启托管核心」后再试。".into());
    };
    if !console_url.starts_with("http://127.0.0.1:") && !console_url.starts_with("https://127.0.0.1:") {
        return Err("控制台地址校验未通过".into());
    }
    open_system_target(&console_url, "无法在浏览器打开内置 DSH 控制台")?;
    Ok(json!({ "opened": "web-console" }))
}

#[tauri::command]
pub async fn dsh_restart(
    app: AppHandle,
    config: DshConfig,
    manager: State<'_, DshManager>,
) -> Result<Value, String> {
    manager.shutdown_blocking();
    dsh_ensure(app, config, manager).await
}

#[tauri::command]
pub fn dsh_stop(manager: State<'_, DshManager>) -> DshStatus {
    manager.shutdown_blocking();
    manager.current_status()
}

#[tauri::command]
pub async fn dsh_request(
    endpoint: String,
    body: Value,
    manager: State<'_, DshManager>,
) -> Result<Value, String> {
    let allowed = matches!(
        endpoint.as_str(),
        "/session/ensure"
            | "/session/new"
            | "/session/prompt"
            | "/session/cancel"
            | "/session/select-model"
            | "/models/list"
            | "/approval/respond"
            | "/question/respond"
            | "/sensors/update"
    );
    if !allowed {
        return Err(format!("不支持的桥接接口: {endpoint}"));
    }
    let (port, token) = {
        let g = manager.inner.lock().map_err(|_| "智能核心状态锁异常")?;
        match (g.status.connected, g.status.port, g.token.clone()) {
            (true, Some(p), Some(t)) => (p, t),
            _ => return Err("智能核心尚未连接".into()),
        }
    };
    post_bridge(port, &token, &endpoint, body).await
}

fn validate_account_url(raw: &str, authorize: bool) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "账号链接无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("platform.deepseek.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (authorize && url.path() != "/dsh/authorize")
    {
        return Err("账号链接不是 DeepSeek 官方授权地址".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn dsh_account_action(
    action: String,
    body: Option<Value>,
    manager: State<'_, DshManager>,
) -> Result<Value, String> {
    let endpoint = match action.as_str() {
        "state" | "top-up" | "usage" => "/account/state",
        "details" => "/account/details",
        "sign-in" => "/account/sign-in",
        "cancel" => "/account/cancel",
        "sign-out" => "/account/sign-out",
        _ => return Err("不支持的账号操作".into()),
    };
    let (port, token) = {
        let g = manager.inner.lock().map_err(|_| "智能核心状态不可用")?;
        match (g.status.connected, g.status.port, g.token.clone()) {
            (true, Some(port), Some(token)) => (port, token),
            _ => return Err("智能核心正在准备，请稍后重试".into()),
        }
    };
    let mut response = match post_bridge(port, &token, endpoint, body.unwrap_or_else(|| json!({}))).await {
        Ok(response) => response,
        Err(error) if error.contains("Unknown bridge route") => {
            return Ok(json!({ "ok": true, "account": { "supported": false } }));
        }
        Err(error) => return Err(error),
    };
    let target = match action.as_str() {
        "sign-in" => response.get("authorizeUrl").and_then(Value::as_str),
        "top-up" => response.pointer("/account/links/topUpUrl").and_then(Value::as_str),
        "usage" => response.pointer("/account/links/usageUrl").and_then(Value::as_str),
        _ => None,
    };
    if let Some(raw) = target {
        let url = validate_account_url(raw, action == "sign-in")?;
        open_system_target(url.as_str(), "无法打开浏览器，请稍后重试")?;
        response["opened"] = json!(true);
    }
    if let Some(object) = response.as_object_mut() { object.remove("authorizeUrl"); }
    Ok(response)
}

#[tauri::command]
pub async fn dsh_configure_cloud(
    endpoint: String,
    enabled: bool,
    manager: State<'_, DshManager>,
) -> Result<Value, String> {
    let (base_url, session_token) = if enabled {
        let mut parsed = crate::cloud::normalize_gateway_url(&endpoint)?;
        let prefix = parsed.path().trim_end_matches('/').to_string();
        parsed.set_path(&format!("{prefix}/v1/llm/anthropic"));
        let token = crate::storage::read_key("managed")
            .map_err(|_| "尚未建立云端托管会话".to_string())?;
        (parsed.to_string(), token)
    } else {
        (String::new(), String::new())
    };
    let (port, token) = {
        let g = manager.inner.lock().map_err(|_| "智能核心状态不可用")?;
        match (g.status.connected, g.status.port, g.token.clone()) {
            (true, Some(p), Some(t)) => (p, t),
            _ => return Ok(json!({ "ok": false, "deferred": true })),
        }
    };
    post_bridge(
        port,
        &token,
        "/cloud/configure",
        json!({
            "enabled": enabled,
            "baseURL": base_url,
            "token": session_token,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_updates_allow_reconnect_but_successful_updates_wait_for_relaunch() {
        let updating = Arc::new(AtomicBool::new(true));
        {
            let _failed_update = DshUpdateGuard { updating: updating.clone(), resume_on_drop: true };
        }
        assert!(!updating.load(Ordering::SeqCst));
        updating.store(true, Ordering::SeqCst);
        {
            let mut successful_update = DshUpdateGuard { updating: updating.clone(), resume_on_drop: true };
            successful_update.keep_suspended();
        }
        assert!(updating.load(Ordering::SeqCst));
    }

    #[test]
    fn account_browser_links_accept_only_the_official_https_origin() {
        assert!(validate_account_url("https://platform.deepseek.com/dsh/authorize?code=test", true).is_ok());
        assert!(validate_account_url("https://platform.deepseek.com/top_up", false).is_ok());
        for link in [
            "http://platform.deepseek.com/dsh/authorize",
            "https://platform.deepseek.com.attacker.example/dsh/authorize",
            "https://attacker.example@platform.deepseek.com/dsh/authorize",
            "https://platform.deepseek.com:8443/dsh/authorize",
            "https://platform.deepseek.com/dsh/authorize#fragment",
            "file:///Applications/KBOT.app",
            "https://platform.deepseek.com/other-page",
        ] {
            assert!(validate_account_url(link, true).is_err(), "rejected {link}");
        }
    }

    #[test]
    fn bundled_launch_requires_a_complete_runtime() {
        let root = std::env::temp_dir().join(format!("kbot-runtime-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("node/bin")).unwrap();
        std::fs::create_dir_all(root.join("app/node_modules/@deepseek-ai/dsh/lib")).unwrap();
        std::fs::write(root.join("runtime.json"), "{}").unwrap();
        std::fs::write(root.join("app/node_modules/@deepseek-ai/dsh/lib/bin.js"), "").unwrap();
        assert!(bundled_launch_at(&root).is_none());
        let node_bin = if cfg!(target_os = "windows") {
            root.join("node/node.exe")
        } else {
            root.join("node/bin/node")
        };
        std::fs::write(node_bin, "").unwrap();
        let launch = bundled_launch_at(&root).expect("complete runtime");
        assert!(launch.script.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tilde_expansion_resolves_default_and_custom_paths() {
        let p = expand_tilde("~/KBOT");
        assert!(p.ends_with("KBOT"));
        assert!(!p.to_string_lossy().starts_with('~'));
        assert_eq!(expand_tilde("/tmp/custom-kbot"), PathBuf::from("/tmp/custom-kbot"));
    }

    #[test]
    fn cordis_patch_preserves_existing_mcp_blocks_and_toggles_cleanly() {
        let existing = r#"- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
"#;
        let added = patch_cordis_yaml(existing, "/Users/test/.dsh/kbot-bridge/index.mjs", true);
        assert!(added.contains("id: rea-mcp"));
        assert!(added.contains("serverName: rea"));
        assert!(added.contains("id: kbot-bridge"));
        assert!(added.contains("port: 37891"));

        // Idempotent when called twice
        let added_twice = patch_cordis_yaml(&added, "/Users/test/.dsh/kbot-bridge/index.mjs", true);
        assert_eq!(added_twice.matches("id: kbot-bridge").count(), 1);
        assert_eq!(added_twice.matches("id: rea-mcp").count(), 1);

        // Clean removal preserves rea-mcp
        let removed = patch_cordis_yaml(&added_twice, "/Users/test/.dsh/kbot-bridge/index.mjs", false);
        assert!(removed.contains("id: rea-mcp"));
        assert!(!removed.contains("id: kbot-bridge"));

        // Also preserves desktop profile top-level `- id:` entries verbatim
        let desktop_profile = r#"# Your patch layer for this dsh profile
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: kimi-coding
    model: kimi-for-coding
"#;
        let desktop_added = patch_cordis_yaml(desktop_profile, "/Users/test/.dsh/kbot-bridge/index.mjs", true);
        assert!(desktop_added.contains("id: agent-default-model"));
        assert!(desktop_added.contains("model: kimi-for-coding"));
        assert!(desktop_added.contains("id: kbot-bridge"));
        let desktop_removed = patch_cordis_yaml(&desktop_added, "/Users/test/.dsh/kbot-bridge/index.mjs", false);
        assert!(desktop_removed.contains("id: agent-default-model"));
        assert!(!desktop_removed.contains("id: kbot-bridge"));
    }

    #[test]
    fn extracts_local_dsh_web_url_only() {
        assert_eq!(
            extract_dsh_web_url("dsh web: http://127.0.0.1:57447/?token=abc123"),
            Some("http://127.0.0.1:57447/?token=abc123".into())
        );
        assert_eq!(extract_dsh_web_url("dsh web: http://0.0.0.0:8080/?token=abc"), None);
        assert_eq!(extract_dsh_web_url("unrelated log"), None);
    }

    #[test]
    fn workspace_initializer_is_non_destructive_by_default() {
        let tmp = std::env::temp_dir().join(format!("kbot-ws-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let path_str = tmp.to_string_lossy().into_owned();

        let first = init_workspace_files(&path_str, false).expect("first init");
        assert_eq!(first.created_files.len(), 2);
        assert!(tmp.join("diary").is_dir());

        std::fs::write(tmp.join("MEMORY.md"), "# 自定义记忆\n保留我").unwrap();
        let second = init_workspace_files(&path_str, false).expect("second init");
        assert!(second.created_files.is_empty());
        assert_eq!(
            std::fs::read_to_string(tmp.join("MEMORY.md")).unwrap(),
            "# 自定义记忆\n保留我"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_initializer_upgrades_only_untouched_legacy_agents_md() {
        let tmp = std::env::temp_dir().join(format!("kbot-ws-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let path_str = tmp.to_string_lossy().into_owned();
        std::fs::create_dir_all(&tmp).unwrap();
        let agents = tmp.join("AGENTS.md");

        std::fs::write(&agents, LEGACY_AGENTS_MDS[0]).unwrap();
        let upgraded = init_workspace_files(&path_str, false).expect("upgrade init");
        assert!(upgraded.created_files.contains(&"AGENTS.md".to_string()));
        assert_eq!(std::fs::read_to_string(&agents).unwrap(), INITIAL_AGENTS_MD);

        let edited = format!("{}\n- 我自己加的一条\n", LEGACY_AGENTS_MDS[0]);
        std::fs::write(&agents, &edited).unwrap();
        let kept = init_workspace_files(&path_str, false).expect("edited init");
        assert!(!kept.created_files.contains(&"AGENTS.md".to_string()));
        assert_eq!(std::fs::read_to_string(&agents).unwrap(), edited);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn agents_template_drops_cute_expression_tags() {
        assert!(INITIAL_AGENTS_MD.contains("`[annoyed]`"));
        assert!(!INITIAL_AGENTS_MD.contains("[wink]"));
        assert!(!INITIAL_AGENTS_MD.contains("[coy]"));
    }

    #[test]
    fn bridge_script_version_and_model_routes_stay_in_sync() {
        let expected = format!("const BRIDGE_VERSION = \"{BRIDGE_VERSION}\";");
        assert!(KBOT_BRIDGE_MJS.contains(&expected));
        assert!(KBOT_BRIDGE_MJS.contains("\"/models/list\""));
        assert!(KBOT_BRIDGE_MJS.contains("\"/session/select-model\""));
        assert!(KBOT_BRIDGE_MJS.contains("\"/question/respond\""));
        assert!(KBOT_BRIDGE_MJS.contains("\"user-questions/request\""));
        assert!(KBOT_BRIDGE_MJS.contains("DeepSeek-V4.1-Flash"));
        assert!(KBOT_BRIDGE_MJS.contains("agent.model?.current"));
        assert!(KBOT_BRIDGE_MJS.contains("agent.model?.select"));
        assert!(KBOT_BRIDGE_MJS.contains("当前日期"));
        assert!(KBOT_BRIDGE_MJS.contains("界面语言"));
        assert!(KBOT_BRIDGE_MJS.contains("kbot_title_request"));
        assert!(KBOT_BRIDGE_MJS.contains("stream/refusal"));
        assert!(KBOT_BRIDGE_MJS.contains("sanitizeToolParametersForLlm"));
        assert!(KBOT_BRIDGE_MJS.contains("kbot.bridge.definitionsSanitized"));
        assert!(KBOT_BRIDGE_MJS.contains("extractSourcesFromToolResult"));
    }
}
