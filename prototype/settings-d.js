/* 赛博伙伴 · 设置页（四）：AI（模型、看图模型、联网搜索、发送内容范围） */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;

  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', chat: 'deepseek-chat', vision: '', web: false },
    qwen: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chat: 'qwen-plus', vision: 'qwen-vl-max', web: true },
    grok: { name: 'Grok', base: 'https://api.x.ai/v1', chat: 'grok-3', vision: 'grok-2-vision-1212', web: true },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', chat: 'gpt-4o-mini', vision: 'gpt-4o', web: true },
    custom: { name: '自定义（OpenAI 兼容接口）', base: '', chat: '', vision: '', web: false },
  };
  const SEARCH = [['builtin', '服务商自带联网'], ['tavily', 'Tavily'], ['brave', 'Brave Search'], ['none', '不使用联网搜索']];
  const VISION_RE = /vl|vision|gpt-4o|gpt-4\.1|gpt-5|grok-4|gemini|claude|omni/i;
  const supportsImages = m => VISION_RE.test(m || '');
  const keyLen = {}; // 本次打开期间输入过的 Key 长度，只用于模拟“Key 无效”；Key 本身不保存

  // 由 AI 配置推出聊天界面需要的状态：未配置 / 仅文本 / 文本+看图模型 / 原生多模态
  A.deriveModel = () => {
    const { chat, vision } = A.S.ai;
    let m = 'none';
    if (chat.hasKey && chat.model) m = supportsImages(chat.model) ? 'vision' : vision.on && vision.hasKey && vision.model ? 'fallback' : 'text';
    if (m !== A.S.model) A.set('model', m);
  };
  A.deriveWeb = () => {
    const { search, chat } = A.S.ai;
    const ok = search.provider === 'builtin' ? PROVIDERS[chat.provider].web : search.provider !== 'none' && search.hasKey;
    if (ok !== A.S.webAvailable) A.set('webAvailable', ok);
  };
  // 演示控制台里“模型配置”下拉直接切状态时，让设置里的配置同步成对应的样子
  A.applyModelPreset = v => {
    const ai = A.S.ai, P = PROVIDERS;
    const put = (slot, p, name, key) => Object.assign(ai[slot], { provider: p, base: P[p].base, model: name, hasKey: key });
    if (v === 'none') ai.chat.hasKey = false;
    else if (v === 'vision') { put('chat', 'openai', 'gpt-4o', true); ai.vision.on = false; }
    else { put('chat', 'deepseek', 'deepseek-chat', true); ai.vision.on = v === 'fallback'; if (ai.vision.on) put('vision', 'qwen', 'qwen-vl-max', true); }
    A.save(); A.deriveModel(); A.deriveWeb(); A.emit('ai:external');
  };
  A.applyWebPreset = on => {
    const s = A.S.ai.search; s.provider = on ? 'tavily' : 'none'; s.hasKey = on;
    A.save(); A.deriveWeb(); A.emit('ai:external');
  };

  // ---------- 组件 ----------
  function keyCtl(cfg, slot, after) {
    const wrap = h('div', { class: 'sx-key' });
    const draw = editing => {
      wrap.replaceChildren();
      if (cfg.hasKey && !editing) {
        wrap.append(h('span', { class: 'sx-status ok' }, '已保存在钥匙串'), X.btn('更换', () => draw(true), 'ghost'),
          X.btn('删除', () => { cfg.hasKey = false; delete keyLen[slot]; A.save(); after(); draw(false); }, 'ghost'));
        return;
      }
      const i = h('input', { class: 'sx-in', type: 'password', placeholder: 'sk-…', style: 'width:190px', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API Key' });
      const eye = h('button', { class: 'ib', type: 'button', title: '显示 / 隐藏', 'aria-label': '显示或隐藏 Key', html: A.icon('eye', 15) });
      eye.addEventListener('click', () => { const show = i.type === 'password'; i.type = show ? 'text' : 'password'; eye.innerHTML = A.icon(show ? 'eyeoff' : 'eye', 15); });
      const save = () => {
        const v = i.value.trim(); if (!v) { i.focus(); return; }
        keyLen[slot] = v.length; cfg.hasKey = true; A.save(); i.value = ''; after(); draw(false);
        A.toast('Key 已保存到钥匙串');
      };
      i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
      wrap.append(i, eye, X.btn('保存', save, 'primary'));
      if (cfg.hasKey) wrap.append(X.btn('取消', () => draw(false), 'ghost'));
      if (editing) setTimeout(() => i.focus(), 0);
    };
    draw(false);
    return wrap;
  }

  const field = (cfg, k, w, ph, after) => {
    const i = h('input', { class: 'sx-in', type: 'text', placeholder: ph, style: `width:${w}px`, spellcheck: 'false', value: cfg[k] || '' });
    i.addEventListener('change', () => { cfg[k] = i.value.trim(); A.save(); after(); });
    return i;
  };

  // 模拟连接测试：同时检测文本和图片输入
  function runTest(cfg, slot) {
    const ms = 260 + Math.floor(Math.random() * 380);
    if (!cfg.hasKey) return { ok: false, msg: '还没有填写 API Key' };
    if (!cfg.model) return { ok: false, msg: '还没有填写模型名' };
    if (!/^https?:\/\/\S+/.test(cfg.base)) return { ok: false, msg: 'API 地址格式不对，应该以 https:// 开头' };
    if (keyLen[slot] != null && keyLen[slot] < 8) return { ok: false, msg: 'API Key 无效（服务商返回 401），请检查是否复制完整' };
    const img = supportsImages(cfg.model);
    return { ok: true, msg: `连接成功 · ${ms} ms · 文本 ✓ · 图片输入 ${img ? '✓' : '✗ 不支持'}`, img };
  }
  function testRow(cfg, slot) {
    const row = X.row('连接测试', '同时检测模型能不能看图', null);
    const out = $$('.sx-d', row)[0], b = X.btn('测试连接', () => {
      b.disabled = true; out.className = 'sx-d'; out.textContent = '测试中…';
      setTimeout(() => { const r = runTest(cfg, slot); out.textContent = r.msg; out.className = 'sx-d ' + (r.ok ? 'ok' : 'bad'); b.disabled = false; }, 900);
    });
    row.append(h('div', { class: 'sx-c' }, b));
    return row;
  }

  const providerSel = (cfg, slot, redraw) => {
    const s = h('select', { class: 'sx-in', style: 'width:200px' }, Object.keys(PROVIDERS).map(k => h('option', { value: k }, PROVIDERS[k].name)));
    s.value = cfg.provider;
    s.addEventListener('change', () => {
      const p = PROVIDERS[s.value];
      Object.assign(cfg, { provider: s.value, base: p.base, model: p[slot === 'chat' ? 'chat' : 'vision'], hasKey: false });
      delete keyLen[slot]; A.save(); redraw(true);
    });
    return s;
  };

  pages.ai = el => {
    const ai = A.S.ai;
    const redraw = changed => { if (changed) { A.deriveModel(); A.deriveWeb(); } draw(); };
    const after = () => redraw(true);
    const draw = () => {
      const top = el.scrollTop;
      el.replaceChildren();
      const warn = A.S.model === 'none' ? h('div', { class: 'sx-banner' }, '还没有配置对话模型。填好 API Key 之后，才能和我聊天；休息、喝水这些提醒不需要 AI，现在就能用。') : null;
      const webOk = A.S.webAvailable;
      const searchKey = ai.search.provider === 'tavily' || ai.search.provider === 'brave';
      el.append(...[
        warn,
        X.group('对话模型',
          X.row('服务商', 'OpenAI 兼容接口；预设会自动填好地址和示例模型名', providerSel(ai.chat, 'chat', redraw)),
          X.row('API 地址', null, field(ai.chat, 'base', 250, 'https://…/v1', after)),
          X.row('模型名', null, field(ai.chat, 'model', 190, '例如 deepseek-chat', after)),
          X.row('API Key', '只保存在 macOS 钥匙串里，不写入普通配置文件', keyCtl(ai.chat, 'chat', after)),
          testRow(ai.chat, 'chat'),
        ),
        supportsImages(ai.chat.model) ? X.note(`「${ai.chat.model}」本身支持图片，不需要再配看图模型。`) : null,
        X.group('看图模型（可选）',
          X.row('单独指定看图模型', '对话模型不支持图片时，发图片就自动改用它，比如通义千问 VL、Grok 视觉模型、GPT-4o', X.switch(ai.vision.on, v => { ai.vision.on = v; A.save(); redraw(true); })),
          ...(ai.vision.on ? [
            X.row('服务商', null, providerSel(ai.vision, 'vision', redraw)),
            X.row('API 地址', null, field(ai.vision, 'base', 250, 'https://…/v1', after)),
            X.row('模型名', null, field(ai.vision, 'model', 190, '例如 qwen-vl-max', after)),
            X.row('API Key', '可以和对话模型是同一个服务商，也可以不同', keyCtl(ai.vision, 'vision', after)),
            testRow(ai.vision, 'vision'),
          ] : []),
        ),
        X.group('联网搜索',
          X.row('搜索服务', !webOk && ai.search.provider === 'builtin' ? `当前服务商（${PROVIDERS[ai.chat.provider].name}）没有自带联网，请改选下面的搜索服务` : '服务商自带联网的话直接用；不支持时，再配一个独立的搜索服务',
            h('select', { class: 'sx-in', style: 'width:170px', onchange: e => { ai.search.provider = e.target.value; if (e.target.value !== 'tavily' && e.target.value !== 'brave') ai.search.hasKey = false; A.save(); redraw(true); } },
              SEARCH.map(([v, l]) => h('option', Object.assign({ value: v }, v === ai.search.provider ? { selected: '' } : {}), l)))),
          searchKey ? X.row('搜索服务的 Key', null, keyCtl(ai.search, 'search', after)) : null,
          X.row('新对话默认开启联网', webOk ? '每个对话里也可以单独开关' : '没有可用的搜索服务，聊天里的联网按钮暂时不可用', X.toggle('webDefault')),
        ),
        X.group('发送给模型的内容',
          X.row('你输入的聊天内容、你主动添加的图片', '图片只有你粘贴、拖入、选择或截图时才会发送', h('span', { class: 'sx-status' }, '始终发送')),
          X.row('当前时间、时段、节日节气、天气', '天气只到城市级别', h('span', { class: 'sx-status' }, '始终发送')),
          X.row('前台应用的类别', '例如「开发工具」；在「感知」里关掉前台应用就不会有', h('span', { class: 'sx-status' }, A.S.senseApp ? '发送' : '已关闭')),
          X.row('前台应用的具体名称', '默认不发送', X.toggle('send.appName')),
          X.row('日历会议标题', '默认不发送', X.toggle('send.calTitle')),
          X.row('与当前话题相关的记忆', '只发相关的几条，不是全部', X.toggle('send.memory')),
        ),
        X.note('窗口标题、屏幕内容、剪贴板、文件：不会在后台读取，只有你主动粘贴、拖入、选择或截图时，才会读取对应的内容。'),
        X.group('用量', X.row('今天的对话调用次数', '只在这台电脑上统计，方便你了解用量', h('span', { class: 'sx-status' }, `${ai.calls.day === new Date().toDateString() ? ai.calls.n : 0} 次`))),
      ].filter(Boolean));
      el.scrollTop = top;
    };
    draw();
    el._redraw = draw;
  };
  A.on('ai:external', () => { const p = document.querySelector('#sheet .sh-page'); if (p && p._redraw) p._redraw(); });
  A.deriveModel(); A.deriveWeb();
})();
