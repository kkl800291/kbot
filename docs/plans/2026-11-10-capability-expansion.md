# 拓展能力实现计划

> **状态：已废止（2026-11-13）。** 下文是历史记录，不要按它开工。现行架构以仓库根目录的 `README.md` 和 `需求文档.md` 为准。

这份计划写的是「壳内自建工具，再接多家 API Key」。KBOT 现在是纯桌面壳。推理、记忆、技能调度、联网搜索与网页抓取、工具执行、终端、MCP、定时任务（`dsh-schedule`）、审批卡、`ask_user_question`、DeepSeek 账号／余额和模型切换，都交给本机 DeepSeek Harness（`@deepseek-ai/dsh`）。版本钉在 `runtime/package.json` 和 `runtime/manifest.json`（当前 DSH `0.2.2-rc.3`）。连接方式是随包运行时、外部 DeepSeek Harness.app，或自定义 `dsh` 路径；自动模式优先已经挂上桥的外部实例。

取代关系：

- 第 1、2 节的自建 MCP、`rmcp`、官方 fetch／filesystem：**不实现**。搜索、抓取、文件、终端和 MCP 用 DSH 自己的工具。壳只渲染步骤胶囊，并把审批结果送回桥接（`src-tauri/src/dsh.rs`、`src/services/agent.ts`）。
- 第 3 节知识库：**不单做**。长期记忆是养成目录里的 `MEMORY.md` 和 `diary/`，由 DSH 读写。
- 第 4 节朗读：**已经做进壳，不进 DSH**。小米 `mimo-v2.5-tts`，Key 在本机权限为 `0600` 的凭据文件，见 `src-tauri/src/voice.rs`。听写仍未做。系统朗读不作为退路。
- 第 5 节 AstrBot：**不接入**。
- `create_reminder`、`remember_preference` 不再是壳的工具。用户交代的定时提醒走 DSH 日程。计时、勿扰和主动陪伴的固定短句仍在壳里（`src/services/proactive.ts`），模型不能改这些规则。
- 天气仍是壳里的 Open-Meteo。应用自更新仍是壳自己的事。形象、窗口和桌面感知也不进 DSH。

DeepSeek 于 2026-11-13 在服务端提供的网页搜索、抓取、文件解析（deepseek-flash），以及单独计费的 OCR、ASR、TTS、Search、Fetch API，不取代本机 DSH。至多将来由 DSH 在内部改用官方 Search／Fetch。

日期：2026-11-10

以下为当天原文。

习惯记忆与人格偏移完成并测试通过之后再做。本计划不接入 QQ、微信，也不嵌入大肥鱼一键包。工具、知识库和语音做进 KBOT。AstrBot 只做一次本地验证，用来判断插件能不能用，不进安装包。

## 已定边界

- 计时、勿扰、发言预算和习惯折算仍在本机。模型不能写习惯，也不能改休息规则。
- 提醒和用户亲口说的偏好仍走现有确认卡。见 [src/services/ai.ts](src/services/ai.ts) 的 `create_reminder`、`remember_preference`。
- 没有业务服务器。密钥进 macOS 钥匙串，不进 `state.json`。
- 不后台读屏、不读窗口标题、不监听剪贴板。知识库只读用户点名授权的文件夹。
- 联网搜索保持现有 DeepSeek、通义、Responses、Tavily、Brave 路径，不另做一套搜索。

## 1. 工具：能用现成的就用现成的

原则：协议和通用能力用官方实现，KBOT 只写安全外壳（确认卡、授权范围、内网拦截）和界面。2026-11-10 已决定替换此前手写的 MCP 客户端、网页抓取和文件读写。

### MCP 客户端改用官方 Rust SDK

