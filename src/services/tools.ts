import { command as runtimeCommand } from './runtime';

export type CommandFn = (name: string, args?: Record<string, unknown>) => Promise<any>;

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type FileCard =
  | { type: 'file'; state: 'pending'; action: 'write'; root: string; path: string; content: string; summary: string }
  | { type: 'file'; state: 'pending'; action: 'move'; root: string; from: string; to: string; summary: string };

export type ToolCard =
  | FileCard
  | { type: 'reminder'; state: 'pending'; content: string; when: string; repeat: string }
  | { type: 'memory'; state: 'pending'; content: string }
  | { type: 'mcp'; state: 'pending'; service: string; tool: string; arguments: Record<string, unknown>; summary: string };

export type ToolOutcome =
  | { kind: 'result'; name: string; content: string }
  | { kind: 'card'; name: string; card: ToolCard }
  | { kind: 'error'; name: string; message: string };

export interface McpRegistration {
  service: string;
  tool: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** 缺省为每次确认。只有显式 false 才直接调用。 */
  confirm?: boolean;
}

export interface ToolRuntime {
  command: CommandFn;
  weatherSummary: () => string;
  configuredCity?: string;
  userText: string;
  roots: string[];
  allowFolders: boolean;
}

const READ = new Set(['get_weather', 'read_page', 'list_folder', 'read_file']);
const CONFIRM = new Set(['write_file', 'move_file', 'create_reminder', 'remember_preference']);

const empty = { type: 'object', properties: {}, additionalProperties: false };

export function builtinTools(): ToolDef[] {
  return [
    { type: 'function', function: { name: 'get_weather', description: '读取已经配置好的城市天气摘要。不能改查别的城市，也不会发起新的定位。', parameters: empty } },
    { type: 'function', function: { name: 'read_page', description: '读取用户这句话里给出的公开网页正文。只能使用原文中出现的 http 或 https 链接。', parameters: {
      type: 'object', properties: { url: { type: 'string', description: '用户原文中的链接' } }, required: ['url'], additionalProperties: false,
    } } },
    { type: 'function', function: { name: 'list_folder', description: '列出一个已授权知识库文件夹里的条目。path 是相对路径。', parameters: {
      type: 'object', properties: { path: { type: 'string' }, folder: { type: 'string', description: '多个授权文件夹时填写文件夹名' } }, required: ['path'], additionalProperties: false,
    } } },
    { type: 'function', function: { name: 'read_file', description: '读取已授权知识库文件夹内的文本文件。path 是相对路径。', parameters: {
      type: 'object', properties: { path: { type: 'string' }, folder: { type: 'string' } }, required: ['path'], additionalProperties: false,
    } } },
    { type: 'function', function: { name: 'write_file', description: '提出写入草案。用户确认前不会改动文件。', parameters: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, folder: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false,
    } } },
    { type: 'function', function: { name: 'move_file', description: '提出移动草案。用户确认前不会改动文件。', parameters: {
      type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, folder: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false,
    } } },
  ];
}

export function weatherResult(summary: string, requestedCity?: string, configuredCity?: string): string {
  const asked = requestedCity?.trim();
  const city = configuredCity?.trim();
  if (asked && city && asked !== city) return `只能查看已设置的城市（${city}），不会查询其他城市。`;
  if (!summary.trim()) return '还没有可用的天气。请先在设置中打开天气并选择城市。';
  return summary;
}

export function assertPublicPageUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('链接格式无效'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只接受 http 或 https 链接');
  if (url.username || url.password) throw new Error('链接不能包含账号');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isPrivateHost(host)) {
    throw new Error('链接指向内网或保留地址，已拒绝');
  }
  return text;
}

function isPrivateHost(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(n => n > 255)) return true;
    const [a, b, c] = o;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(':')) {
    const h = host.toLowerCase();
    if (h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb') || h.startsWith('fec') || h.startsWith('ff') || h.includes('ffff:')) return true;
  }
  return false;
}

export function pickRoot(roots: string[], folder?: string): string {
  const clean = roots.map(root => root.trim()).filter(Boolean);
  if (!clean.length) throw new Error('还没有授权文件夹');
  const want = folder?.trim();
  if (!want) {
    if (clean.length === 1) return clean[0];
    throw new Error('有多个授权文件夹，需要指明是哪一个');
  }
  const exact = clean.filter(root => root === want);
  if (exact.length === 1) return exact[0];
  const base = clean.filter(root => root.split('/').filter(Boolean).pop() === want);
  if (base.length === 1) return base[0];
  throw new Error('这个文件夹没有授权');
}

function slug(value: string): string {
  const ascii = value.normalize('NFKD').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  return (ascii || 'tool').slice(0, 24);
}

