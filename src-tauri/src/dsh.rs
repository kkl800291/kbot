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
const BRIDGE_VERSION: &str = "1.3.0";

const INITIAL_AGENTS_MD: &str = r#"# KBOT 管家指南 (AGENTS.md)

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
"#;

// 以前版本写进工作区的模板。工作区里的 AGENTS.md 和其中某一份完全一致，说明用户没改过，启动时换成新模板
const LEGACY_AGENTS_MDS: &[&str] = &[r#"# KBOT 桌面伙伴指南 (AGENTS.md)

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
"#];

const INITIAL_MEMORY_MD: &str = r#"# KBOT 长期记忆 (MEMORY.md)

## 关于主人
- （在日常交流中自然了解并补充主人的称呼、职业方向与作息节奏）

## 偏好与沟通习惯
- 喜欢简洁、直接、有温度的回应

## 重要事项与长期目标
- （记录持续推进的项目、纪念日或周期性习惯）
"#;

const KBOT_BRIDGE_MJS: &str = r#"import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const name = "kbot-bridge";
export const inject = ["workspaceRegistry", "sessionController"];

const BRIDGE_VERSION = "1.3.0";

const KNOWN_MODEL_DISPLAY_NAMES = {
  "deepseek-flash": "DeepSeek-V4.1-Flash",
  "deepseek-chat": "DeepSeek-V3.2",
  "deepseek-reasoner": "DeepSeek-R1",
};

function fallbackModelDisplayName(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return "";
  return KNOWN_MODEL_DISPLAY_NAMES[raw.toLowerCase()] || raw;
}

function normalizeBase64Image(input) {
  if (!input) return null;
  if (typeof input === "string") {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(input.trim());
    if (!match) return null;
    return { type: "image", mediaType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, "") };
  }
  if (typeof input === "object" && typeof input.data === "string") {
    const raw = input.data.trim();
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(raw);
    if (match) {
      return { type: "image", mediaType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, "") };
    }
    return {
      type: "image",
      mediaType: String(input.mediaType || "image/png").toLowerCase(),
      data: raw.replace(/\s+/g, ""),
    };
  }
  return null;
}

