# KBOT · 纯桌面壳伙伴（基于 DeepSeek Harness）

**KBOT** 是一款面向 macOS（Apple Silicon）的轻量桌面陪伴机器人壳，使用 **Tauri 2 + TypeScript + Canvas + Rust** 构建，将推理、记忆、技能调度、联网与工具执行 100% 交由本机 **[DeepSeek Harness (DSH)](https://deepseek.com)** 驱动。

## 核心架构（纯桌面壳）

1. **形象渲染（Canvas 原创机器人）**
   - 透明无边框置顶窗口、原生鼠标采样与精确点击穿透（角色与展开面板区域可交互，四角透明区域穿透到下层窗口）。
   - 16 种情绪状态（`RB.STATES`）、弹簧物理反馈、视线跟随、连击表情与说话口型脉冲（`talkPulse`）。
2. **自定义对话窗与交互卡片**
   - 流式 Markdown 回复渲染、行内 `[expr]` 情绪标记实时剥离并驱动机器人表情切换。
   - **可折叠任务执行胶囊**：自动收纳 DSH 的思考、检索、读写文件、终端命令等中间步骤，保持正文清爽。
   - **交互式卡片**：原生支持 DSH 工具权限审批卡（`approval/request`）与多题交互式提问卡（`user-questions/request` / `ask_user_question`，支持单选、多选、推荐项、多题翻页、自定义输入与跳过）。
   - **后台气泡提醒**：DSH 定时任务（`dsh-schedule`）触发或面板收起期间完成长任务／发起提问时，由桌面机器人主动弹出气泡提醒，点击即可展开对应会话。
   - 顶栏支持一键切换 DSH 已配置的模型及快速打开内置 DSH Web 控制台。
3. **macOS 桌面感知上报**
   - 采集本机空闲时长、前台应用类别（识别会议应用自动进入勿扰）、勿扰状态、手动框选截图与 Open-Meteo 实时天气，通过本地桥接注入 DSH 会话上下文。
4. **小米 MiMo 情感语音与系统回退**
   - 支持小米 `mimo-v2.5-tts`（API Key 独立保存在本机 `0600` 受保护凭据库，版本更新无需重复授权钥匙串，支持结合当前性格与表情动态注入 `<style>` 情绪指令）。MiMo 未配置或服务不可用时不会播放系统语音。
5. **双模 DSH 连接与默认养成工作区**
   - **双模自动（Auto）**：优先复用已挂载桥接的外部 DSH 实例；未检测到时自动在后台拉起并托管 `dsh --profile web`。
   - **默认养成目录 `~/KBOT`**：首次启动非破坏性初始化 `AGENTS.md`（角色设定）、`MEMORY.md`（长期记忆）与 `diary/`（相处日记），支持在设置中自定义目录。
6. **内置静默自更新**
   - 默认连接自有 HTTPS 高速更新源 [`https://schathub.xyz/kbot/releases/latest.json`](https://schathub.xyz/kbot/releases/latest.json)（亦支持自定义 `latest.json` 地址、GitHub Releases 或本地 `~/KBOT/releases/latest.json`），检测到新版本后可一键下载校验、替换 `/Applications/KBOT.app` 并自动重启。

---

## 本地开发与构建

环境要求：**macOS（Apple Silicon）**、**Node.js 22+**、**Rust stable**、**Xcode Command Line Tools**，以及本机已安装 **DeepSeek Harness**。

```sh
npm install
npm run desktop        # 启动原生开发模式
npm run desktop:build  # 构建正式版 KBOT.app 与 DMG 安装包
npm test               # 运行前端单元测试 (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml --lib  # 运行 Rust 单元测试
```

`desktop:build` 和 `release` 只构建或发布，不会自动替换本机安装。日常请从 `/Applications/KBOT.app` 启动；`src-tauri/target/` 中的 `.app` 是打包产物。从构建目录、DMG 或系统隔离路径运行时，应用内更新会安装到 `/Applications/KBOT.app`。

单独构建并更新本机 `/Applications/KBOT.app`：

```sh
node scripts/desktop.mjs build --bundles app
ditto src-tauri/target/release/bundle/macos/KBOT.app /Applications/KBOT.app
```

---

## 一键打包与自动发版

完整步骤见 **[`发版说明.md`](发版说明.md)**。配置好本机 `.env.release.local`（已加入 `.gitignore`，不入库）后，只需一行命令即可完成本机测试、打包 `.app.zip` + `.dmg`、生成 SHA-256 `latest.json` 并原子发布到自有 HTTPS 更新源：

```sh
npm run release -- patch "本次更新说明"
```

---

## 数据存储与隐私

- **桌面壳状态**：`~/Library/Application Support/com.cybercompanion.desktop/state.json`（权限 `0600`，临时文件原子替换写入）。
- **养成记忆目录**：默认 `~/KBOT/`（重置桌面壳设置不会删除 `~/KBOT` 中的记忆与日记）。
- **语音凭据**：`~/Library/Application Support/com.cybercompanion.desktop/credentials.json`（独立于普通设置文件，权限 `0600` 仅当前用户可读，兼容旧版钥匙串自动迁移并清理），模型凭据由本机 DeepSeek Harness 统一管理。
