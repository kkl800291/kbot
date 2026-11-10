import { describe, expect, it } from 'vitest';
import { ToolCatalog, assertPublicPageUrl, exposeMcpTool, weatherResult, type ToolRuntime } from '../src/services/tools';

function runtime(partial: Partial<ToolRuntime> = {}): { runtime: ToolRuntime; calls: Array<{ name: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const command = async (name: string, args?: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'read_page') return { title: '文档', text: '正文', url: args?.url, truncated: false };
    if (name === 'list_folder') return { entries: [{ name: 'a.md', kind: 'file' }], truncated: false };
    if (name === 'read_file') return { path: 'a.md', text: '文件内容', truncated: false };
    if (name === 'mcp_call_tool') return `called ${args?.tool}`;
    return {};
  };
  return {
    calls,
    runtime: {
      command,
      weatherSummary: () => '上海市，晴，18–26°C。',
      configuredCity: '上海市',
      userText: '帮我看 https://example.com/docs',
      roots: ['/Users/z/notes'],
      allowFolders: true,
      ...partial,
    },
  };
}

describe('local tool routing', () => {
  it('returns configured weather and refuses another city without a new request', async () => {
    expect(weatherResult('上海市，晴。', '北京市', '上海市')).toContain('不会查询其他城市');
    const { runtime: rt, calls } = runtime();
    const catalog = new ToolCatalog();
    const outcome = await catalog.route('get_weather', { city: '上海市' }, rt);
    expect(outcome).toMatchObject({ kind: 'result', content: '上海市，晴，18–26°C。' });
    expect(calls).toEqual([]);
  });

  it('rejects private urls before calling rust and only reads a link from the user text', async () => {
    expect(() => assertPublicPageUrl('http://127.0.0.1/secret')).toThrow(/拒绝/);
    expect(() => assertPublicPageUrl('file:///etc/passwd')).toThrow(/http/);
    const { runtime: rt, calls } = runtime();
    const catalog = new ToolCatalog();
    const blocked = await catalog.route('read_page', { url: 'http://10.0.0.8/a' }, rt);
    expect(blocked.kind).toBe('error');
    const absent = await catalog.route('read_page', { url: 'https://example.com/other' }, rt);
    expect(absent.kind).toBe('error');
    const ok = await catalog.route('read_page', { url: 'https://example.com/docs' }, rt);
    expect(ok).toMatchObject({ kind: 'result', content: expect.stringContaining('正文') });
    expect(calls).toEqual([{ name: 'read_page', args: { url: 'https://example.com/docs' } }]);
  });

  it('does not touch disk for a write until the card is confirmed', async () => {
    const { runtime: rt, calls } = runtime();
    const catalog = new ToolCatalog();
    const card = await catalog.route('write_file', { path: 'a.md', content: '新内容' }, rt);
    expect(card).toMatchObject({ kind: 'card', card: { type: 'file', action: 'write', path: 'a.md', content: '新内容', state: 'pending' } });
    expect(calls).toEqual([]);
    if (card.kind !== 'card' || card.card.type !== 'file') throw new Error('expected file card');
    await catalog.runConfirmed(card.card, rt.command);
    expect(calls).toEqual([{ name: 'write_file', args: { roots: ['/Users/z/notes'], root: '/Users/z/notes', path: 'a.md', content: '新内容' } }]);
  });

  it('keeps folder tools closed until the switch is on and keeps reminder cards local', async () => {
    const closed = runtime({ allowFolders: false });
    const catalog = new ToolCatalog();
    const denied = await catalog.route('read_file', { path: 'a.md' }, closed.runtime);
    expect(denied).toMatchObject({ kind: 'error' });
    expect(closed.calls).toEqual([]);
    const reminder = await catalog.route('create_reminder', { content: '喝水', when: '09:00', repeat: '每天' }, closed.runtime);
    expect(reminder).toMatchObject({ kind: 'card', card: { type: 'reminder', content: '喝水' } });
    expect(closed.calls).toEqual([]);
  });
});

describe('mcp tool names', () => {
  it('prefixes service tools and does not call until a read-only service is marked', async () => {
    const used = new Set<string>();
    expect(exposeMcpTool('notes', 'search', used)).toBe('mcp_notes_search');
    expect(exposeMcpTool('a_b', 'c', used)).toBe('mcp_a_b_c');
    expect(exposeMcpTool('a', 'b_c', used)).toBe('mcp_a_b_c_2');
    const catalog = new ToolCatalog([
      { service: 'notes', tool: 'search', description: '检索', confirm: true },
      { service: 'calc', tool: 'add', confirm: false },
    ]);
    const names = catalog.definitions().map(tool => tool.function.name);
    expect(names).toContain('mcp_notes_search');
    expect(names).toContain('mcp_calc_add');
    expect(names).not.toContain('search');
    const { runtime: rt, calls } = runtime();
    const pending = await catalog.route('mcp_notes_search', { q: '习惯' }, rt);
    expect(pending).toMatchObject({ kind: 'card', card: { type: 'mcp', service: 'notes', tool: 'search', arguments: { q: '习惯' } } });
    expect(calls).toEqual([]);
    const direct = await catalog.route('mcp_calc_add', { n: 1 }, rt);
    expect(direct).toMatchObject({ kind: 'result', content: 'called add' });
    expect(calls).toEqual([{ name: 'mcp_call_tool', args: { name: 'calc', tool: 'add', arguments: { n: 1 } } }]);
  });
});
