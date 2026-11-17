import { describe, expect, it } from 'vitest';
import {
  buildSubmittedAnswersFromCard,
  classifyFrontmostApp,
  classifyToolStep,
  createExpressionStreamParser,
  createQuestionCardState,
  extractExpressions,
  formatElapsedDuration,
  formatModelDisplayName,
  formatReasoningEffortLabel,
  formatToolStepDetail,
  formatToolStepLabel,
  buildDesktopSensorSnapshot,
  chooseSessionTitle,
  createSessionTitleFilter,
  extractSessionTitle,
  formatDesktopWhen,
  isRefusalSignal,
  mergeChatSources,
  normalizeDshError,
  parseOpeners,
  shouldRefreshSessionTitle,
  suggestSessionTitle,
  summarizeSourceLinks,
  parseRecommendedOptionLabel,
  summarizeReplyForBubble,
} from '../src/services/agent';
import {
  buildDueProactiveEvents,
  dayKey,
  nextRoutineRemainingMinutes,
  parseClock,
} from '../src/services/proactive';
import { summarizeUpdateNotes } from '../src/services/updater';

describe('DSH expression parser and desktop sensor helpers', () => {
  it('builds quiet, deduplicated proactive companion prompts from existing settings', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('bad')).toBeNull();
    const now = new Date(2026, 10, 12, 11, 15).getTime();
    expect(dayKey(now)).toBe('2026-11-12');
    const events = buildDueProactiveEvents({
      now,
      activeMinutes: 45,
      settings: {
        aiCompanion: true,
        workFrom: '09:00',
        workTo: '18:00',
        params: { waterEvery: 45, eyeEvery: 20, lunchAt: '11:15', offworkLead: 10, nightAt: '23:30' },
      },
      fired: {},
    });
    expect(events.map(event => event.key)).toEqual(['lunch']);
    expect(buildDueProactiveEvents({
      now,
      activeMinutes: 45,
      settings: { aiCompanion: false },
      fired: {},
    })).toEqual([]);
    expect(buildDueProactiveEvents({
      now,
      activeMinutes: 45,
      settings: { aiCompanion: true, params: { waterEvery: 45 } },
      fired: { water: true },
      active: true,
    }).some(event => event.key === 'water')).toBe(false);

    // Repeating water/eye intervals continue to fire on subsequent cycles and report remaining time.
    const quietNow = new Date(2026, 10, 12, 14, 0).getTime();
    const routineSettings = { aiCompanion: true, params: { waterEvery: 45, eyeEvery: 20 } };
    expect(buildDueProactiveEvents({
      now: quietNow,
      activeMinutes: 40,
      settings: routineSettings,
      lastRoutineMinutes: { eye: 20 },
      active: true,
    }).map(event => event.key)).toEqual(['eye']);
    expect(buildDueProactiveEvents({
      now: quietNow,
      activeMinutes: 90,
      settings: routineSettings,
      lastRoutineMinutes: { water: 45, eye: 80 },
      active: true,
    }).map(event => event.key)).toEqual(['water']);
    expect(nextRoutineRemainingMinutes({
      settings: routineSettings,
      activeMinutes: 50,
      lastRoutineMinutes: { water: 45, eye: 40 },
    })).toBe(10);
  });
  it('strips inline expression tags while keeping non-expression brackets and code blocks intact', () => {
    const raw = '[happy] 早安呀！参考链接 [1] 和数组 `arr[0]`：\n```ts\nconst tag = "[wink]";\n```\n最后祝你顺利 [wink]';
    const parsed = extractExpressions(raw);
    // wink、coy 已不是可用标签，但旧提示词里出现时仍剥掉，按 happy 处理
    expect(parsed.expressions).toEqual(['happy', 'happy']);
    expect(parsed.lastExpr).toBe('happy');
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
    expect(seen).toEqual(['happy']);
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

  it('keeps at most four short opener lines from a model reply', () => {
    const raw = '1. 看看今天的日程\n2. 「帮我记下一件待办」\n- 太长的一条建议不应该被收进来因为超过了三十二个字的限制所以要丢掉\n3. 看看今天的日程\n4. 整理一下养成目录\n5. 提醒我下午喝水';
    expect(parseOpeners(raw)).toEqual(['看看今天的日程', '帮我记下一件待办', '整理一下养成目录', '提醒我下午喝水']);
    expect(parseOpeners('没有可用的建议')).toEqual(['没有可用的建议']);
  });

  it('maps raw DSH model IDs to friendly display names while respecting catalog displayName', () => {
    expect(formatModelDisplayName('deepseek-flash')).toBe('DeepSeek-V4.1-Flash');
    expect(formatModelDisplayName('deepseek-chat')).toBe('DeepSeek-V3.2');
    expect(formatModelDisplayName('deepseek-reasoner')).toBe('DeepSeek-R1');
    expect(formatReasoningEffortLabel('off')).toBe('不思考');
    expect(formatReasoningEffortLabel('low')).toBe('低');
    expect(formatReasoningEffortLabel('medium')).toBe('中');
    expect(formatReasoningEffortLabel('high')).toBe('高');
    expect(formatReasoningEffortLabel('max')).toBe('最高');
    expect(formatReasoningEffortLabel('custom', 'Custom')).toBe('Custom');
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

  it('tells the model the date, local time, city and interface language', () => {
    const when = formatDesktopWhen(new Date('2026-11-16T02:07:00Z'), 'Asia/Shanghai');
    expect(when.date).toContain('2026年11月16日');
    expect(when.date).toContain('星期一');
    expect(when.time).toBe('10:07');
    const snap = buildDesktopSensorSnapshot({
      now: new Date('2026-11-16T02:07:00Z'),
      timeZone: 'Asia/Shanghai',
      city: '上海',
      weather: '上海，晴',
      language: '简体中文',
    });
    expect(snap.city).toBe('上海');
    expect(snap.language).toBe('简体中文');
    expect(snap.timeZone).toBe('Asia/Shanghai');
    expect(snap.date).toBe(when.date);
  });

  it('replaces the provisional title once, and keeps a manual rename', () => {
    expect(suggestSessionTitle('帮我查一下明天上海的天气')).toBe('查一下明天上海的天气');
    expect(chooseSessionTitle('查天气', '帮我查一下明天上海的天气')).toBe('查天气');
    const conv = { title: '帮我查一下明天上海的', titleSource: 'auto', messages: [{ role: 'user', id: 'u1' }] };
    expect(shouldRefreshSessionTitle(conv, { id: 'u1' })).toBe(true);
    expect(shouldRefreshSessionTitle(conv, { id: 'u2' })).toBe(false);
    expect(shouldRefreshSessionTitle({ ...conv, titleLocked: true }, { id: 'u1' })).toBe(false);
    expect(shouldRefreshSessionTitle({ title: '旧对话', messages: [{ role: 'user', id: 'u1' }] }, { id: 'u1' })).toBe(false);
  });

  it('hides a split session-title tag and keeps expression tags', () => {
    let titled = '';
    const filter = createSessionTitleFilter(title => { titled = title; });
    const visible = filter.push('好的。[[ti') + filter.push('tle:查天气]]');
    expect(visible + filter.flush()).toBe('好的。');
    expect(titled).toBe('查天气');
    expect(extractSessionTitle('[happy] 已记下\n[[title:记日程]]')).toEqual({ text: '[happy] 已记下\n', title: '记日程' });
  });

  it('recognizes a model refusal without treating ordinary errors as one', () => {
    expect(isRefusalSignal({ reason: 'refusal' })).toBe(true);
    expect(isRefusalSignal({ code: 'content_filter' })).toBe(true);
    expect(isRefusalSignal({ refusal: true })).toBe(true);
    expect(isRefusalSignal({ message: 'Connection reset by peer' })).toBe(false);
  });

  it('classifies tool steps, formats elapsed durations, and summarizes inline web sources', () => {
    expect(formatToolStepLabel('web_search', { queries: ['英伟达市值'] })).toBe('搜索「英伟达市值」');
    expect(formatToolStepLabel('skill', { name: 'web-search' })).toBe('使用技能: web-search');

    expect(classifyToolStep('skill', { name: 'web-search' })).toEqual({
      icon: 'tool',
      t: '使用技能: web-search',
      doneT: '已使用技能: web-search',
    });
    expect(classifyToolStep('bash', { command: 'ls -la' })).toEqual({
      icon: 'terminal',
      t: '执行命令 · ls',
      doneT: '已执行命令 · ls',
    });
    expect(classifyToolStep('web_search', { queries: ['英伟达'] }).icon).toBe('globe');
    expect(classifyToolStep('read_file', { path: 'MEMORY.md' }).doneT).toBe('已读取长期记忆 MEMORY.md');
    expect(formatToolStepDetail('bash', { command: 'open -a DingTalk', description: '打开钉钉' })).toBe(
      '打开钉钉\n$ open -a DingTalk',
    );
    expect(formatToolStepDetail('web_search', { queries: ['成都天气', '降雨概率'] })).toBe(
      '搜索：成都天气\n搜索：降雨概率',
    );
    expect(classifyToolStep('mcp_load', { server: 'rea' })).toMatchObject({ t: '加载外部工具 · rea', doneT: '已加载外部工具' });
    expect(classifyToolStep('mcp__rea__read_binary', {})).toMatchObject({ icon: 'tool', t: '调用 rea · read_binary', doneT: '已调用 rea · read_binary' });
    expect(formatToolStepDetail('mcp__rea__read_binary', { path: '/tmp/a' })).toBe('{\n  "path": "/tmp/a"\n}');
    expect(formatToolStepDetail('web_fetch', { url: 'https://example.com/news' })).toBe(
      '网址：https://example.com/news',
    );

    expect(formatElapsedDuration(400, true)).toBe('0 秒');
    expect(formatElapsedDuration(400, false)).toBe('1 秒');
    expect(formatElapsedDuration(23400, false)).toBe('23 秒');
    expect(formatElapsedDuration(75000, false)).toBe('1 分 15 秒');

    const merged = mergeChatSources(
      [{ url: 'https://xueqiu.com/S/NVDA', title: '英伟达 - 雪球', site: 'xueqiu.com' }],
      [
        { url: 'https://xueqiu.com/S/NVDA', title: '英伟达 - 雪球', site: 'xueqiu.com' },
        { url: 'https://xueqiu.com/post/2', title: '雪球讨论', site: 'xueqiu.com' },
        { url: 'https://quote.eastmoney.com/nvda.html', title: '英伟达行情 - 东方财富', site: 'quote.eastmoney.com' },
      ],
    );
    expect(merged).toHaveLength(3);
    expect(summarizeSourceLinks(merged)).toEqual([
      { url: 'https://xueqiu.com/S/NVDA', label: '雪球', title: '英伟达 - 雪球' },
      { url: 'https://quote.eastmoney.com/nvda.html', label: '东方财富', title: '英伟达行情 - 东方财富' },
    ]);
  });
});