export function exposeMcpTool(service: string, tool: string, used: Set<string>): string {
  const base = `mcp_${slug(service)}_${slug(tool)}`.slice(0, 60);
  let name = base;
  let n = 2;
  while (used.has(name) || READ.has(name) || CONFIRM.has(name)) {
    const suffix = `_${n}`;
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(name);
  return name;
}

export class ToolCatalog {
  private mcp = new Map<string, McpRegistration>();
  constructor(registrations: McpRegistration[] = []) {
    const used = new Set<string>();
    for (const item of registrations) this.add(item, used);
  }
  private add(item: McpRegistration, used: Set<string>) {
    const name = exposeMcpTool(item.service, item.tool, used);
    this.mcp.set(name, item);
  }
  definitions(): ToolDef[] {
    const mcp = [...this.mcp.entries()].map(([name, item]) => ({
      type: 'function' as const,
      function: {
        name,
        description: `工具服务 ${item.service} 的 ${item.tool}。${item.description || ''}`.trim(),
        parameters: item.inputSchema || empty,
      },
    }));
    return [...builtinTools(), ...mcp];
  }
  resolve(name: string): McpRegistration | undefined {
    return this.mcp.get(name);
  }
  async route(name: string, args: Record<string, unknown>, runtime: ToolRuntime): Promise<ToolOutcome> {
    try {
      if (READ.has(name)) return { kind: 'result', name, content: await this.read(name, args, runtime) };
      if (CONFIRM.has(name)) return { kind: 'card', name, card: this.card(name, args, runtime) };
      const mcp = this.mcp.get(name);
      if (!mcp) return { kind: 'error', name, message: '没有这个工具' };
      const arguments_ = asObject(args);
      if (mcp.confirm !== false) {
        return { kind: 'card', name, card: { type: 'mcp', state: 'pending', service: mcp.service, tool: mcp.tool, arguments: arguments_, summary: `调用 ${mcp.service} / ${mcp.tool}` } };
      }
      const content = await runtime.command('mcp_call_tool', { name: mcp.service, tool: mcp.tool, arguments: arguments_ });
      return { kind: 'result', name, content };
    } catch (error) {
      return { kind: 'error', name, message: error instanceof Error ? error.message : String(error) };
    }
  }
  async runConfirmed(card: ToolCard, command: CommandFn = runtimeCommand): Promise<string> {
    if (card.type === 'file' && card.action === 'write') {
      await command('write_file', { roots: [card.root], root: card.root, path: card.path, content: card.content });
      return `已写入 ${card.path}`;
    }
    if (card.type === 'file' && card.action === 'move') {
      await command('move_file', { roots: [card.root], root: card.root, from: card.from, to: card.to });
      return `已移动 ${card.from} 到 ${card.to}`;
    }
    if (card.type === 'mcp') {
      return command('mcp_call_tool', { name: card.service, tool: card.tool, arguments: card.arguments });
    }
    throw new Error('提醒和记忆仍走现有确认流程');
  }
  private async read(name: string, args: Record<string, unknown>, runtime: ToolRuntime): Promise<string> {
    if (name === 'get_weather') return weatherResult(runtime.weatherSummary(), stringArg(args.city), runtime.configuredCity);
    if (name === 'read_page') {
      const url = stringArg(args.url).trim();
      if (!url || !runtime.userText.includes(url)) throw new Error('只能读取用户这句话里给出的链接');
      assertPublicPageUrl(url);
      const page = await runtime.command('read_page', { url });
      const body = page.text || '';
      return `${page.title ? page.title + '\n' : ''}${body}${page.truncated ? '\n（正文已截断）' : ''}`;
    }
    this.ensureFolders(runtime);
    const root = pickRoot(runtime.roots, stringArg(args.folder));
    if (name === 'list_folder') {
      const listed = await runtime.command('list_folder', { roots: runtime.roots, root, path: stringArg(args.path) });
      const entries: Array<{ name: string; kind: string }> = listed.entries || [];
      return entries.map(entry => `${entry.kind === 'dir' ? '目录' : '文件'} ${entry.name}`).join('\n') || '文件夹是空的';
    }
    const file = await runtime.command('read_file', { roots: runtime.roots, root, path: stringArg(args.path) });
    return `${file.path}\n${file.text}${file.truncated ? '\n（内容已截断）' : ''}`;
  }
  private card(name: string, args: Record<string, unknown>, runtime: ToolRuntime): ToolCard {
    if (name === 'create_reminder') {
      return { type: 'reminder', state: 'pending', content: stringArg(args.content).slice(0, 500), when: stringArg(args.when), repeat: stringArg(args.repeat) || '仅一次' };
    }
    if (name === 'remember_preference') {
      const content = stringArg(args.content).trim();
      if (!content) throw new Error('没有可以记住的内容');
      return { type: 'memory', state: 'pending', content: content.slice(0, 500) };
    }
    this.ensureFolders(runtime);
    const root = pickRoot(runtime.roots, stringArg(args.folder));
    if (name === 'write_file') {
      const path = stringArg(args.path);
      const content = String(args.content ?? '');
      return { type: 'file', state: 'pending', action: 'write', root, path, content, summary: `写入 ${path}` };
    }
    const from = stringArg(args.from);
    const to = stringArg(args.to);
    return { type: 'file', state: 'pending', action: 'move', root, from, to, summary: `移动 ${from} 到 ${to}` };
  }
  private ensureFolders(runtime: ToolRuntime) {
    if (!runtime.allowFolders) throw new Error('还没有允许读取已授权文件夹');
  }
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asObject(args: Record<string, unknown>): Record<string, unknown> {
  return args && typeof args === 'object' ? args : {};
}