- 用 `rmcp`（[modelcontextprotocol/rust-sdk](https://github.com/modelcontextprotocol/rust-sdk)）替换 `src-tauri/src/mcp.rs` 里手写的 JSON-RPC。版本、特性开关和子进程传输用法先按官方 README 和 docs.rs 核对，不凭记忆。
- 保留现有对外命令名和返回形状（`mcp_start`、`mcp_list_tools`、`mcp_call_tool`、`mcp_stop`、`mcp_save_secret`、`mcp_delete_secrets`），让 `src/services/mcp.ts` 和 `tests/mcp.test.ts` 基本不动。
- 保留这些 KBOT 自己的规则：调用超时 30 秒，进程退出只断开该服务，密钥按服务名存钥匙串 `mcp:<名称>`，关闭时连同子进程一起结束。
- 先支持 stdio。远程 HTTP MCP 不在这一期。

### 读网页、文件改用官方 MCP 服务

- 网页：官方 `fetch` 服务（`uvx mcp-server-fetch`）。
- 文件：官方 `filesystem` 服务（`npx -y @modelcontextprotocol/server-filesystem <授权目录...>`）。授权目录作为启动参数传入，由服务本身限制访问范围。
- 两个都作为「内置推荐服务」出现在设置里，一键添加，但不默认开启。启动前检查本机有没有 `uvx`、`npx`；没有就说明需要安装什么，不自动安装，也不随应用打包运行时。
- 具体包名、参数和工具名以官方仓库 [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) 为准，实现前核对。
- 删除手写的 `src-tauri/src/page.rs`、`files.rs` 及其测试，`lib.rs` 去掉对应命令；`src/services/tools.ts` 里的 `read_page`、`list_folder`、`read_file`、`write_file`、`move_file` 改为走 MCP。

### KBOT 自己保留的安全外壳

- 确认：`filesystem` 的写入、移动、建目录类工具一律出确认卡；读取类可在该服务设为「只读自动执行」时直接执行。其他服务默认每次确认。
- 内网拦截：`fetch` 本身不拦内网地址。调用前，KBOT 先校验参数里的 URL：只允许 http(s)，主机解析后不能落在 localhost、内网、链路本地、保留地址。把 `page.rs` 里这段校验函数单独留成一个小模块再删其余部分。已知限制：服务内部的重定向我们拦不住，计划里如实写明，设置里提示「只抓用户给出的链接」。
- 提醒和记忆：`create_reminder`、`remember_preference` 保持现有确认卡，不改语义。
- `get_weather`：仍用现有 Open-Meteo 摘要，自己写，几行代码。

### 接线

- 工具表从 [src/services/ai.ts](src/services/ai.ts) 传给 `chat_stream`：内置工具 + 已启动 MCP 服务的工具（加服务前缀）。只读结果作为 tool 消息再请求一轮，最多 3 轮；确认类生成 `m.card`。
- 卡片渲染和点击在 [src/ui/chat.js](src/ui/chat.js) 的 `cardEl`、`cardAction`，新增 `tool` 卡片，写明服务、工具和参数摘要。
- 设置页「工具服务」：推荐服务（fetch、filesystem）+ 自定义 stdio 服务；每个服务显示运行状态，选「每次确认 / 只读自动执行」，默认每次确认。

不做：任意 shell、控制音乐、发邮件、改系统设置。

测试：用假的 stdio 服务验证 rmcp 接入（列工具、调用、超时、进程退出）；确认类工具未点卡片不调用；内网 URL 在调用前被拒；缺少 `npx`/`uvx` 时给出说明而不崩溃；现有提醒确认测试仍然通过。

## 2. 已并入第 1 节

MCP 客户端的做法见上一节「MCP 客户端改用官方 Rust SDK」。

测试：用一个假的 stdio 服务返回一个只读工具；确认模式下不点卡片就不调用；服务退出时界面显示已断开，不卡住当前回复。

## 3. 知识库

用户在设置里添加文件夹。索引只留在 `~/Library/Application Support/com.cybercompanion.desktop/knowledge/`。

- 第一期用本地关键词检索，不把正文发给嵌入模型。这样未提问时不会上传文档。
- 按段落切片，记下相对路径和修改时间。文件变更后下次打开设置或每天第一次提问时增量更新。
- 提问时取少量相关片段，附在系统提示的记忆后面，并标明路径。`发送内容范围` 里新增「知识库」，默认关。关掉后不检索、不发送片段。
- 索引失败或文件夹被移走：照常回答，并说明这次没查到本地文档。

测试：未授权路径读不到；开关关闭时提示词不含片段；删除文件夹后索引目录被清掉。

## 4. 语音

朗读用语音合成模型，首个服务商是小米 MiMo。系统朗读不作为退回路径。

- 设置新增「语音」模型槽位 `tts`：服务商、接口地址、模型、声音。Key 存钥匙串 `tts` 项，和 `chat`、`vision`、`search` 并列。「清除所有数据」一并删除。
- 请求走 Rust，不在前端拿 Key。依据 [MiMo TTS API](https://mimo.mi.com/docs/zh-CN/api/audio/tts)：
  - `POST https://api.xiaomimimo.com/v1/chat/completions`，头 `api-key: <Key>` 或 `Authorization: Bearer <Key>`。不是 `/v1/audio/speech`。
  - 模型 `mimo-v2.5-tts`。要读的文字放在 `role: "assistant"` 的 `content`；放进 `user` 不会被读出来。`user` 只用于风格指令，如「语速稍快、轻声」。
  - `audio: { format: "wav", voice: "冰糖" }`。中文声音可选 `冰糖`、`茉莉`、`苏打`、`白桦`，默认 `冰糖`。没有数值语速和采样率参数；语速和语气按性格和偏移写成一句 `user` 风格指令。
  - 第一期用非流式。音频在 `choices[0].message.audio.data`，base64 解码成 wav 后在本机播放。
  - `tp-` 开头的 Token Plan Key 要换 `https://token-plan-cn.xiaomimimo.com/v1`，它是否开放 TTS 未核实，设置里允许改接口地址，测试朗读时直接报出服务返回的错误。
  - 401 提示 Key 或地址不匹配，402 余额不足，421 内容被拦截，429 频率或额度超限。以上都直接提示语音不可用。
  - 三个 TTS 模型目前限时免费，结束时间未公布，设置里不写「免费」。
- 返回的音频在本机播放，播完删除临时文件，不写进 `state.json`。同一句重复朗读可在内存里缓存最近几条。
- 气泡和聊天回复可点「朗读」。自动朗读单独开关，默认关闭；开了也只读主动发言和回复，不读提醒的按钮文字。勿扰、会议应用在前台时不自动朗读。
- 发送内容：只发要读的那句文字，不带聊天历史、记忆和习惯。设置里写明文字会发给小米。
- 失败处理：没配 Key、超时（8 秒）、额度或网络错误时直接提示语音不可用，不调用 macOS 系统朗读。
- 听写：聊天输入框加麦克风，先用系统听写或 Speech 框架。权限被拒时说明原因，文字输入保持可用。识别结果只进输入框，不自动发送。语音识别模型以后单独开一期。
- 连接测试：设置页「测试朗读」用一句固定短句，真实请求一次，报出成功或服务返回的错误。

测试：Key 不经过前端；请求体只含朗读文本和模型参数；超时和 4xx 时直接返回错误；勿扰时不自动朗读；无麦克风权限时不崩溃。

## 5. AstrBot 验证

这一期不进产品，不随 `.dmg` 分发。本机单独跑 AstrBot，写一个最小适配器，把 KBOT 的一条用户消息送进去，再把回复接回现有聊天流。

通过才考虑以后做成可选后端，四条都要满足：

- 流式文本和工具调用能回到现有气泡或聊天，不经 QQ。
- AstrBot 的主动消息和自动长期记忆能关干净。关不掉就失败。
- 额外体积和冷启动可接受：适配进程空闲内存不超过 300MB，冷启动到第一次回复不超过 15 秒。超出就失败。
- 许可结论写明。AstrBot 是 AGPL-3.0。若随应用分发会把分发义务带到 KBOT，则不内置，只允许用户本机自行安装。

任一条失败：插件能力停在 MCP，不接 AstrBot。

## 顺序

1. 习惯记忆：已完成，`npm test` 与类型检查通过。
2. MCP 客户端换 `rmcp`，删掉手写的网页、文件模块，接入官方 `fetch`、`filesystem` 服务和聊天确认卡。
3. MiMo 朗读。和第 2 步改的文件基本不重叠，可以并行。
4. 知识库接到设置和系统提示。
5. 听写。
6. 最后做 AstrBot 验证。验证结果写进 `docs/specs/`，再决定有没有插件后端这一期。

每一期都能单独打开使用，不依赖后面几期。
