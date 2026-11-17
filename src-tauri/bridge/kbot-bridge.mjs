import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const name = "kbot-bridge";
export const inject = ["workspaceRegistry", "sessionController"];

const BRIDGE_VERSION = "1.5.7";

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
  if (sensors.nickname) lines.push(`用户称呼: ${sensors.nickname}`);
  if (sensors.persona) lines.push(`补充性格偏好: ${sensors.persona}`);
  if (sensors.away === true) {
    lines.push("桌面状态: 用户暂时离开电脑前");
  } else if (sensors.away === false) {
    lines.push("桌面状态: 用户正在电脑前活跃");
  }
  if (sensors.frontmostCategory) {
    const appSuffix = sensors.frontmostApp ? ` (${sensors.frontmostApp})` : "";
    lines.push(`前台场景: ${sensors.frontmostCategory}${appSuffix}`);
  }
  if (sensors.dnd) {
    lines.push(`勿扰模式: 开启${sensors.dndLabel ? ` (${sensors.dndLabel})` : ""}`);
  }
  if (sensors.date) lines.push(`当前日期: ${sensors.date}`);
  if (sensors.time) {
    lines.push(`当地时间: ${sensors.time}${sensors.timeZone ? ` (${sensors.timeZone})` : ""}`);
  }
  if (sensors.city) lines.push(`所在地: ${sensors.city}`);
  if (sensors.language) lines.push(`界面语言: ${sensors.language}`);
  if (sensors.weather) {
    lines.push(`当地天气: ${sensors.weather}`);
  }
  if (lines.length === 0) return "";
  return `<kbot_desktop_context>\n${lines.join("\n")}\n</kbot_desktop_context>`;
}

function signalText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return [
    value.reason,
    value.stopReason,
    value.stop_reason,
    value.code,
    value.type,
    value.name,
    value.message,
    value.refusal === true ? "refusal" : "",
    value.error && value.error.code,
    value.error && value.error.message,
  ].filter(Boolean).join(" ");
}

function refusalOf(value) {
  return /\brefusal\b|content[_-]filter|safety_check|model_refusal/i.test(signalText(value));
}

function titleOf(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value.title || value.sessionTitle || value.conversationTitle;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 40) : null;
}

function extractSourcesFromToolResult(data) {
  const meta = data?.meta;
  if (!meta || typeof meta !== "object") return undefined;
  const rawList = Array.isArray(meta.sources)
    ? meta.sources
    : (typeof meta.url === "string" && meta.url ? [{ url: meta.url, title: meta.title }] : null);
  if (!rawList || rawList.length === 0) return undefined;
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const rawUrl = typeof item?.url === "string" ? item.url.trim() : "";
    if (!/^https?:\/\//i.test(rawUrl) || seen.has(rawUrl)) continue;
    seen.add(rawUrl);
    let site = "";
    try {
      site = new URL(rawUrl).hostname.replace(/^www\./i, "");
    } catch {}
    const title = typeof item?.title === "string" && item.title.trim() ? item.title.trim() : site || rawUrl;
    out.push({ url: rawUrl, title, site: site || title });
    if (out.length >= 12) break;
  }
  return out.length ? out : undefined;
}

const TITLE_REQUEST = `<kbot_title_request>
这是本会话的第一条用户消息。回答正文之后另起一行，只写 [[title:不超过14个字]]，概括这件事。不要引号，不要解释。界面会删掉这一行。之后的回复不要再写这个标记。
</kbot_title_request>`;

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

const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$defs",
  "definitions",
  "examples",
  "if",
  "then",
  "else",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
]);

const SANITIZE_TRIGGER_KEYWORDS = new Set([
  ...UNSUPPORTED_SCHEMA_KEYWORDS,
  "$ref",
  "const",
  "oneOf",
  "allOf",
  "prefixItems",
]);

const SCHEMA_SANITIZER_MARK = Symbol.for("kbot.bridge.definitionsSanitized");
const sanitizedSchemaCache = new WeakMap();

