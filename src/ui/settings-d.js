import { webSearchState } from '../services/web-search';
import { Channel } from '../services/runtime';

/* KBOT · 设置页（四）：AI（模型、看图模型、联网搜索、发送内容范围） */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;

  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', chat: 'deepseek-chat', vision: '', web: true },
    qwen: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chat: 'qwen-plus', vision: 'qwen-vl-max', web: true },
    grok: { name: 'Grok', base: 'https://api.x.ai/v1', chat: 'grok-3', vision: 'grok-2-vision-1212', web: true },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', chat: 'gpt-4o-mini', vision: 'gpt-4o', web: true },
    custom: { name: '自定义（OpenAI 兼容接口）', base: '', chat: '', vision: '', web: false },
  };
  const SEARCH = [['builtin', '服务商自带联网'], ['tavily', 'Tavily'], ['brave', 'Brave Search'], ['none', '不使用联网搜索']];
  const VISION_RE = /vl|vision|gpt-4o|gpt-4\.1|gpt-5|grok-4|gemini|claude|omni/i;
  const supportsImages = m => VISION_RE.test(m || '');
  const modelLists = new Map();

  // 由 AI 配置推出聊天界面需要的状态：未配置 / 仅文本 / 文本+看图模型 / 原生多模态
  A.deriveModel = () => {
    const { chat, vision } = A.S.ai;
    let m = 'none';
    if (chat.hasKey && chat.model) m = (chat.visionSupported ?? supportsImages(chat.model)) ? 'vision' : vision.on && vision.hasKey && vision.model ? 'fallback' : 'text';
    if (m !== A.S.model) A.set('model', m);
  };
  A.webSearchState = () => webSearchState(A.S.ai);
  A.deriveWeb = () => {
    const ok = A.webSearchState().available;
    if (ok !== A.S.webAvailable) A.set('webAvailable', ok);
  };
  // ---------- 组件 ----------
  function keyCtl(cfg, slot, after) {
    const wrap = h('div', { class: 'sx-key' });
    const draw = editing => {
      wrap.replaceChildren();
      if (cfg.hasKey && !editing) {
        wrap.append(h('span', { class: 'sx-status ok' }, '已保存在钥匙串'), X.btn('更换', () => draw(true), 'ghost'),
          X.btn('删除', async () => { try { await A.nativeCommand('delete_key', { slot }); cfg.hasKey = false; modelLists.clear(); A.save(); after(); draw(false); } catch(e) { A.toast(String(e), 5000); } }, 'ghost'));
        return;
      }
      const i = h('input', { class: 'sx-in', type: 'password', placeholder: 'sk-…', style: 'width:190px', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API Key' });
      const eye = h('button', { class: 'ib', type: 'button', title: '显示 / 隐藏', 'aria-label': '显示或隐藏 Key', html: A.icon('eye', 15) });
      eye.addEventListener('click', () => { const show = i.type === 'password'; i.type = show ? 'text' : 'password'; eye.innerHTML = A.icon(show ? 'eyeoff' : 'eye', 15); });
      const save = async () => {
        const v = i.value.trim(); if (!v) { i.focus(); return; }
        try { await A.nativeCommand('save_key', { slot, key: v }); cfg.hasKey = true; modelLists.clear(); A.save(); i.value = ''; after(); draw(false); A.toast('Key 已保存到钥匙串'); } catch(e) { A.toast(String(e), 5000); }
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
    i.addEventListener('change', () => { delete cfg.visionSupported; cfg[k] = i.value.trim(); A.save(); after(); });
    return i;
  };

  function modelPicker(cfg, slot, after) {
    const wrap = h('div', { style: 'width:270px;max-width:100%' });
    const select = h('select', { class: 'sx-in', style: 'width:100%', 'aria-label': slot === 'chat' ? '对话模型' : '看图模型' });
    const manual = field(cfg, 'model', 270, '填写服务商提供的模型 ID', after);
    manual.hidden = true; manual.setAttribute('aria-label', '手动填写模型名');
    const status = h('div', { class: 'sx-d', style: 'margin-top:6px;overflow-wrap:anywhere' });
    const key = JSON.stringify([slot, cfg.provider, cfg.base]);
    const options = models => {
      select.replaceChildren();
      if (!models.includes(cfg.model)) select.append(h('option', { value: cfg.model || '' }, cfg.model ? `${cfg.model}（当前）` : '请选择模型'));
      models.forEach(id => select.append(h('option', { value: id }, id)));
      select.append(h('option', { value: '__kbot_manual__' }, '手动填写模型名…'));
      select.value = cfg.model || '';
    };
    options([]);
    const refresh = X.btn('刷新列表', () => load(true), 'ghost');
    refresh.disabled = !cfg.hasKey || !cfg.base;
    const load = async force => {
      if (!cfg.hasKey || !cfg.base) { status.textContent = '保存 API Key 后自动获取可用模型'; return; }
      refresh.disabled = true; status.className = 'sx-d'; status.textContent = '正在获取可用模型…';
      try {
        if (force || !modelLists.has(key)) modelLists.set(key, A.nativeCommand('list_models', { slot, config: { ...cfg } }));
        const models = await modelLists.get(key);
        options(models);
        status.textContent = models.length ? `${models.length} 个可用模型` : '服务商返回了空列表，可手动填写模型名';
      } catch (error) { status.textContent = `${String(error)}；可手动填写`; status.className = 'sx-d bad'; }
      finally { refresh.disabled = false; }
    };
    select.addEventListener('change', () => {
      manual.hidden = select.value !== '__kbot_manual__';
      if (!manual.hidden) { manual.focus(); return; }
      delete cfg.visionSupported; cfg.model = select.value; A.save(); after();
    });
    wrap.append(select, manual, h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:4px' }, [refresh, status]));
    if (A.native) load(false); else status.textContent = '桌面应用中可读取服务商模型列表';
    return wrap;
  }

  function testRow(cfg, slot) {
    const row = X.row('连接测试', '会向服务商发送一次文本和一次小图片测试', null);
    const out = $$('.sx-d', row)[0], b = X.btn('测试连接', async () => {
      b.disabled = true; out.className = 'sx-d'; out.textContent = '正在测试文本连接…';
      try {
        await A.nativeCommand('test_model', { slot, config: cfg, vision: false });
        out.textContent = '文本连接成功，正在测试图片…';
        try { await A.nativeCommand('test_model', { slot, config: cfg, vision: true }); cfg.visionSupported = true; out.textContent = '连接成功 · 文本 ✓ · 图片 ✓'; }
        catch { cfg.visionSupported = false; out.textContent = '连接成功 · 文本 ✓ · 当前模型未通过图片测试'; }
        out.className = 'sx-d ok'; A.save(); A.deriveModel();
      } catch(e) { out.textContent = String(e); out.className = 'sx-d bad'; }
      finally { b.disabled = false; }
    });
    row.append(h('div', { class: 'sx-c' }, b)); return row;
  }

  function searchTestRow() {
    const row = X.row('搜索连接测试', '执行一次搜索，确认 Key、服务权限和来源返回正常', null);
    const out = $$('.sx-d', row)[0], b = X.btn('测试搜索', async () => {
      b.disabled = true; out.className = 'sx-d'; out.textContent = '正在搜索…';
      try {
        const web = A.webSearchState();
        if (web.mode === 'qwen' || web.mode === 'responses') {
          let searched = false; const sources = new Set();
          let finish; const finished = new Promise(resolve => { finish = resolve; });
          const onEvent = new Channel();
          onEvent.onmessage = event => {
            if (event.type === 'search') searched = true;
            if (event.type === 'source') sources.add(event.source.url);
            if (event.type === 'done') finish();
          };
          await A.nativeCommand('chat_stream', { id: crypto.randomUUID(), slot: 'chat', config: { ...A.S.ai.chat, webProtocol: web.mode }, messages: [{ role: 'user', content: '请联网搜索 DeepSeek 官方文档，返回官网链接，简短回答。' }], tools: [], web: true, onEvent });
          await finished;
          out.textContent = sources.size ? `联网搜索成功 · ${sources.size} 个来源` : searched ? '已完成联网搜索，服务商没有返回来源' : '接口连接成功，服务商没有返回实际搜索记录';
        } else {
          const results = await A.nativeCommand('search_web', { provider: A.S.ai.search.provider, config: A.S.ai.chat, query: 'DeepSeek 官方文档' });
          out.textContent = results.length ? `搜索成功 · 返回 ${results.length} 个来源` : '搜索连接成功，本次没有匹配的来源';
        }
        out.className = 'sx-d ok';
      } catch (error) { out.textContent = String(error); out.className = 'sx-d bad'; }
      finally { b.disabled = false; }
    });
    row.append(h('div', { class: 'sx-c' }, b)); return row;
  }

  const providerSel = (cfg, slot, redraw) => {
    const s = h('select', { class: 'sx-in', style: 'width:200px' }, Object.keys(PROVIDERS).map(k => h('option', { value: k }, PROVIDERS[k].name)));
    s.value = cfg.provider;
    s.addEventListener('change', async () => {
      const p = PROVIDERS[s.value];
      try { await A.nativeCommand('delete_key', { slot }); } catch(e) { s.value = cfg.provider; A.toast(String(e), 5000); return; }
      delete cfg.visionSupported;
      Object.assign(cfg, { provider: s.value, base: p.base, model: p[slot === 'chat' ? 'chat' : 'vision'], hasKey: false });
      if (slot === 'chat' && s.value !== 'custom') A.S.ai.search.protocol = 'auto';
      A.save(); redraw(true);
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
      const web = A.webSearchState(), webOk = web.available;
      const searchKey = ai.search.provider === 'tavily' || ai.search.provider === 'brave';
      const defaultSwitch = X.switch(webOk && A.S.webDefault, value => A.set('webDefault', value));
      defaultSwitch.querySelector('input').disabled = !webOk;
      el.append(...[
        warn,
        X.group('对话模型',
          X.row('服务商', 'OpenAI 兼容接口；预设会自动填好地址和示例模型名', providerSel(ai.chat, 'chat', redraw)),
          X.row('API 地址', null, field(ai.chat, 'base', 250, 'https://…/v1', after)),
          X.row('模型', '从当前 API 地址读取可用模型；也可以手动填写', modelPicker(ai.chat, 'chat', after)),
          X.row('API Key', '只保存在 macOS 钥匙串里，不写入普通配置文件', keyCtl(ai.chat, 'chat', after)),
          testRow(ai.chat, 'chat'),
          X.row('工具调用', '用于生成提醒和记忆确认卡；模型不支持时可以关闭，并在提醒列表手动添加', X.switch(ai.chat.tools !== false, v => { ai.chat.tools = v; A.save(); })),
        ),
        supportsImages(ai.chat.model) ? X.note(`「${ai.chat.model}」本身支持图片，不需要再配看图模型。`) : null,
        X.group('看图模型（可选）',
          X.row('单独指定看图模型', '对话模型不支持图片时，发图片就自动改用它，比如通义千问 VL、Grok 视觉模型、GPT-4o', X.switch(ai.vision.on, v => { ai.vision.on = v; A.save(); redraw(true); })),
          ...(ai.vision.on ? [
            X.row('服务商', null, providerSel(ai.vision, 'vision', redraw)),
            X.row('API 地址', null, field(ai.vision, 'base', 250, 'https://…/v1', after)),
            X.row('模型', '从看图服务的 API 地址读取可用模型', modelPicker(ai.vision, 'vision', after)),
            X.row('API Key', '可以和对话模型是同一个服务商，也可以不同', keyCtl(ai.vision, 'vision', after)),
            testRow(ai.vision, 'vision'),
          ] : []),
        ),
        X.group('联网搜索',
          X.row('搜索服务', webOk ? web.mode === 'deepseek' ? 'DeepSeek 官方搜索复用对话模型的 Key，无需另配搜索 Key；搜索按官方规则单独计费' : web.mode === 'qwen' || web.mode === 'responses' ? '由模型服务执行联网；需要所选模型和账户支持，搜索可能单独计费' : '搜索结果会附上来源，并作为参考资料发送给模型' : web.reason,
            h('select', { class: 'sx-in', style: 'width:170px', onchange: async e => { try { await A.nativeCommand('delete_key', { slot: 'search' }); } catch(err) { A.toast(String(err)); return; } ai.search.hasKey = false; ai.search.provider = e.target.value; if (e.target.value !== 'tavily' && e.target.value !== 'brave') ai.search.hasKey = false; A.save(); redraw(true); } },
              SEARCH.map(([v, l]) => h('option', Object.assign({ value: v }, v === ai.search.provider ? { selected: '' } : {}), l)))),
          searchKey ? X.row('搜索服务的 Key', null, keyCtl(ai.search, 'search', after)) : null,
          ai.search.provider === 'builtin' ? X.row('联网接口', '预设服务自动匹配；中转或自定义服务请按其文档选择', h('select', { class: 'sx-in', style: 'width:210px', onchange: e => { ai.search.protocol = e.target.value; A.save(); redraw(true); } },
            [['auto', '自动匹配服务商'], ['responses', 'Responses（OpenAI / Grok）'], ['qwen', '通义兼容联网'], ['deepseek', 'DeepSeek 官方搜索']].map(([v, l]) => h('option', Object.assign({ value: v }, v === (ai.search.protocol || 'auto') ? { selected: '' } : {}), l)))) : null,
          webOk ? searchTestRow() : null,
          X.row('新对话默认开启联网', webOk ? '同时应用于当前空白对话；已有消息的对话请在输入框旁单独开启' : web.reason, defaultSwitch),
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
        X.group('主动陪伴', X.row('让模型说主动陪伴的话', '开启后会按说话频率定期请求模型，把已经选好的本地陪伴句改写成一句短话。关闭时仍说本地的句子。', X.toggle('aiCompanion'))),
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

export {};
