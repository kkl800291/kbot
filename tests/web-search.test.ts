import { describe, expect, it } from 'vitest';
import { citationLinks, isOfficialDeepSeek, webSearchState } from '../src/services/web-search';

const ai = (provider: string, base: string, protocol = 'auto') => ({
  chat: { provider, base, model: 'configured-model', hasKey: true },
  search: { provider: 'builtin', protocol, hasKey: false },
});

describe('provider web search routing', () => {
  it('uses the DeepSeek chat credential without requiring a second search key', () => {
    expect(webSearchState(ai('deepseek', 'https://api.deepseek.com/v1'))).toMatchObject({ available: true, mode: 'deepseek' });
  });
  it.each(['openai', 'grok'])('routes %s hosted search through Responses', provider => {
    expect(webSearchState(ai(provider, 'https://api.example.com/v1'))).toMatchObject({ available: true, mode: 'responses' });
  });
  it('recognizes official endpoints under custom provider settings', () => {
    expect(webSearchState(ai('custom', 'https://api.x.ai/v1')).mode).toBe('responses');
    expect(webSearchState(ai('custom', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).mode).toBe('qwen');
    expect(webSearchState(ai('custom', 'https://api.deepseek.com/v1')).mode).toBe('deepseek');
  });
  it('requires an explicit protocol for an unknown proxy and respects the selected format', () => {
    const config = ai('custom', 'https://proxy.example.com/v1');
    expect(webSearchState(config).available).toBe(false);
    config.search.protocol = 'responses';
    expect(webSearchState(config).mode).toBe('responses');
    config.search.protocol = 'qwen';
    expect(webSearchState(config).mode).toBe('qwen');
  });
  it('does not enable search on the strength of a model name or the default switch', () => {
    const config = ai('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    config.chat.hasKey = false;
    expect(webSearchState(config).available).toBe(false);
    expect(webSearchState({ ...config, search: { provider: 'brave', hasKey: false } }).reason).toContain('Brave');
    expect(webSearchState({ ...config, search: { provider: 'tavily', hasKey: true } }).mode).toBe('tavily');
    expect(webSearchState({ ...config, search: { provider: 'none' } }).available).toBe(false);
  });
  it('requires the exact official DeepSeek service for credential reuse', () => {
    for (const base of ['https://api.deepseek.com.evil.test/v1', 'https://user@api.deepseek.com/v1', 'https://api.deepseek.com/v1?key=x', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:444/v1']) {
      expect(isOfficialDeepSeek(base)).toBe(false);
      expect(webSearchState(ai('deepseek', base)).available).toBe(false);
    }
    expect(isOfficialDeepSeek('https://api.deepseek.com/')).toBe(true);
  });
});

describe('clickable provider citations', () => {
  it('handles Chinese and emoji character offsets without changing quoted text', () => {
    const source = { url: 'https://example.com/doc', title: '文档' };
    expect(citationLinks('你好🙂世界', [{ ...source, startIndex: 3, endIndex: 5 }], [source])).toBe('你好🙂世界[1](https://example.com/doc)');
  });
  it('replaces provider markers and leaves existing Grok Markdown citations intact', () => {
    const source = { url: 'https://example.com/doc' }, text = '事实citeturn0';
    expect(citationLinks(text, [{ ...source, startIndex: 2, endIndex: Array.from(text).length }], [source])).toBe('事实[1](https://example.com/doc)');
    const linked = '事实[[1]](https://example.com/doc)';
    expect(citationLinks(linked, [{ ...source, startIndex: 2, endIndex: linked.length }], [source])).toBe(linked);
  });
});