function schemaNeedsSanitization(node, seen = new WeakSet()) {
  if (!node || typeof node !== "object") return false;
  if (seen.has(node)) return true;
  seen.add(node);
  if (Array.isArray(node)) {
    return node.some((item) => schemaNeedsSanitization(item, seen));
  }
  for (const [k, v] of Object.entries(node)) {
    if (SANITIZE_TRIGGER_KEYWORDS.has(k)) return true;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const propSchema of Object.values(v)) {
        if (schemaNeedsSanitization(propSchema, seen)) return true;
      }
      continue;
    }
    if (v && typeof v === "object" && schemaNeedsSanitization(v, seen)) return true;
  }
  return false;
}

function resolveSchemaPointer(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = root;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function sanitizeSchemaNode(node, root, activeRefs = new Set(), depth = 0) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeSchemaNode(item, root, activeRefs, depth + 1));
  }
  if (depth > 40) return { type: "object", additionalProperties: true };

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const rest = {};
    for (const [k, v] of Object.entries(node)) {
      if (k !== "$ref" && !UNSUPPORTED_SCHEMA_KEYWORDS.has(k)) {
        rest[k] = v;
      }
    }
    if (activeRefs.has(ref)) {
      const fallback = { type: "object", additionalProperties: true };
      if (typeof rest.description === "string") fallback.description = rest.description;
      return fallback;
    }
    const target = resolveSchemaPointer(root, ref);
    if (target && typeof target === "object") {
      const nextRefs = new Set(activeRefs);
      nextRefs.add(ref);
      return sanitizeSchemaNode({ ...target, ...rest }, root, nextRefs, depth + 1);
    }
    const unresolved = Object.keys(rest).length ? rest : { type: "object", additionalProperties: true };
    return sanitizeSchemaNode(unresolved, root, activeRefs, depth + 1);
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(k) || k === "$ref") continue;
    if (k === "const") {
      if (out.enum === undefined && v !== undefined) out.enum = [v];
      if (out.type === undefined && node.type === undefined) {
        if (v === null) out.type = "null";
        else if (Array.isArray(v)) out.type = "array";
        else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out.type = typeof v;
        }
      }
      continue;
    }
    if (k === "prefixItems" && Array.isArray(v)) {
      if (out.items === undefined && node.items === undefined && v.length > 0) {
        const items = v.map((item) => sanitizeSchemaNode(item, root, activeRefs, depth + 1));
        out.items = items.length === 1 ? items[0] : { anyOf: items };
      }
      continue;
    }
    if (k === "oneOf" && Array.isArray(v)) {
      if (node.anyOf === undefined && out.anyOf === undefined) {
        out.anyOf = v.map((branch) => sanitizeSchemaNode(branch, root, activeRefs, depth + 1));
      }
      continue;
    }
    if (k === "allOf" && Array.isArray(v)) {
      for (const branch of v) {
        const cleanBranch = sanitizeSchemaNode(branch, root, activeRefs, depth + 1);
        if (!cleanBranch || typeof cleanBranch !== "object" || Array.isArray(cleanBranch)) continue;
        if (cleanBranch.properties && typeof cleanBranch.properties === "object") {
          out.properties = { ...(out.properties || {}), ...cleanBranch.properties };
        }
        if (Array.isArray(cleanBranch.required)) {
          out.required = [...new Set([...(out.required || []), ...cleanBranch.required])];
        }
        if (out.type === undefined && cleanBranch.type !== undefined) {
          out.type = cleanBranch.type;
        }
      }
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) {
        props[pk] = sanitizeSchemaNode(pv, root, activeRefs, depth + 1);
      }
      out.properties = props;
      continue;
    }
    out[k] = sanitizeSchemaNode(v, root, activeRefs, depth + 1);
  }
  return out;
}

const MAX_TOOL_SCHEMA_BYTES = 8192;

function compactSchemaDepth(node, maxDepth, depth = 0, stripNestedMeta = true) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => compactSchemaDepth(item, maxDepth, depth + 1, stripNestedMeta));
  if (depth >= maxDepth) {
    const desc = typeof node.description === "string" ? node.description : undefined;
    if (node.type === "array") {
      return { type: "array", items: {}, ...(desc ? { description: desc } : {}) };
    }
    if (node.type === "object" || node.properties) {
      return { type: "object", additionalProperties: true, ...(desc ? { description: desc } : {}) };
    }
    if (typeof node.type === "string") {
      return { type: node.type, ...(desc ? { description: desc } : {}) };
    }
    return { ...(desc ? { description: desc } : {}) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (stripNestedMeta && depth > 1 && (k === "description" || k === "pattern" || k === "default" || k === "title")) {
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) {
        props[pk] = compactSchemaDepth(pv, maxDepth, depth + 1, stripNestedMeta);
      }
      out.properties = props;
      continue;
    }
    if ((k === "anyOf" || k === "items") && v && typeof v === "object") {
      out[k] = compactSchemaDepth(v, maxDepth, depth + 1, stripNestedMeta);
      continue;
    }
    out[k] = compactSchemaDepth(v, maxDepth, depth + 1, stripNestedMeta);
  }
  return out;
}

