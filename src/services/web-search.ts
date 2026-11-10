export interface ModelConfig {
  provider: string;
  base?: string;
  model?: string;
  hasKey?: boolean;
}

interface AIConfig {
  chat: ModelConfig;
  search: { provider: string; hasKey?: boolean; protocol?: string };
}

export type WebSearchMode = 'none' | 'deepseek' | 'qwen' | 'responses' | 'tavily' | 'brave';

function builtinProtocol(chat: ModelConfig, protocol = 'auto') {
  if (protocol !== 'auto') return protocol;
  if (chat.provider === 'deepseek' || chat.provider === 'qwen') return chat.provider;
  if (chat.provider === 'openai' || chat.provider === 'grok') return 'responses';
  try {
    const host = new URL(chat.base || '').hostname;
    if (host === 'api.deepseek.com') return 'deepseek';
    if (host === 'api.openai.com' || host === 'api.x.ai') return 'responses';
    if (/(^|\.)(dashscope\.aliyuncs\.com|maas\.aliyuncs\.com)$/.test(host)) return 'qwen';
  } catch { /* The address field explains invalid URLs. */ }
  return 'none';
}

export function isOfficialDeepSeek(base = '') {
  try {
    const url = new URL(base.trim());
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password &&
      !url.search && !url.hash && ['', '/v1'].includes(url.pathname.replace(/\/$/, ''));
  } catch { return false; }
}

export function webSearchState({ chat, search }: AIConfig): { available: boolean; mode: WebSearchMode; reason: string } {
  const unavailable = (reason: string) => ({ available: false, mode: 'none' as const, reason });
  if (search.provider === 'builtin') {
    if (!chat.hasKey || !chat.model?.trim()) return unavailable('请先在设置 → AI 中保存对话模型的 API Key 和模型名');
    const protocol = builtinProtocol(chat, search.protocol);
    if (protocol === 'deepseek') {
      if (!isOfficialDeepSeek(chat.base)) return unavailable('DeepSeek 自带联网需要官方 API 地址 https://api.deepseek.com/v1；中转服务可选择 Tavily 或 Brave Search');
      return { available: true, mode: 'deepseek', reason: '' };
    }
    if (protocol === 'qwen' || protocol === 'responses') return { available: true, mode: protocol, reason: '' };
    return unavailable('请在设置 → AI → 联网搜索中选择服务商的联网接口格式，或改用 Tavily / Brave Search');
  }
  if (search.provider === 'tavily' || search.provider === 'brave') {
    if (!search.hasKey) return unavailable(`请在设置 → AI → 联网搜索中保存 ${search.provider === 'tavily' ? 'Tavily' : 'Brave Search'} 的 API Key`);
    return { available: true, mode: search.provider, reason: '' };
  }
  return unavailable('请先在设置 → AI → 联网搜索中选择搜索服务');
}

export function citationLinks(text: string, citations: any[] = [], sources: any[] = []) {
  const chars = Array.from(text);
  const edits = citations.filter(c => Number.isInteger(c.startIndex) && Number.isInteger(c.endIndex) &&
    c.startIndex >= 0 && c.endIndex >= c.startIndex && c.endIndex <= chars.length && /^https?:\/\//.test(c.url))
    .sort((a, b) => b.startIndex - a.startIndex);
  let boundary = chars.length;
  for (const c of edits) {
    if (c.endIndex > boundary) continue;
    const cited = chars.slice(c.startIndex, c.endIndex).join('');
    if (/\]\(https?:\/\//.test(cited)) continue; // Grok already emits clickable Markdown.
    const number = sources.findIndex(s => s.url === c.url) + 1;
    if (!number) continue;
    const link = `[${number}](${c.url.replace(/[()\s]/g, (ch: string) => encodeURIComponent(ch))})`;
    const marker = /^\s*(?:cite[\s\S]*|\[\d+\])\s*$/.test(cited);
    chars.splice(marker ? c.startIndex : c.endIndex, marker ? c.endIndex - c.startIndex : 0, ...Array.from(link));
    boundary = c.startIndex;
  }
  return chars.join('');
}
