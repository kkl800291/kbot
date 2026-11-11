import { describe, expect, it } from 'vitest';
import {
  buildSubmittedAnswersFromCard,
  classifyFrontmostApp,
  createExpressionStreamParser,
  createQuestionCardState,
  extractExpressions,
  formatModelDisplayName,
  formatToolStepLabel,
  normalizeDshError,
  parseRecommendedOptionLabel,
  summarizeReplyForBubble,
} from '../src/services/agent';
import { summarizeUpdateNotes } from '../src/services/updater';

describe('DSH expression parser and desktop sensor helpers', () => {
  it('strips inline expression tags while keeping non-expression brackets and code blocks intact', () => {
    const raw = '[happy] 早安呀！参考链接 [1] 和数组 `arr[0]`：\n```ts\nconst tag = "[wink]";\n```\n最后祝你顺利 [wink]';
    const parsed = extractExpressions(raw);
    expect(parsed.expressions).toEqual(['happy', 'wink']);
    expect(parsed.lastExpr).toBe('wink');
    expect(parsed.text).toContain('早安呀！参考链接 [1] 和数组 `arr[0]`：');
    expect(parsed.text).toContain('const tag = "[wink]";');
    expect(parsed.text).not.toContain('[happy]');
    expect(parsed.text.endsWith('最后祝你顺利 ')).toBe(true);
  });

  it('parses chunked streaming expression tags without leaking partial tags to UI', () => {
    const seen: string[] = [];
    const parser = createExpressionStreamParser(expr => seen.push(expr));
    let out = '';
    for (const chunk of ['[hap', 'py] ', '你好', '呀 [sur', 'prised]', '！引用 [1', '2] 保留']) {
      out += parser.push(chunk);
    }
    out += parser.flush();
    expect(seen).toEqual(['happy', 'surprised']);
    expect(out).toBe('你好呀 ！引用 [12] 保留');
  });

  it('keeps expression-like tokens inside streamed fenced code blocks untouched', () => {
    const seen: string[] = [];
    const parser = createExpressionStreamParser(expr => seen.push(expr));
    let out = '';
    for (const chunk of ['``', '`md\n[happy] 示例\n``', '`\n[coy] 真的害羞了']) {
      out += parser.push(chunk);
    }
    out += parser.flush();
    expect(seen).toEqual(['coy']);
    expect(out).toContain('[happy] 示例');
    expect(out).not.toContain('[coy]');
  });

  it('classifies frontmost macOS applications and ignores KBOT itself', () => {
    const apps = {
      dev: ['VS Code', 'Xcode', 'Cursor'],
      meeting: ['腾讯会议', '飞书会议', 'Zoom'],
      chat: ['微信'],
    };
    expect(classifyFrontmostApp('Zoom.us', 'us.zoom.xos', apps)).toBe('meeting');
    expect(classifyFrontmostApp('Cursor', 'com.todesktop.230313mzl4w4u92', apps)).toBe('dev');
    expect(classifyFrontmostApp('KBOT', 'com.cybercompanion.desktop', apps)).toBeNull();
    expect(classifyFrontmostApp('Finder', 'com.apple.finder', apps)).toBeNull();
  });

  it('formats DSH tool invocations into clear Chinese step labels', () => {
    expect(formatToolStepLabel('web_search', { query: 'DeepSeek Harness' })).toBe('搜索「DeepSeek Harness」');
    expect(formatToolStepLabel('web_fetch', { url: 'https://www.github.com/deepseek-ai/DeepSeek-V3' })).toBe('读取网页 · github.com');
    expect(formatToolStepLabel('edit_file', { file_path: '/Users/me/KBOT/MEMORY.md' })).toBe('更新长期记忆 MEMORY.md');
    expect(formatToolStepLabel('write_file', { path: '/Users/me/KBOT/diary/2026-04-20.md' })).toBe('记录今日日记');
    expect(formatToolStepLabel('schedule_create', {})).toBe('设置定时提醒任务');
    expect(formatToolStepLabel('bash', { command: 'git status --short' })).toBe('执行命令 · git');
    expect(
      formatToolStepLabel(
        'ask_user_question',
        JSON.stringify({ questions: [{ id: 'q1', header: '界面风格', question: '你更偏爱哪种风格？' }] }),
      ),
    ).toBe('向你提问 · 界面风格');
    expect(formatToolStepLabel('ask_user_question', '{}')).toBe('向你提问 · 等待回答');
  });

  it('parses recommended suffixes without mutating raw option labels submitted to DSH', () => {
    expect(parseRecommendedOptionLabel('TypeScript (Recommended)')).toEqual({
      label: 'TypeScript (Recommended)',
      displayLabel: 'TypeScript',
      recommended: true,
    });
    expect(parseRecommendedOptionLabel('浅色护眼（推荐）')).toEqual({
      label: '浅色护眼（推荐）',
      displayLabel: '浅色护眼',
      recommended: true,
    });
    expect(parseRecommendedOptionLabel('手动配置')).toEqual({
      label: '手动配置',
      displayLabel: '手动配置',
      recommended: false,
    });
  });

  it('creates interactive question card state and builds DSH-compliant submitted answers', () => {
    const card = createQuestionCardState({
      questionRequestId: 'uq-1',
      callId: 'call-ask-1',
      state: 'open',
      questions: [
        {
          id: 'framework',
          header: '框架选择',
          question: '使用哪个前端框架？',
          options: [
            { label: 'Vue 3 (推荐)', description: '渐进式轻量方案' },
            { label: 'React 19', description: '生态丰富' },
          ],
        },
        {
          id: 'features',
          header: '附加功能',
          question: '需要开启哪些模块？',
          multiSelect: true,
          options: [
            { label: '单元测试 (Recommended)' },
            { label: 'E2E 测试' },
          ],
        },
        {
          id: 'notes',
          header: '备注',
          question: '还有其他要求吗？',
        },
      ],
    });

    // Single-select preselects first option when marked recommended; multi-select does not auto-check
    expect(card.drafts.framework.selected).toEqual(['Vue 3 (推荐)']);
    expect(card.drafts.features.selected).toEqual([]);
    expect(card.mode).toBe('open');
    expect(createQuestionCardState({ state: 'continued', questions: [] }).mode).toBe('continued');

    // Custom input in single-select overrides preset option; multi-select combines selected + custom; skipped returns empty selected
    card.drafts.framework.custom = 'Svelte 5';
    card.drafts.features.selected = ['单元测试 (Recommended)'];
    card.drafts.features.custom = '还要接入 Storybook';
    card.drafts.notes.skipped = true;

    expect(buildSubmittedAnswersFromCard(card)).toEqual([
      { id: 'framework', selected: [], custom: 'Svelte 5' },
      { id: 'features', selected: ['单元测试 (Recommended)'], custom: '还要接入 Storybook' },
      { id: 'notes', selected: [] },
    ]);
  });

  it('maps raw DSH model IDs to friendly display names while respecting catalog displayName', () => {
    expect(formatModelDisplayName('deepseek-flash')).toBe('DeepSeek-V4.1-Flash');
    expect(formatModelDisplayName('deepseek-chat')).toBe('DeepSeek-V3.2');
    expect(formatModelDisplayName('deepseek-reasoner')).toBe('DeepSeek-R1');
    expect(formatModelDisplayName('custom-id', 'Claude Sonnet 4.6')).toBe('Claude Sonnet 4.6');
  });

  it('summarizes markdown replies and release notes cleanly for collapsed bubbles and update notifications', () => {
    const md = '[happy] ### 今日科技动态\n- **OpenAI** 发布新工具链，详见 [官方博客](https://example.com)\n```bash\necho hi\n```';
    const brief = summarizeReplyForBubble(md, 60);
    expect(brief).not.toContain('[happy]');
    expect(brief).not.toContain('https://example.com');
    expect(brief).not.toContain('echo hi');
    expect(brief).toContain('今日科技动态');

    const notes = '## What\'s Changed\n- 新增可折叠任务执行胶囊\n- 支持一键检测与静默自更新';
    expect(summarizeUpdateNotes(notes, 80)).toContain('新增可折叠任务执行胶囊');
  });

  it('normalizes missing credential errors into actionable Chinese guidance', () => {
    const deepseekErr = normalizeDshError(
      'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service',
    );
    expect(deepseekErr.needModelConfig).toBe(true);
    expect(deepseekErr.message).toContain('deepseek-official');
    expect(deepseekErr.message).toContain('配置模型');

    const kimiErr = normalizeDshError(
      'MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "kimi-coding"',
    );
    expect(kimiErr.needModelConfig).toBe(true);
    expect(kimiErr.message).toContain('kimi-coding');

    const networkErr = normalizeDshError('Connection reset by peer');
    expect(networkErr.needModelConfig).toBe(false);
    expect(networkErr.message).toBe('Connection reset by peer');
  });
});
