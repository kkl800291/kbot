import { beforeEach, describe, expect, it, vi } from 'vitest';
import { command } from '../src/services/runtime';
import { installAI, rewriteCompanion } from '../src/services/ai';

vi.mock('../src/services/runtime', () => ({ command: vi.fn(), Channel: class { onmessage: any; } }));

function app(provider = 'deepseek', webOn = true) {
  const user = { role: 'user', text: '查一下官方文档' };
  const conv: { webOn: boolean; messages: any[] } = { webOn, messages: [user] };
  const A: any = {
    S: { ai: { chat: { provider, model: 'fixture', base: provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.example.com/v1', hasKey: true }, search: { provider: 'builtin' } }, model: 'text', persona: 'cute', nickname: '你', send: { memory: false } },
    uid: () => 'reply', countCall: vi.fn(), save: vi.fn(),
    robot: { flash: vi.fn(), clearFlash: vi.fn(), talkPulse: vi.fn() },
    chat: { cur: conv, append: vi.fn(), setGenerating: vi.fn(), status: vi.fn(), paint: vi.fn(), paintText: vi.fn() },
  };
  installAI(A);
  return { A, user, conv };
}

beforeEach(() => {
  vi.mocked(command).mockReset();
  vi.mocked(command).mockImplementation(async (name, args: any) => {
    if (name === 'search_web') return [{ title: '官方文档', url: 'https://example.com/docs', content: '真实返回的资料' }];
    if (name === 'chat_stream') {
      args.onEvent.onmessage({ type: 'delta', text: '这是回答' });
      args.onEvent.onmessage({ type: 'done' });
    }
  });
});

describe('chat search flow', () => {
  it.each(['deepseek', 'openai', 'grok', 'qwen'])('continues a proactive greeting on %s without searching an ambiguous short reply', async provider => {
    const { A, user, conv } = app(provider);
    user.text = '没有代办';
    const opening = '今天的待办可以慢慢清空，我的陪伴电量倒是挺足的。';
    conv.messages.unshift({ role: 'assistant', text: opening, proactive: true });
    await A.chat.respond(user);
    expect(command).toHaveBeenCalledTimes(1);
    const [name, request]: any = vi.mocked(command).mock.calls[0];
    expect(name).toBe('chat_stream'); expect(request.web).toBe(false);
    expect(request.messages.filter((msg: any) => msg.role !== 'system')).toEqual([
      { role: 'assistant', content: opening }, { role: 'user', content: '没有代办' },
    ]);
    expect(request.tools.length).toBeGreaterThan(0);
    expect(conv.webOn).toBe(true);
    expect(conv.messages.at(-1).sources).toBeUndefined();
  });

  it('keeps older bubble openings and in-panel proactive speech in model context', async () => {
    const { A, user, conv } = app();
    user.text = '没有啊';
    conv.messages.unshift({ role: 'assistant', text: '今天有小小的开心事吗？' }, { role: 'pro', kind: 'speech', text: '很小很小的那种也算。' });
    await A.chat.respond(user);
    const request: any = vi.mocked(command).mock.calls[0][1];
    expect(request.messages).toContainEqual({ role: 'assistant', content: '很小很小的那种也算。' });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('still searches an explicit lookup when continuing a companion conversation', async () => {
    const { A, user, conv } = app();
    user.text = '帮我查一下成都今天的天气';
    conv.messages.unshift({ role: 'assistant', text: '下午想聊点什么？', proactive: true });
    await A.chat.respond(user);
    expect(command).toHaveBeenCalledWith('search_web', expect.objectContaining({ query: user.text }));
    expect(vi.mocked(command).mock.calls.map(c => c[0])).toEqual(['search_web', 'chat_stream']);
  });

  it('passes local reminder text and handled state to the model', async () => {
    const { A, user, conv } = app('deepseek', false);
    user.text = '这个提醒是什么';
    conv.messages.unshift({ role: 'pro', kind: 'remind', title: '喝水提醒', text: '喝一口水嘛。', done: '好的' });
    await A.chat.respond(user);
    const request: any = vi.mocked(command).mock.calls[0][1];
    expect(request.messages).toContainEqual({ role: 'assistant', content: '喝水提醒：喝一口水嘛。\n[用户已处理：好的]' });
  });

  it('searches with the DeepSeek configuration before streaming a cited answer', async () => {
    const { A, user, conv } = app(); await A.chat.respond(user);
    expect(vi.mocked(command).mock.calls.map(c => c[0])).toEqual(['search_web', 'chat_stream']);
    const request: any = vi.mocked(command).mock.calls[1][1];
    expect(request.web).toBe(false);
    expect(request.messages.some((m: any) => String(m.content).includes('真实返回的资料'))).toBe(true);
    expect(conv.messages.at(-1)).toMatchObject({ status: 'done', sources: [{ url: 'https://example.com/docs' }] });
  });
  it.each(['openai', 'grok', 'qwen'])('passes the native web format for %s without an external search key', async provider => {
    const { A, user } = app(provider); await A.chat.respond(user);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('chat_stream', expect.objectContaining({ web: true, config: expect.objectContaining({ webProtocol: provider === 'qwen' ? 'qwen' : 'responses' }) }));
  });
  it('keeps the explicit per-conversation offline setting', async () => {
    const { A, user } = app('deepseek', false); await A.chat.respond(user);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('chat_stream', expect.objectContaining({ web: false }));
  });
  it('shows a search failure instead of silently replying offline', async () => {
    vi.mocked(command).mockRejectedValueOnce(new Error('搜索服务账户余额不足'));
    const { A, user, conv } = app(); await A.chat.respond(user);
    expect(command).toHaveBeenCalledTimes(1);
    expect(conv.messages.at(-1)).toMatchObject({ status: 'error', error: '搜索服务账户余额不足' });
  });
  it('does not send an unknown built-in request without a selected protocol', async () => {
    const { A, user, conv } = app('custom'); await A.chat.respond(user);
    expect(command).not.toHaveBeenCalled();
    expect(conv.messages.at(-1)?.status).toBe('error');
  });
  it('deduplicates native sources, preserves citations, and reports an actual search', async () => {
    vi.mocked(command).mockImplementation(async (_name, args: any) => {
      args.onEvent.onmessage({ type: 'search', state: 'searching' });
      args.onEvent.onmessage({ type: 'delta', text: '文档' });
      const source = { url: 'https://example.com/doc', title: '来源', startIndex: 0, endIndex: 2 };
      args.onEvent.onmessage({ type: 'source', source }); args.onEvent.onmessage({ type: 'source', source });
      args.onEvent.onmessage({ type: 'done' });
    });
    const { A, user, conv } = app('openai'); await A.chat.respond(user);
    const reply: any = conv.messages.at(-1);
    expect(reply.sources).toHaveLength(1); expect(reply.citations).toHaveLength(1);
    expect(reply.steps[0].t).toContain('1 个来源');
  });
});

describe('companion rewrite', () => {
  function learned(memory = false) {
    const { A } = app();
    A.S.aiCompanion = true;
    A.S.send.memory = memory;
    A.S.params = { nightAt: '23:30' };
    A.chat.generating = false;
    A.habits = {
      'work-stretch': { minutes: 42, samples: 5 },
      'reminder-tolerance': { yes: 0, no: 0, samples: 0, side: null },
      'night-presence': { nightDays: 0, activeDays: 0, samples: 0, on: false },
      'companion-reception': { yes: 0, no: 0, samples: 0, side: null },
      updatedAt: 1,
    };
    A.drift = { talkativeness: -1, nightQuiet: 1 };
    return A;
  }

  it('keeps habits and drift out of the system prompt and the rewrite when memory is off', async () => {
    const A = learned(false);
    A.chat.cur.webOn = false;
    await A.chat.respond(A.chat.cur.messages[0]);
    const system = String((vi.mocked(command).mock.calls[0]?.[1] as any)?.messages?.[0]?.content);
    expect(system).not.toContain('连续工作大约 42');
    expect(system).not.toContain('最近话少一点');
    vi.mocked(command).mockClear();
    await rewriteCompanion(A, '今天慢慢来就好。');
    const request: any = vi.mocked(command).mock.calls.find(call => call[0] === 'chat_stream')?.[1];
    expect(request.tools).toEqual([]);
    expect(request.web).toBe(false);
    expect(request.messages[0].content).not.toContain('连续工作大约 42');
    expect(request.messages[0].content).not.toContain('最近话少一点');
    expect(request.messages[1].content).toBe('今天慢慢来就好。');
  });

  it('adds visible habits and drift to the prompt and the rewrite when memory is on', async () => {
    const A = learned(true);
    A.memories = [];
    A.chat.cur.webOn = false;
    await A.chat.respond(A.chat.cur.messages[0]);
    const system = String((vi.mocked(command).mock.calls[0]?.[1] as any)?.messages?.[0]?.content);
    expect(system).toContain('连续工作大约 42 分钟后会停一下');
    expect(system).toContain('最近话少一点，夜里更安静');
    expect(system).toContain('不能据此声称又记住了新内容');
    vi.mocked(command).mockClear();
    await expect(rewriteCompanion(A, '今天慢慢来就好。')).resolves.toBe('这是回答');
    const request: any = vi.mocked(command).mock.calls.find(call => call[0] === 'chat_stream')?.[1];
    expect(request.messages[0].content).toContain('连续工作大约 42 分钟后会停一下');
    expect(request.messages[0].content).toContain('语气偏移：最近话少一点，夜里更安静');
  });

  it('returns the local line when the model throws, returns nothing, or writes more than 60 characters', async () => {
    const A = learned(false);
    vi.mocked(command).mockRejectedValueOnce(new Error('down'));
    await expect(rewriteCompanion(A, '本地句')).resolves.toBe('本地句');
    expect(vi.mocked(command).mock.calls.filter(call => call[0] === 'chat_stream')).toHaveLength(1);

    vi.mocked(command).mockImplementation(async (_name, args: any) => {
      args.onEvent.onmessage({ type: 'delta', text: '   ' });
      args.onEvent.onmessage({ type: 'done' });
    });
    await expect(rewriteCompanion(A, '本地句')).resolves.toBe('本地句');
    vi.mocked(command).mockImplementation(async (_name, args: any) => {
      args.onEvent.onmessage({ type: 'delta', text: '啊'.repeat(61) });
      args.onEvent.onmessage({ type: 'done' });
    });
    await expect(rewriteCompanion(A, '本地句')).resolves.toBe('本地句');
    vi.mocked(command).mockImplementation(async (_name, args: any) => {
      args.onEvent.onmessage({ type: 'delta', text: '啊'.repeat(60) });
      args.onEvent.onmessage({ type: 'done' });
    });
    await expect(rewriteCompanion(A, '本地句')).resolves.toBe('啊'.repeat(60));
  });

  it('does not send a rewrite while chat is generating and falls back after eight seconds', async () => {
    const A = learned(false);
    A.chat.generating = true;
    await expect(rewriteCompanion(A, '本地句')).resolves.toBe('本地句');
    expect(command).not.toHaveBeenCalled();
    A.chat.generating = false;
    vi.useFakeTimers();
    vi.mocked(command).mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = rewriteCompanion(A, '本地句');
    pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('本地句');
    vi.useRealTimers();
  });
});