function formatDesktopSensors(assemblyCtx, sensors, trackedPaths, trackedSessions) {
  if (!sensors || typeof sensors !== "object") return "";
  const agent = assemblyCtx?.agent;
  const sessionId = String(agent?.id ?? assemblyCtx?.session?.id ?? "");
  const cwd = agent?.cwd ? path.resolve(agent.cwd) : "";
  if (trackedPaths.size > 0 || trackedSessions.size > 0) {
    const matchSession = sessionId && trackedSessions.has(sessionId);
    const matchPath = cwd && trackedPaths.has(cwd);
    if (!matchSession && !matchPath) return "";
  }
  const lines = [];
  if (sensors.nickname) lines.push(`主人称呼: ${sensors.nickname}`);
  if (sensors.persona) lines.push(`补充性格偏好: ${sensors.persona}`);
  if (sensors.away === true) {
    lines.push("桌面状态: 主人暂时离开电脑前");
  } else if (sensors.away === false) {
    lines.push("桌面状态: 主人正在电脑前活跃");
  }
  if (sensors.frontmostCategory) {
    const appSuffix = sensors.frontmostApp ? ` (${sensors.frontmostApp})` : "";
    lines.push(`前台场景: ${sensors.frontmostCategory}${appSuffix}`);
  }
  if (sensors.dnd) {
    lines.push(`勿扰模式: 开启${sensors.dndLabel ? ` (${sensors.dndLabel})` : ""}`);
  }
  if (sensors.weather) {
    lines.push(`当地天气: ${sensors.weather}`);
  }
  if (lines.length === 0) return "";
  return `<kbot_desktop_context>\n${lines.join("\n")}\n</kbot_desktop_context>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 60 * 1024 * 1024) {
        reject(new Error("Request payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export async function apply(ctx, config = {}) {
  const bridgeDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "kbot-bridge");
  await fsp.mkdir(bridgeDir, { recursive: true });
  const preferredPort = Number.isInteger(config.port) ? config.port : 37891;
  const hostKind = config.hostKind || (preferredPort === 0 ? "managed" : "external");
  const discoveryFile = config.discoveryFile || path.join(bridgeDir, "bridge.json");
  const token =
    typeof config.token === "string" && config.token.length >= 16
      ? config.token
      : crypto.randomBytes(24).toString("hex");

  const clients = new Set();
  const trackedSessions = new Set();
  const trackedPaths = new Set();
  const kbotRequestIds = new Set();
  const pendingApprovals = new Map();
  const pendingQuestions = new Map();
  const modelDisplayCache = new Map();
  const manualSessionModels = new Map();
  let lastObservedDefaultKey = "";
  let latestSensors = null;

  const getLlm = () => ctx.get?.("llm") ?? ctx.llm ?? null;
  const getDefaultModelSvc = () => ctx.get?.("agentDefaultModel") ?? ctx.agentDefaultModel ?? null;
  const getUserQuestionsSvc = () => ctx.get?.("userQuestions") ?? ctx.userQuestions ?? null;
  const getAccount = () => ctx.get?.("deepseekAccount") ?? ctx.deepseekAccount ?? null;
  const clientVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.resolve(path.dirname(process.argv[1]), "../package.json"), "utf8")).version; }
    catch { return "0.2.2-rc.1"; }
  })();
  const accountClient = (body = {}) => ({
    version: clientVersion,
    locale: typeof body.locale === "string" ? body.locale.slice(0, 20) : "zh-CN",
    timezoneOffsetSeconds: Number.isFinite(body.timezoneOffsetSeconds) ? body.timezoneOffsetSeconds : 28800,
  });
  // Account grants and PKCE secrets stay in DSH. Only this display projection
  // crosses the bridge; the authorization URL is returned to the native opener.
  const accountView = (view) => ({
    supported: true,
    status: view.status,
    links: view.links,
    attempt: view.attempt ? {
      id: view.attempt.id,
      phase: view.attempt.phase,
      expiresAt: view.attempt.expiresAt,
      errorCode: view.attempt.errorCode,
    } : null,
  });

  ctx.inject(["deepseekAccount"], (scope) => {
    const abort = new AbortController();
    scope.effect(() => () => abort.abort());
    void (async () => {
      for await (const view of scope.deepseekAccount.watch(abort.signal)) {
        broadcast({ type: "account/state", account: accountView(view) });
      }
    })().catch(() => {});
  });

  const serializeQuestions = (list) =>
    Array.isArray(list)
      ? list.map((q, idx) => ({
          id: String(q?.id || `q_${idx + 1}`),
          question: String(q?.question || ""),
          ...(typeof q?.header === "string" && q.header ? { header: q.header } : {}),
          ...(typeof q?.detail === "string" && q.detail ? { detail: q.detail } : {}),
          ...(Array.isArray(q?.options)
            ? {
                options: q.options.map((opt) => ({
                  label: String(opt?.label || ""),
                  ...(typeof opt?.description === "string" && opt.description
                    ? { description: opt.description }
                    : {}),
                })),
              }
            : {}),
          multiSelect: Boolean(q?.multiSelect ?? q?.multi_select),
          ...(q?.intent && typeof q.intent === "object" ? { intent: q.intent } : {}),
        }))
      : [];

  const normalizeSubmittedAnswers = (questions, rawAnswers) => {
    const byId = new Map();
    if (Array.isArray(rawAnswers)) {
      for (const item of rawAnswers) {
        if (item && typeof item.id === "string") {
          byId.set(item.id, item);
        }
      }
    }
    return (Array.isArray(questions) ? questions : []).map((q) => {
      const found = byId.get(q.id);
      const selected = Array.isArray(found?.selected)
        ? found.selected.map((s) => String(s)).filter(Boolean)
        : [];
      const custom = typeof found?.custom === "string" ? found.custom.trim() : "";
      return custom ? { id: q.id, selected, custom } : { id: q.id, selected };
    });
  };

  const lookupCachedModelMeta = (providerId, modelId) => {
    const p = String(providerId || "");
    const m = String(modelId || "");
    if (!m) return { displayName: null, providerName: p || null };
    const hit = modelDisplayCache.get(`${p}::${m}`);
    if (hit) return hit;
    for (const [key, val] of modelDisplayCache.entries()) {
      if (key.endsWith(`::${m}`)) return val;
    }
    return {
      displayName: fallbackModelDisplayName(m) || m,
      providerName: p || null,
    };
  };

  async function buildRoutableCatalog() {
    const llm = getLlm();
    if (!llm || typeof llm.listProviders !== "function") {
      return { groups: [], routableProviders: new Set() };
    }
    const providers = llm.listProviders() || [];
    const settled = await Promise.all(
      providers.map(async (provider) => {
        try {
          const list = (await llm.listModels?.(provider.id)) || [];
          const models = await Promise.all(
            list.map(async (m) => {
              let resolvedName = m?.name || "";
              if (!resolvedName && typeof llm.resolveModelInfo === "function") {
                try {
                  const info = await llm.resolveModelInfo(provider.id, m.id);
                  resolvedName = info?.name || "";
                } catch {}
              }
              const displayName = resolvedName || fallbackModelDisplayName(m.id) || String(m.id);
              modelDisplayCache.set(`${provider.id}::${m.id}`, {
                displayName,
                providerName: provider.name || provider.id,
              });
              return {
                id: String(m.id),
                name: displayName,
                description: m?.description || "",
              };
            }),
          );
          return {
            id: String(provider.id),
            name: String(provider.name || provider.id),
            models,
          };
        } catch {
          return null;
        }
      }),
    );
    const groups = settled.filter((g) => g && Array.isArray(g.models) && g.models.length > 0);
    return {
      groups,
      routableProviders: new Set(groups.map((g) => g.id)),
    };
  }

  async function resolveCatalogEntry(providerId, modelId) {
    if (!modelId) return null;
    const p = String(providerId || "");
    const m = String(modelId || "");
    const llm = getLlm();
    let providerName = p || null;
    let displayName = "";
    if (llm) {
      try {
        const prov = (llm.listProviders?.() || []).find((item) => item.id === p);
        if (prov?.name) providerName = String(prov.name);
      } catch {}
      if (p && typeof llm.resolveModelInfo === "function") {
        try {
          const info = await llm.resolveModelInfo(p, m);
          if (info?.name) displayName = String(info.name);
        } catch {}
      }
      if (!displayName && p && typeof llm.listModels === "function") {
        try {
          const list = (await llm.listModels(p)) || [];
          const found = list.find((item) => item.id === m);
          if (found?.name) displayName = String(found.name);
        } catch {}
      }
    }
    if (!displayName) {
      displayName = lookupCachedModelMeta(p, m).displayName || fallbackModelDisplayName(m) || m;
    }
    if (p && m) {
      modelDisplayCache.set(`${p}::${m}`, { displayName, providerName });
    }
    return { provider: p || null, providerName, model: m, displayName };
  }

  const broadcast = (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  const belongsToKbot = (sessionId, cwd) => {
    const id = String(sessionId || "");
    if (id && trackedSessions.has(id)) return true;
    if (cwd && trackedPaths.has(path.resolve(cwd))) {
      if (id) trackedSessions.add(id);
      return true;
    }
    if (id) {
      for (const ws of ctx.workspaceRegistry.list()) {
        if (trackedPaths.has(path.resolve(ws.path)) && ws.sessionIds.includes(id)) {
          trackedSessions.add(id);
          return true;
        }
      }
      const live = ctx.get?.("agents")?.get?.(id);
      if (live?.cwd && trackedPaths.has(path.resolve(live.cwd))) {
        trackedSessions.add(id);
        return true;
      }
    }
    return false;
  };

  ctx.inject(["systemPrompt"], (spCtx) => {
    spCtx.systemPrompt.context({
      name: "kbot:desktop-sensors",
      order: 250,
      text: (assemblyCtx) => formatDesktopSensors(assemblyCtx, latestSensors, trackedPaths, trackedSessions),
    });
  });

  ctx.on(
    "agent/assistant-stream",
    ({ agent, frame }) => {
      if (!belongsToKbot(agent?.id, agent?.cwd)) return;
      const sessionId = String(agent.id);
      if (frame.type === "start") {
        broadcast({ type: "stream/start", sessionId, turn: frame.turn, step: frame.step });
        return;
      }
      if (frame.type === "end") {
        broadcast({ type: "stream/end", sessionId });
        return;
      }
      if (frame.type === "chunk" && frame.chunk) {
        const chunk = frame.chunk;
        if (chunk.type === "text-delta" && chunk.text) {
          broadcast({ type: "stream/text", sessionId, delta: chunk.text });
        } else if (chunk.type === "reasoning-delta" && chunk.text) {
          broadcast({ type: "stream/reasoning", sessionId, delta: chunk.text });
        }
      }
    },
    { global: true },
  );

  ctx.on(
    "agent/status",
    ({ agent, status }) => {
      if (!belongsToKbot(agent?.id, agent?.cwd)) return;
      broadcast({ type: "agent/status", sessionId: String(agent.id), status });
    },
    { global: true },
  );

  ctx.on(
    "agent/error",
    ({ agent, error }) => {
      if (!belongsToKbot(agent?.id, agent?.cwd)) return;
      broadcast({
        type: "agent/error",
        sessionId: String(agent.id),
        code: typeof error?.code === "string" ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
      });
    },
    { global: true },
  );

  ctx.on(
    "session/event",
    (session, event) => {
      if (!event || !belongsToKbot(session?.id, null)) return;
      const sessionId = String(session.id);
      switch (event.type) {
        case "turn/start":
          broadcast({ type: "turn/start", sessionId, turn: event.data?.turn });
          break;
        case "turn/end":
          broadcast({ type: "turn/end", sessionId, turn: event.data?.turn, reason: event.data?.reason });
          break;
        case "user/message": {
          const src = event.data?.source;
          if (src?.kind === "runtime-context") break;
          if (src?.kind === "user-question-reply") {
            broadcast({
              type: "question/resolved",
              sessionId,
              callId: src?.callId || null,
              outcome: src?.outcome || "answered",
            });
            break;
          }
          const fromKbot = Boolean(src?.rpcId && kbotRequestIds.has(String(src.rpcId)));
          if (src?.rpcId) kbotRequestIds.delete(String(src.rpcId));
          broadcast({
            type: "user/message",
            sessionId,
            fromKbot,
            sourceKind: src?.kind || "unknown",
            content: event.data?.content || [],
          });
          break;
        }
        case "tool/call":
          broadcast({
            type: "tool/call",
            sessionId,
            callId: event.data?.callId,
            name: event.data?.name,
            arguments: event.data?.arguments,
          });
          break;
        case "tool/result":
          broadcast({
            type: "tool/result",
            sessionId,
            callId:
              event.data?.message?.toolCallId ||
              event.data?.message?.callId ||
              event.data?.callId ||
              null,
            isError: Boolean(event.data?.message?.isError),
          });
          break;
        case "assistant/message": {
          const msg = event.data?.message;
          const text = Array.isArray(msg?.content)
            ? msg.content
                .filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("")
            : "";
          const srcModel = msg?.source?.model || null;
          const srcProvider = msg?.source?.provider || null;
          const meta = srcModel ? lookupCachedModelMeta(srcProvider, srcModel) : { displayName: null, providerName: null };
          broadcast({
            type: "assistant/message",
            sessionId,
            text,
            interrupted: Boolean(event.data?.interrupted),
            model: srcModel,
            provider: srcProvider,
            displayName: meta.displayName,
            providerName: meta.providerName,
          });
          break;
        }
      }
    },
    { global: true },
  );

  ctx.on(
    "approval/request",
    async (req, next) => {
      const agent = req?.agent;
      if (!belongsToKbot(agent?.id, agent?.cwd) || clients.size === 0) {
        return next();
      }
      const approvalId = crypto.randomUUID();
      const sessionId = String(agent.id);
      return await new Promise((resolve) => {
        const settle = (outcome) => {
          if (!pendingApprovals.has(approvalId)) return;
          pendingApprovals.delete(approvalId);
          resolve(outcome);
        };
        pendingApprovals.set(approvalId, settle);
        if (req.signal) {
          if (req.signal.aborted) {
            settle("cancelled");
            return;
          }
          req.signal.addEventListener("abort", () => settle("cancelled"), { once: true });
        }
        broadcast({
          type: "approval/request",
          approvalId,
          sessionId,
          callId: req.callId || null,
          toolName: req.toolName || "tool",
          reason: req.reason || "",
        });
      });
    },
    { global: true, prepend: true },
  );

  ctx.on(
    "user-questions/request",
    async (req, next) => {
      const agent = req?.agent;
      if (!belongsToKbot(agent?.id, agent?.cwd) || clients.size === 0) {
        return next();
      }
      const questionRequestId = crypto.randomUUID();
      const sessionId = String(agent.id);
      const callId = req?.wait?.callId ? String(req.wait.callId) : null;
      const timed = Boolean(req?.wait?.timed);
      const questions = serializeQuestions(req?.questions);
      if (questions.length === 0) {
        return next();
      }

      const claimAbort = new AbortController();
      const uq = getUserQuestionsSvc();
      if (timed && callId && agent && typeof uq?.attachWait === "function") {
        (async () => {
          try {
            for await (const _frame of uq.attachWait(agent, callId, claimAbort.signal)) {
              // Keep foreground timed wait claimed while KBOT displays the question card.
            }
          } catch {}
        })();
      }

      return await new Promise((resolve, reject) => {
        const cleanup = () => {
          const existed = pendingQuestions.delete(questionRequestId);
          try {
            claimAbort.abort();
          } catch {}
          return existed;
        };
        const resolveAnswer = (rawAnswers) => {
          if (!cleanup()) return false;
          const answers = normalizeSubmittedAnswers(questions, rawAnswers);
          broadcast({
            type: "question/resolved",
            questionRequestId,
            sessionId,
            callId,
            outcome: "answered",
            answers,
          });
          resolve({ answers });
          return true;
        };
        const rejectQuestion = (
          code = "ASK_CANCELLED",
          message = "the user cancelled ask_user_question",
        ) => {
          if (!cleanup()) return false;
          broadcast({
            type: "question/resolved",
            questionRequestId,
            sessionId,
            callId,
            outcome: code === "ASK_TIMED_OUT" ? "continued" : "cancelled",
          });
          reject(Object.assign(new Error(message), { name: "UserQuestionError", code }));
          return true;
        };

        pendingQuestions.set(questionRequestId, {
          questionRequestId,
          sessionId,
          callId,
          timed,
          state: "open",
          questions,
          resolveAnswer,
          rejectQuestion,
        });

        if (req.signal) {
          if (req.signal.aborted) {
            rejectQuestion("ASK_ABORTED", "ask_user_question was aborted before the user answered");
            return;
          }
          req.signal.addEventListener(
            "abort",
            () => {
              rejectQuestion("ASK_ABORTED", "ask_user_question was aborted before the user answered");
            },
            { once: true },
          );
        }

        broadcast({
          type: "question/request",
          questionRequestId,
          sessionId,
          callId,
          timed,
          state: "open",
          questions,
        });
      });
    },
    { global: true, prepend: true },
  );

  async function getActiveSessionQuestions(sessionId) {
    const sid = String(sessionId || "");
    if (!sid) return [];
    const items = [];
    const seenCallIds = new Set();
    for (const entry of pendingQuestions.values()) {
      if (entry.sessionId === sid) {
        if (entry.callId) seenCallIds.add(entry.callId);
        items.push({
          questionRequestId: entry.questionRequestId,
          sessionId: sid,
          callId: entry.callId,
          timed: entry.timed,
          state: entry.state || "open",
          questions: entry.questions,
        });
      }
    }
    try {
      const resolved = await ctx.sessionController.agents.resolveAgent(sid);
      const agent = resolved?.agent ?? resolved;
      const uq = getUserQuestionsSvc();
      if (agent && !resolved?.error && typeof uq?.continued === "function") {
        const cont = uq.continued(agent) || [];
        for (const q of cont) {
          const cid = q?.callId ? String(q.callId) : "";
          if (!cid || seenCallIds.has(cid)) continue;
          seenCallIds.add(cid);
          items.push({
            questionRequestId: `continued:${cid}`,
            sessionId: sid,
            callId: cid,
            timed: true,
            state: "continued",
            questions: serializeQuestions(q.questions),
          });
        }
      }
    } catch {}
    return items;
  }

  async function resolveCurrentModel(sessionId) {
    try {
      const sid = String(sessionId || "");
      const defaultSel = getDefaultModelSvc()?.currentSelection?.() || null;
      const defaultKey =
        defaultSel?.provider && defaultSel?.model
          ? `${defaultSel.provider}::${defaultSel.model}`
          : "";
      if (defaultKey && defaultKey !== lastObservedDefaultKey) {
        if (lastObservedDefaultKey) {
          manualSessionModels.clear();
        }
        lastObservedDefaultKey = defaultKey;
      }

      const { groups, routableProviders } = await buildRoutableCatalog();
      if (routableProviders.size === 0) return null;
      const res = sid ? await ctx.sessionController.agents.resolveAgent(sid) : null;
      const agent = res?.agent ?? res;
      if (!agent || res?.error) {
        if (defaultSel?.model) {
          const meta = await resolveCatalogEntry(defaultSel.provider, defaultSel.model);
          return { ...meta, reasoningEffort: defaultSel.reasoningEffort ?? null };
        }
        return null;
      }

      let sel = ctx.sessionController.agents.selectionFor(agent)?.current || null;
      const manual = manualSessionModels.get(sid) || null;
      const isRoutable = (prov) =>
        Boolean(prov) && (routableProviders.size === 0 || routableProviders.has(String(prov)));

      let desired = null;
      if (manual?.provider && manual?.model && isRoutable(manual.provider)) {
        if (!sel || sel.provider !== manual.provider || sel.model !== manual.model) {
          desired = manual;
        }
      } else if (
        defaultSel?.provider &&
        defaultSel?.model &&
        isRoutable(defaultSel.provider) &&
        (!sel?.model || !isRoutable(sel.provider) || (!manual && (sel.provider !== defaultSel.provider || sel.model !== defaultSel.model)))
      ) {
        desired = defaultSel;
      } else if ((!sel?.model || !isRoutable(sel.provider)) && groups.length > 0 && groups[0].models.length > 0) {
        desired = { provider: groups[0].id, model: groups[0].models[0].id };
      }

      if (desired?.provider && desired?.model) {
        try {
          ctx.sessionController.agents.selectForNextRequest?.(agent, {
            provider: desired.provider,
            model: desired.model,
            ...(desired.reasoningEffort ? { reasoningEffort: desired.reasoningEffort } : {}),
          });
          sel = ctx.sessionController.agents.selectionFor(agent)?.current || desired;
        } catch {}
      }

      if (!sel?.model) return null;
      const meta = await resolveCatalogEntry(sel.provider, sel.model);
      return {
        provider: sel.provider,
        providerName: meta?.providerName || sel.provider || null,
        model: sel.model,
        displayName: meta?.displayName || fallbackModelDisplayName(sel.model) || sel.model,
        reasoningEffort: sel.reasoningEffort ?? null,
      };
    } catch {
      return null;
    }
  }

  async function ensureWorkspaceSession({ workspacePath, sessionId, createNew = false }) {
    const resolvedPath = path.resolve(workspacePath);
    await fsp.mkdir(resolvedPath, { recursive: true });
    let ws = await ctx.workspaceRegistry.resolveByPath(resolvedPath);
    if (!ws) ws = await ctx.workspaceRegistry.create(resolvedPath, "KBOT");
    trackedPaths.add(path.resolve(ws.path));

    const archived = new Set((ctx.workspaceRegistry.archivedSessionIds || []).map(String));
    let activeSessionId = null;

    if (!createNew && sessionId && ws.sessionIds.map(String).includes(String(sessionId)) && !archived.has(String(sessionId))) {
      activeSessionId = String(sessionId);
    }
    if (!createNew && !activeSessionId) {
      const existing = ws.sessionIds.map(String).find((id) => !archived.has(id));
      if (existing) activeSessionId = existing;
    }
    if (!activeSessionId) {
      const created = await ctx.sessionController.commands.create({ workspaceId: ws.id });
      activeSessionId = String(created.sessionId);
    }

    trackedSessions.add(activeSessionId);
    const model = await resolveCurrentModel(activeSessionId);
    const activeQuestions = await getActiveSessionQuestions(activeSessionId);
    return {
      ok: true,
      workspaceId: String(ws.id),
      workspacePath: ws.path,
      sessionId: activeSessionId,
      sessionIds: ws.sessionIds.map(String).filter((id) => !archived.has(id)),
      model,
      pendingQuestions: activeQuestions,
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const headerToken = req.headers["x-kbot-token"];
      if (headerToken !== token) {
        sendJson(res, 401, { ok: false, error: "Unauthorized bridge request" });
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          version: BRIDGE_VERSION,
          pid: process.pid,
          hostKind,
          port: server.address()?.port ?? 0,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "bridge/connected", pid: process.pid, hostKind })}\n\n`);
        clients.add(res);
        req.on("close", () => {
          clients.delete(res);
        });
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      const body = await readJsonBody(req);

      if (url.pathname.startsWith("/account/")) {
        const account = getAccount();
        if (!account) {
          sendJson(res, 200, { ok: true, account: { supported: false } });
          return;
        }
        const client = accountClient(body);
        let view = await account.getState();
        if (url.pathname === "/account/sign-in") {
          const webServer = ctx.get?.("webServer") ?? ctx.webServer;
          if (!webServer?.getOrigin) throw new Error("当前核心不支持浏览器登录，请改用内置核心");
          view = await account.startSignIn(client, webServer.getOrigin(), "web");
          const deadline = Date.now() + 8000;
          while (view.attempt?.phase === "initializing" && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 150));
            view = await account.getState();
          }
          sendJson(res, 200, { ok: true, account: accountView(view), authorizeUrl: view.attempt?.phase === "waiting-browser" ? view.attempt.authorizeUrl || null : null });
          return;
        }
        if (url.pathname === "/account/cancel") {
          if (typeof body.attemptId !== "string" || !body.attemptId) throw new Error("缺少登录请求标识");
          view = await account.cancelSignIn(body.attemptId);
        } else if (url.pathname === "/account/sign-out") {
          view = await account.signOut(client);
        } else if (url.pathname === "/account/details") {
          let profile = null, balance = null;
          if (view.status === "credential-stored") {
            const results = await Promise.allSettled([account.getProfile(client), account.getBalance(client)]);
            profile = results[0].status === "fulfilled" ? results[0].value : { status: "failed" };
            balance = results[1].status === "fulfilled" ? results[1].value : { status: "failed" };
            view = await account.getState();
          }
          sendJson(res, 200, { ok: true, account: { ...accountView(view), profile, balance } });
          return;
        } else if (url.pathname !== "/account/state") {
          sendJson(res, 404, { ok: false, error: "Unknown account action" });
          return;
        }
        sendJson(res, 200, { ok: true, account: accountView(view) });
        return;
      }

      if (url.pathname === "/session/ensure") {
        const out = await ensureWorkspaceSession({
          workspacePath: body.workspacePath,
          sessionId: body.sessionId,
          createNew: Boolean(body.createNew),
        });
        sendJson(res, 200, out);
        return;
      }

      if (url.pathname === "/session/new") {
        const out = await ensureWorkspaceSession({
          workspacePath: body.workspacePath,
          createNew: true,
        });
        sendJson(res, 200, out);
        return;
      }

      if (url.pathname === "/session/prompt") {
        const sessionId = String(body.sessionId || "");
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: "Missing sessionId" });
          return;
        }
        trackedSessions.add(sessionId);
        const requestId = String(body.requestId || crypto.randomUUID());
        kbotRequestIds.add(requestId);
        const content = [];
        if (Array.isArray(body.images)) {
          for (const rawImg of body.images) {
            const img = normalizeBase64Image(rawImg);
            if (img) content.push(img);
          }
        }
        const text = typeof body.text === "string" ? body.text : "";
        if (text.trim() || content.length === 0) {
          content.push({ type: "text", text });
        }
        const source = {
          kind: "user",
          rpcId: requestId,
          ...(typeof body.clientTimeZone === "string" && body.clientTimeZone
            ? { clientTimeZone: body.clientTimeZone }
            : {}),
        };
        const result = await ctx.sessionController.commands.prompt(
          {
            sessionId,
            requestId,
            mode: body.mode === "steer" ? "steer" : "followup",
            content,
          },
          source,
        );
        sendJson(res, 200, { ok: true, sessionId, requestId, ...result });
        return;
      }

      if (url.pathname === "/session/cancel") {
        const sessionId = String(body.sessionId || "");
        if (sessionId) {
          await ctx.sessionController.commands.cancel({ sessionId });
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/approval/respond") {
        const approvalId = String(body.approvalId || "");
        const outcome = body.outcome === "allowed-once" ? "allowed-once" : "rejected";
        const settle = pendingApprovals.get(approvalId);
        if (settle) settle(outcome);
        broadcast({ type: "approval/resolved", approvalId, outcome });
        sendJson(res, 200, { ok: true, resolved: Boolean(settle) });
        return;
      }

      if (url.pathname === "/question/respond") {
        const questionRequestId = String(body.questionRequestId || "");
        const sessionId = String(body.sessionId || "");
        const callId = body.callId ? String(body.callId) : null;
        const action = body.action === "cancel" ? "cancel" : "answer";

        let liveEntry = questionRequestId ? pendingQuestions.get(questionRequestId) : null;
        if (!liveEntry && callId) {
          for (const entry of pendingQuestions.values()) {
            if (entry.callId === callId && (!sessionId || entry.sessionId === sessionId)) {
              liveEntry = entry;
              break;
            }
          }
        }

        if (liveEntry) {
          const resolved =
            action === "cancel"
              ? liveEntry.rejectQuestion("ASK_CANCELLED", "the user cancelled ask_user_question")
              : liveEntry.resolveAnswer(body.answers);
          sendJson(res, 200, { ok: true, resolved, mode: "live" });
          return;
        }

        if (action === "answer" && sessionId && callId) {
          const uq = getUserQuestionsSvc();
          const resolvedAgent = await ctx.sessionController.agents.resolveAgent(sessionId);
          const agent = resolvedAgent?.agent ?? resolvedAgent;
          if (agent && !resolvedAgent?.error && typeof uq?.answer === "function") {
            const contList = typeof uq.continued === "function" ? uq.continued(agent) || [] : [];
            const matched = contList.find((item) => String(item?.callId || "") === callId);
            if (matched) {
              const answers = normalizeSubmittedAnswers(
                serializeQuestions(matched.questions),
                body.answers,
              );
              const accepted = uq.answer(agent, callId, { answers });
              if (accepted) {
                broadcast({
                  type: "question/resolved",
                  questionRequestId: questionRequestId || null,
                  sessionId,
                  callId,
                  outcome: "answered",
                  answers,
                });
                sendJson(res, 200, { ok: true, resolved: true, mode: "continued" });
                return;
              }
            }
          }
        }

        broadcast({
          type: "question/resolved",
          questionRequestId: questionRequestId || null,
          sessionId: sessionId || null,
          callId,
          outcome: action === "cancel" ? "cancelled" : "answered",
        });
        sendJson(res, 200, { ok: true, resolved: false, mode: "stale" });
        return;
      }

      if (url.pathname === "/sensors/update") {
        latestSensors = body.sensors || null;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/models/list") {
        const { groups } = await buildRoutableCatalog();
        const current = body.sessionId ? await resolveCurrentModel(body.sessionId) : null;
        sendJson(res, 200, {
          ok: true,
          current,
          groups,
        });
        return;
      }

      if (url.pathname === "/session/select-model") {
        const sessionId = String(body.sessionId || "");
        const provider = String(body.provider || "");
        const model = String(body.model || "");
        if (!provider || !model) {
          sendJson(res, 400, { ok: false, error: "Missing provider or model" });
          return;
        }
        const selected = {
          provider,
          model,
          ...(body.reasoningEffort ? { reasoningEffort: String(body.reasoningEffort) } : {}),
        };
        if (sessionId) {
          manualSessionModels.set(sessionId, selected);
          try {
            const resolved = await ctx.sessionController.agents.resolveAgent(sessionId);
            const agent = resolved?.agent ?? resolved;
            if (agent && !resolved?.error) {
              ctx.sessionController.agents.selectForNextRequest?.(agent, selected);
            }
          } catch {}
        }
        try {
          await getDefaultModelSvc()?.saveSelection?.(selected);
          lastObservedDefaultKey = `${provider}::${model}`;
        } catch {}
        const meta = await resolveCatalogEntry(provider, model);
        sendJson(res, 200, {
          ok: true,
          model: {
            provider,
            providerName: meta?.providerName || provider,
            model,
            displayName: meta?.displayName || fallbackModelDisplayName(model) || model,
            reasoningEffort: selected.reasoningEffort ?? null,
          },
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown bridge route: ${url.pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        code: err?.code || "bridge/internal",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const listenOn = (port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

  let boundPort;
  try {
    boundPort = await listenOn(preferredPort);
  } catch (err) {
    if (err?.code === "EADDRINUSE" && config.allowDynamicPort !== false) {
      boundPort = await listenOn(0);
    } else {
      throw err;
    }
  }

  const info = {
    version: BRIDGE_VERSION,
    pid: process.pid,
    port: boundPort,
    token,
    hostKind,
    startedAt: Date.now(),
  };
  await fsp.writeFile(discoveryFile, JSON.stringify(info, null, 2), { mode: 0o600 });

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(": ping\n\n");
      } catch {
        clients.delete(res);
      }
    }
  }, 15000);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const [, settle] of pendingApprovals) {
      try {
        settle("cancelled");
      } catch {}
    }
    pendingApprovals.clear();
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    clients.clear();
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      const raw = JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
      if (raw?.pid === process.pid && raw?.port === boundPort) {
        fs.unlinkSync(discoveryFile);
      }
    } catch {}
  };

  ctx.effect(() => () => void cleanup(), "kbot-bridge.http");
}
"#;

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