function sanitizeToolParametersForLlm(parameters) {
  if (!parameters || typeof parameters !== "object") return parameters;
  if (sanitizedSchemaCache.has(parameters)) return sanitizedSchemaCache.get(parameters);
  let result = schemaNeedsSanitization(parameters)
    ? sanitizeSchemaNode(parameters, parameters)
    : parameters;
  try {
    if (JSON.stringify(result).length > MAX_TOOL_SCHEMA_BYTES) {
      for (const maxDepth of [4, 3, 2, 1]) {
        const candidate = compactSchemaDepth(result, maxDepth, 0, true);
        result = candidate;
        if (JSON.stringify(result).length <= MAX_TOOL_SCHEMA_BYTES) break;
      }
    }
  } catch {}
  sanitizedSchemaCache.set(parameters, result);
  return result;
}

const MCP_TOOL_PREFIX = "mcp__";
const mcpServerOf = (toolName) => String(toolName || "").split("__")[1] || "";
const isMcpTool = (toolName) => String(toolName || "").startsWith(MCP_TOOL_PREFIX);

async function loadDshTools() {
  const candidates = [];
  try {
    candidates.push(pathToFileURL(path.resolve(path.dirname(process.argv[1]), "../../dsh-tools/lib/index.js")).href);
  } catch {}
  candidates.push("@deepseek-ai/dsh-tools");
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (typeof mod.defineTool === "function") return mod;
    } catch {}
  }
  return null;
}

// MCP tools are invisible to the model until it asks for them through the small `mcp_load`
// gateway tool, so everyday chat does not pay for hundreds of tool schemas on every turn.
function createLazyMcpGate(dshTools) {
  const { defineTool, ToolArgsError, ToolContextUnavailableError } = dshTools;
  const enabled = new WeakMap();

  const serversOf = (names) => {
    const servers = new Map();
    for (const name of names) {
      if (!isMcpTool(name)) continue;
      const server = mcpServerOf(name);
      if (!server) continue;
      if (!servers.has(server)) servers.set(server, []);
      servers.get(server).push(name);
    }
    return servers;
  };
  const visibleNames = (tools, agent) => {
    try { return [...tools.view(agent).visible.keys()]; } catch { return []; }
  };
  const describeServers = (servers) =>
    [...servers].map(([server, names]) => `${server}(${names.length} 个工具，如 ${names.slice(0, 3).map((n) => n.slice(MCP_TOOL_PREFIX.length + server.length + 2)).join("、")})`).join("；");

  const admits = (agent, toolName) => {
    if (!isMcpTool(toolName)) return true;
    const set = enabled.get(agent);
    return Boolean(set && set.has(mcpServerOf(toolName)));
  };

  const register = (tools) => {
    const baseDescription = "按需加载外部 MCP 工具服务。默认不加载；只有内置工具（bash、读写文件、搜索等）完成不了、确实需要外部服务的能力时才调用。加载后这些工具从下一步起可用。";
    const definition = defineTool({
      name: "mcp_load",
      description: baseDescription,
      parameters: {
        server: { type: "string", description: "要加载的服务名；省略则加载全部可用服务。" },
        unload: { type: "boolean", description: "为 true 时卸载（省略 server 则全部卸载）。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { message: { type: "string", required: true, description: "加载结果说明。" } },
        },
        render: (_args, value) => [{ type: "text", text: value.message }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        if (agent === undefined) throw new ToolContextUnavailableError("mcp_load requires an agent Session");
        const servers = serversOf(visibleNames(tools, agent));
        if (!servers.size) return { message: "当前没有可加载的外部工具服务。" };
        const target = args.server ? String(args.server) : null;
        if (target && !servers.has(target)) {
          throw new ToolArgsError([`unknown server "${target}"; available: ${[...servers.keys()].join(", ")}`]);
        }
        const set = enabled.get(agent) || new Set();
        enabled.set(agent, set);
        const picked = target ? [target] : [...servers.keys()];
        for (const server of picked) args.unload ? set.delete(server) : set.add(server);
        if (args.unload) return { message: `已卸载：${picked.join("、")}。` };
        const names = picked.flatMap((server) => servers.get(server));
        return { message: `已加载 ${picked.join("、")}，共 ${names.length} 个工具，下一步起可调用：${names.slice(0, 30).join(", ")}${names.length > 30 ? " …" : ""}` };
      },
    });
    Object.defineProperty(definition, "description", {
      enumerable: true,
      configurable: true,
      get() {
        const servers = serversOf(visibleNames(tools, undefined));
        return servers.size ? `${baseDescription}可用服务：${describeServers(servers)}。` : baseDescription;
      },
    });
    return definition;
  };

  return { admits, register };
}

function installToolSchemaSanitizer(ctx, { lazyMcp = null } = {}) {
  const gate = lazyMcp ? createLazyMcpGate(lazyMcp) : null;
  const wrapToolsService = (toolsSvc) => {
    if (!toolsSvc || typeof toolsSvc.definitions !== "function") return;
    const proto =
      toolsSvc.constructor?.prototype && typeof toolsSvc.constructor.prototype.definitions === "function"
        ? toolsSvc.constructor.prototype
        : Object.getPrototypeOf(toolsSvc);
    if (!proto || typeof proto.definitions !== "function" || proto[SCHEMA_SANITIZER_MARK]) return;
    const origDefinitions = proto.definitions;
    proto[SCHEMA_SANITIZER_MARK] = true;
    proto.definitions = function sanitizedDefinitions(...args) {
      const defs = origDefinitions.apply(this, args);
      if (!Array.isArray(defs)) return defs;
      return defs.map((def) => {
        if (!def || typeof def !== "object" || def.name === "run_code" || !def.parameters) return def;
        const cleanParams = sanitizeToolParametersForLlm(def.parameters);
        return cleanParams === def.parameters ? def : { ...def, parameters: cleanParams };
      });
    };
    if (gate && typeof proto.resolve === "function") {
      const origResolve = proto.resolve;
      proto.resolve = async function gatedResolve(context) {
        const selection = await origResolve.call(this, context);
        const agent = context?.agent;
        if (!selection || agent === undefined) return selection;
        return Object.freeze({
          dispose: () => selection.dispose(),
          view: (scope) => {
            const visible = selection.view(scope);
            if (scope !== agent) return visible;
            const out = new Map();
            for (const [name, def] of visible) if (gate.admits(agent, name)) out.set(name, def);
            return out;
          },
        });
      };
    }
  };
  wrapToolsService(ctx.get?.("tools") ?? ctx.tools ?? null);
  try {
    ctx.inject?.(["tools"], (scope) => {
      wrapToolsService(scope.tools);
      if (!gate) return;
      try { scope.tools.register(gate.register(scope.tools)); } catch {}
    });
  } catch {}
}

export async function apply(ctx, config = {}) {
  const preferredPort = Number.isInteger(config.port) ? config.port : 37891;
  const hostKind = config.hostKind || (preferredPort === 0 ? "managed" : "external");
  const lazyMcp = hostKind === "managed" && process.env.KBOT_ALLOW_MCP !== "1" ? await loadDshTools() : null;
  installToolSchemaSanitizer(ctx, { lazyMcp });
  const bridgeDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "kbot-bridge");
  await fsp.mkdir(bridgeDir, { recursive: true });
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

  const prefsFile = path.join(bridgeDir, "prefs.json");
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8")) || {}; } catch {}
  const savePrefs = () => {
    try { fs.writeFileSync(prefsFile, JSON.stringify(prefs), { mode: 0o600 }); } catch {}
  };
  // KBOT is a chat companion: default to no extended thinking (first token in seconds, not tens of
  // seconds). The user's explicit pick is persisted and wins whenever the model supports it.
  const wantedEffort = (reasoning) => {
    const ids = (reasoning?.efforts || []).map((e) => e.id);
    if (!ids.length) return null;
    if (prefs.reasoningEffort && ids.includes(prefs.reasoningEffort)) return prefs.reasoningEffort;
    return ids.includes("off") ? "off" : null;
  };

  const getLlm = () => ctx.get?.("llm") ?? ctx.llm ?? null;
  const getDefaultModelSvc = () => ctx.get?.("agentDefaultModel") ?? ctx.agentDefaultModel ?? null;
  const getUserQuestionsSvc = () => ctx.get?.("userQuestions") ?? ctx.userQuestions ?? null;
  const getAccount = () => ctx.get?.("deepseekAccount") ?? ctx.deepseekAccount ?? null;

  const cloudState = {
    enabled: false,
    baseURL: "",
    token: "",
    registered: false,
  };
  let cloudModCache = null;
  async function loadDeepSeekAdapterMod() {
    if (cloudModCache) return cloudModCache;
    try {
      const req = createRequire(process.argv[1] || import.meta.url);
      const resolved = req.resolve("@deepseek-ai/dsh-llm-deepseek");
      cloudModCache = await import(pathToFileURL(resolved).href);
      return cloudModCache;
    } catch {
      return null;
    }
  }
  async function ensureCloudProviderRegistered() {
    if (cloudState.registered) return true;
    if (!getLlm()) return false;
    const mod = await loadDeepSeekAdapterMod();
    if (!mod?.registerDeepSeekProvider || !mod?.resolveAdapterOptions || !mod?.Config) return false;
    const buildConnection = () => {
      const parsed = mod.Config.parse({
        baseURL: cloudState.baseURL || mod.PUBLIC_BASE_URL,
      });
      return mod.resolveAdapterOptions(mod.plainOptions(parsed), { get: () => undefined });
    };
    const buildView = () => {
      const conn = buildConnection();
      return {
        ...conn,
        offered: conn.models,
        refusals: new Map(),
        badges: new Map(),
      };
    };
    mod.registerDeepSeekProvider(ctx, "kbot-cloud", {
      providerName: "KBOT 云托管",
      options: buildView,
      connect: async () => buildView(),
      resolveAuth: async () => {
        if (!cloudState.enabled || !cloudState.token) {
          throw new Error("KBOT 云托管未配置或未开启");
        }
        return { headers: { "x-api-key": cloudState.token } };
      },
      admit: () => {},
      discoverModels: async (provider) => {
        if (!cloudState.enabled || !cloudState.token || !cloudState.baseURL) return [];
        const conn = buildConnection();
        return conn.models.map((m) => mod.catalogModelInfo(provider, m));
      },
    });
    cloudState.registered = true;
    return true;
  }
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

  function serializeReasoning(info) {
    const efforts = Array.isArray(info?.reasoning?.efforts)
      ? info.reasoning.efforts
          .filter((e) => e && e.id != null)
          .map((e) => ({
            id: String(e.id),
            name: String(e.name || e.id),
            ...(e.description ? { description: String(e.description) } : {}),
          }))
      : [];
    if (!efforts.length) return null;
    return {
      efforts,
      ...(info?.reasoning?.defaultEffort ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}),
    };
  }

  const lookupCachedModelMeta = (providerId, modelId) => {
    const p = String(providerId || "");
    const m = String(modelId || "");
    if (!m) return { displayName: null, providerName: p || null, reasoning: null };
    const hit = modelDisplayCache.get(`${p}::${m}`);
    if (hit) return hit;
    for (const [key, val] of modelDisplayCache.entries()) {
      if (key.endsWith(`::${m}`)) return val;
    }
    return {
      displayName: fallbackModelDisplayName(m) || m,
      providerName: p || null,
      reasoning: null,
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
              let reasoning = null;
              if (typeof llm.resolveModelInfo === "function") {
                try {
                  const info = await llm.resolveModelInfo(provider.id, m.id);
                  if (!resolvedName && info?.name) resolvedName = info.name;
                  reasoning = serializeReasoning(info);
                } catch {}
              }
              const displayName = resolvedName || fallbackModelDisplayName(m.id) || String(m.id);
              modelDisplayCache.set(`${provider.id}::${m.id}`, {
                displayName,
                providerName: provider.name || provider.id,
                reasoning,
              });
              return {
                id: String(m.id),
                name: displayName,
                description: m?.description || "",
                ...(reasoning ? { reasoning } : {}),
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
    let reasoning = null;
    if (llm) {
      try {
        const prov = (llm.listProviders?.() || []).find((item) => item.id === p);
        if (prov?.name) providerName = String(prov.name);
      } catch {}
      if (p && typeof llm.resolveModelInfo === "function") {
        try {
          const info = await llm.resolveModelInfo(p, m);
          if (info?.name) displayName = String(info.name);
          reasoning = serializeReasoning(info);
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
    const cached = lookupCachedModelMeta(p, m);
    if (!displayName) {
      displayName = cached.displayName || fallbackModelDisplayName(m) || m;
    }
    if (!reasoning && cached.reasoning) {
      reasoning = cached.reasoning;
    }
    if (p && m) {
      modelDisplayCache.set(`${p}::${m}`, { displayName, providerName, reasoning });
    }
    return { provider: p || null, providerName, model: m, displayName, reasoning };
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
        } else if (chunk.type === "refusal" || refusalOf(chunk)) {
          broadcast({ type: "stream/refusal", sessionId });
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
        refusal: refusalOf(error),
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
        case "turn/end": {
          const data = event.data || {};
          const reason = data.reason || data.stopReason || data.stop_reason || null;
          broadcast({
            type: "turn/end",
            sessionId,
            turn: data.turn,
            reason,
            title: titleOf(data) || titleOf(data.turn) || titleOf(data.message),
            refusal: refusalOf(data) || refusalOf({ reason }),
          });
          break;
        }
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
        case "tool/result": {
          const isError = Boolean(event.data?.message?.isError);
          const sources = isError ? undefined : extractSourcesFromToolResult(event.data);
          const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
          const rawText = blocks
            .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
            .map((b) => b.text.trim())
            .join("\n")
            .trim();
          const output = rawText
            ? rawText.length > 800
              ? `${rawText.slice(0, 800).trimEnd()}…`
              : rawText
            : undefined;
          broadcast({
            type: "tool/result",
            sessionId,
            callId:
              event.data?.message?.toolCallId ||
              event.data?.message?.callId ||
              event.data?.callId ||
              null,
            isError,
            ...(output ? { output } : {}),
            ...(sources ? { sources } : {}),
          });
          break;
        }
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
          const stopReason = msg?.stopReason || msg?.stop_reason || event.data?.stopReason || null;
          broadcast({
            type: "assistant/message",
            sessionId,
            text,
            interrupted: Boolean(event.data?.interrupted),
            model: srcModel,
            provider: srcProvider,
            displayName: meta.displayName,
            providerName: meta.providerName,
            stopReason,
            title: titleOf(msg) || titleOf(event.data),
            refusal: refusalOf(msg) || refusalOf(event.data) || refusalOf({ stopReason }),
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

  function readAgentSelection(agent) {
    if (!agent) return null;
    try {
      if (typeof agent.model?.current === "function") return agent.model.current() || null;
    } catch {}
    try {
      return ctx.sessionController.agents.selectionFor?.(agent)?.current || null;
    } catch {
      return null;
    }
  }

  function writeAgentSelection(agent, selection) {
    if (!agent || !selection?.provider || !selection?.model) return null;
    const next = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
    try {
      if (typeof agent.model?.select === "function") {
        agent.model.select(next);
        return readAgentSelection(agent) || next;
      }
    } catch {}
    try {
      ctx.sessionController.agents.selectForNextRequest?.(agent, next);
      return readAgentSelection(agent) || next;
    } catch {
      return null;
    }
  }

  async function resolveCurrentModel(sessionId) {
    try {
      const sid = String(sessionId || "");
      const defaultSel = getDefaultModelSvc()?.currentSelection?.() || null;
      const defaultKey =
        defaultSel?.provider && defaultSel?.model
          ? `${defaultSel.provider}::${defaultSel.model}::${defaultSel.reasoningEffort || ""}`
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
          return {
            ...meta,
            reasoningEffort: wantedEffort(meta?.reasoning) ?? defaultSel.reasoningEffort ?? meta?.reasoning?.defaultEffort ?? null,
          };
        }
        return null;
      }

      let sel = readAgentSelection(agent);
      const manual = manualSessionModels.get(sid) || null;
      const isRoutable = (prov) =>
        Boolean(prov) && (routableProviders.size === 0 || routableProviders.has(String(prov)));

      let desired = null;
      if (manual?.provider && manual?.model && isRoutable(manual.provider)) {
        if (
          !sel ||
          sel.provider !== manual.provider ||
          sel.model !== manual.model ||
          (sel.reasoningEffort ?? null) !== (manual.reasoningEffort ?? null)
        ) {
          desired = manual;
        }
      } else if (
        defaultSel?.provider &&
        defaultSel?.model &&
        isRoutable(defaultSel.provider) &&
        (
          !sel?.model ||
          !isRoutable(sel.provider) ||
          (!manual && (
            sel.provider !== defaultSel.provider ||
            sel.model !== defaultSel.model
          ))
        )
      ) {
        desired = defaultSel;
      } else if ((!sel?.model || !isRoutable(sel.provider)) && groups.length > 0 && groups[0].models.length > 0) {
        desired = { provider: groups[0].id, model: groups[0].models[0].id };
      }

      if (desired?.provider && desired?.model) {
        sel = writeAgentSelection(agent, desired) || desired;
      }

      if (!sel?.model) return null;
      const meta = await resolveCatalogEntry(sel.provider, sel.model);
      const want = wantedEffort(meta?.reasoning);
      if (want && sel.reasoningEffort !== want) {
        const next = { provider: sel.provider, model: sel.model, reasoningEffort: want };
        sel = writeAgentSelection(agent, next) || next;
      }
      return {
        provider: sel.provider,
        providerName: meta?.providerName || sel.provider || null,
        model: sel.model,
        displayName: meta?.displayName || fallbackModelDisplayName(sel.model) || sel.model,
        reasoningEffort: sel.reasoningEffort ?? meta?.reasoning?.defaultEffort ?? null,
        reasoning: meta?.reasoning ?? null,
      };
    } catch {
      return null;
    }
  }

  async function enforceEffort(sessionId) {
    const res = await ctx.sessionController.agents.resolveAgent(sessionId);
    const agent = res?.agent ?? res;
    if (!agent || res?.error) return;
    const sel = readAgentSelection(agent);
    if (!sel?.model) return;
    const meta = await resolveCatalogEntry(sel.provider, sel.model);
    const want = wantedEffort(meta?.reasoning);
    if (want && sel.reasoningEffort !== want) {
      writeAgentSelection(agent, { provider: sel.provider, model: sel.model, reasoningEffort: want });
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
        let text = typeof body.text === "string" ? body.text : "";
        if (body.wantTitle && text.trim()) {
          text = `${text}\n\n${TITLE_REQUEST}`;
        }
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
        try { await enforceEffort(sessionId); } catch {}
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

      if (url.pathname === "/cloud/configure") {
        const nextEnabled = Boolean(body.enabled && body.baseURL && body.token);
        cloudState.enabled = nextEnabled;
        cloudState.baseURL = nextEnabled ? String(body.baseURL).trim() : "";
        cloudState.token = nextEnabled ? String(body.token).trim() : "";
        const supported = nextEnabled ? await ensureCloudProviderRegistered() : cloudState.registered;
        sendJson(res, 200, { ok: true, enabled: cloudState.enabled, supported });
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
        if (body.reasoningEffort) {
          prefs.reasoningEffort = String(body.reasoningEffort);
          savePrefs();
        }
        const pickedMeta = await resolveCatalogEntry(provider, model);
        const pickedEffort = wantedEffort(pickedMeta?.reasoning);
        const selected = {
          provider,
          model,
          ...(pickedEffort ? { reasoningEffort: pickedEffort } : {}),
        };
        if (sessionId) {
          manualSessionModels.set(sessionId, selected);
          try {
            const resolved = await ctx.sessionController.agents.resolveAgent(sessionId);
            const agent = resolved?.agent ?? resolved;
            if (agent && !resolved?.error) {
              writeAgentSelection(agent, selected);
            }
          } catch {}
        }
        try {
          await getDefaultModelSvc()?.saveSelection?.(selected);
          lastObservedDefaultKey = `${provider}::${model}::${selected.reasoningEffort || ""}`;
        } catch {}
        const meta = await resolveCatalogEntry(provider, model);
        sendJson(res, 200, {
          ok: true,
          model: {
            provider,
            providerName: meta?.providerName || provider,
            model,
            displayName: meta?.displayName || fallbackModelDisplayName(model) || model,
            reasoningEffort: selected.reasoningEffort ?? meta?.reasoning?.defaultEffort ?? null,
            reasoning: meta?.reasoning ?? null,
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