fn terminate_managed_dsh_pid(pid: u32) {
    if pid <= 1 {
        return;
    }
    let is_managed = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "args="])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|args| args.contains("managed-patch.yml"))
        .unwrap_or(false);
    if is_managed {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
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
    let candidates = [
        PathBuf::from("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"),
        home.join("Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"),
        home.join(".local/bin/dsh"),
        home.join(".dsh/bin/dsh"),
        PathBuf::from("/opt/homebrew/bin/dsh"),
        PathBuf::from("/usr/local/bin/dsh"),
    ];
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("dsh");
            if candidate.is_file() {
                return Some(candidate);
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
    let binary = root.join("node/bin/node");
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
        if info.pid > 1 {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-TERM", &info.pid.to_string()])
                .status();
        }
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
        .map_err(|e| format!("DSH 桥接通信失败: {e}"))?;
    let status = resp.status();
    let json_body: Value = resp
        .json()
        .await
        .map_err(|e| format!("DSH 桥接返回格式异常: {e}"))?;
    if !status.is_success() || json_body.get("ok").and_then(Value::as_bool) == Some(false) {
        let msg = json_body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("DSH 请求执行失败");
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
    std::process::Command::new("/usr/bin/open")
        .arg(&outcome.workspace_path)
        .spawn()
        .map_err(|e| format!("无法在访达中打开养成目录: {e}"))?;
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
                        format!("DSH 托管进程提前退出 ({code})")
                    } else {
                        format!("DSH 托管进程启动失败: {err_tail}")
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
                let msg = "等待 DeepSeek Harness 桥接就绪超时，请检查本机 DSH 配置后重试。".to_string();
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
    std::process::Command::new("/usr/bin/open")
        .arg(&console_url)
        .spawn()
        .map_err(|e| format!("无法在浏览器打开内置 DSH 控制台: {e}"))?;
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
        let g = manager.inner.lock().map_err(|_| "DSH 状态锁异常")?;
        match (g.status.connected, g.status.port, g.token.clone()) {
            (true, Some(p), Some(t)) => (p, t),
            _ => return Err("DeepSeek Harness 尚未连接".into()),
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
        std::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .spawn()
            .map_err(|_| "无法打开浏览器，请稍后重试")?;
        response["opened"] = json!(true);
    }
    if let Some(object) = response.as_object_mut() { object.remove("authorizeUrl"); }
    Ok(response)
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
        std::fs::write(root.join("node/bin/node"), "").unwrap();
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
    }
}
