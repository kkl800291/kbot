/* KBOT · 输入区：文本、图片附件（粘贴/拖入/选择/截图）、回复朗读开关、发送与停止 */
(function () {
  'use strict';
  const A = window.App, C = A.chat, { $, h } = A;
  const input = $('#input'), sendBtn = $('#sendBtn'), attRow = $('#attRow'), hintEl = $('#hint');
  const fileIn = $('#file'), voiceBtn = $('#voiceBtn'), shotBtn = $('#shotBtn'), tag = $('#modelTag'), imgBtn = $('[data-t="image"]');
  let atts = [], hintTimer = 0;

  const imgOk = () => A.S.model !== 'none';
  C.modelName = () => {
    const st = A.dshState;
    if (!st || !st.connected) return st && st.status === 'connecting' ? 'DSH 连接中…' : 'DSH 未连接';
    const label = st.modelLabel || st.model;
    return label || 'DeepSeek Harness';
  };
  C.imageSupported = imgOk;

  function hint(msg, warn, ms = 4200) {
    hintEl.textContent = msg; hintEl.className = 'hint' + (warn ? ' warn' : ''); hintEl.hidden = false;
    clearTimeout(hintTimer); hintTimer = setTimeout(() => { hintEl.hidden = true; }, ms);
  }
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };

  function updateSend() {
    const gen = C.generating;
    sendBtn.classList.toggle('stop', gen);
    sendBtn.innerHTML = A.icon(gen ? 'stop' : 'send', 16);
    sendBtn.title = gen ? '停止生成' : '发送（Enter）';
    sendBtn.disabled = !gen && (A.S.model === 'none' || (!input.value.trim() && !atts.length));
  }
  C.setGenerating = b => { C.generating = b; updateSend(); };

  C.refreshComposer = () => {
    const S = A.S, off = S.model === 'none';
    const st = A.dshState;
    const connecting = st && st.status === 'connecting';
    input.disabled = off;
    input.placeholder = off
      ? (connecting ? '正在连接 DeepSeek Harness…' : '连接 DeepSeek Harness 后即可开始对话')
      : '和我聊聊，或者说「20 分钟后提醒我…」';
    const mName = C.modelName();
    tag.innerHTML = '';
    tag.append(h('span', { class: 'mt-name' }, mName));
    if (st && st.connected) {
      tag.insertAdjacentHTML('beforeend', A.icon('chevron', 11));
    }
    tag.title = st && st.connected
      ? `当前模型：DSH · ${mName}${st.model && st.model !== mName ? ` (${st.model})` : ''}（点击切换模型）`
      : '点击管理 DeepSeek Harness 模型连接';
    const voiceOn = !!(S.voice && S.voice.enabled && S.voice.autoReply);
    if (voiceBtn) {
      voiceBtn.classList.toggle('on', voiceOn);
      voiceBtn.title = voiceOn ? '已开启回复自动朗读（点击关闭）' : '点击开启回复自动朗读（小米 MiMo 语音）';
      voiceBtn.setAttribute('aria-pressed', String(voiceOn));
      voiceBtn.disabled = false;
    }
    shotBtn.hidden = !S.screenPerm;
    imgBtn.disabled = off;
    updateSend();
  };
  ['model', 'screenPerm', 'voice'].forEach(k => A.on('set:' + k, () => { if (C.cur) C.refreshComposer(); }));
  A.on('dsh:state', () => { if (C.cur) C.refreshComposer(); });

  // ---------- 图片 ----------
  function renderAtts() {
    attRow.innerHTML = ''; attRow.hidden = !atts.length;
    atts.forEach(a => attRow.append(h('div', { class: 'att' }, [
      h('img', { src: a.thumb, alt: '待发送的图片' }),
      h('button', { title: '移除', 'aria-label': '移除图片', html: A.icon('x', 11), onclick: () => { atts = atts.filter(x => x !== a); renderAtts(); C.refreshComposer(); } }),
      a.compressed ? h('em', {}, '已压缩') : null,
    ])));
  }

  async function processImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const ow = img.naturalWidth, oh = img.naturalHeight;
      const scaled = (edge, q) => {
        const k = Math.min(1, edge / Math.max(ow, oh)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(ow * k)); c.height = Math.max(1, Math.round(oh * k));
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', q);
      };
      const s = document.createElement('canvas'); s.width = s.height = 8;
      const sx = s.getContext('2d'); sx.drawImage(img, 0, 0, 8, 8);
      const d = sx.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      // 发送前压缩：长边超过 2048 的大图缩小（在本地缩放后再交由 DSH 处理）
      return { id: A.uid(), src: scaled(2048, 0.85), thumb: scaled(200, 0.6), ow, oh, color: [r / n, g / n, b / n].map(Math.round), compressed: Math.max(ow, oh) > 2048 };
    } finally { URL.revokeObjectURL(url); }
  }

  C.addFiles = async files => {
    files = Array.from(files).filter(Boolean);
    if (!files.length) return;
    if (A.S.model === 'none') { hint('先连接 DeepSeek Harness 后再发送图片', true); return; }
    const okType = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i, okExt = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
    for (const f of files) {
      if (atts.length >= 4) { hint('一条消息最多 4 张图片，多的我先略过啦', true); break; }
      if (!okType.test(f.type) && !okExt.test(f.name)) { hint(`「${f.name}」不是支持的格式，目前支持 PNG、JPG、WebP、HEIC、GIF`, true, 5200); continue; }
      try { atts.push(await processImage(f)); }
      catch (e) { hint(/heic|heif/i.test(f.type + f.name) ? '此 HEIC 图片无法解码，请先导出为 PNG 或 JPG' : `「${f.name}」打不开，文件可能已损坏`, true, 5200); }
    }
    renderAtts(); C.refreshComposer();
    if (A.panel.isOpen()) input.focus({ preventScroll: true });
  };

  async function shoot() {
    if (!imgOk()) { hint('请先连接 DeepSeek Harness', true); return; }
    try { const file = await A.captureScreen(); if (file) C.addFiles([file]); }
    catch (e) { hint(String(e), true, 6000); }
  }

  // ---------- 发送 ----------
  function doSend() {
    if (C.generating || A.S.model === 'none') return;
    const text = input.value.trim();
    if (!text && !atts.length) return;
    const images = atts; atts = []; input.value = ''; autosize(); renderAtts(); hintEl.hidden = true;
    C.send(text, images);
    C.refreshComposer();
  }
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); }
  });
  input.addEventListener('paste', e => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); C.addFiles(files); }
  });
  sendBtn.addEventListener('click', () => (C.generating ? C.stop() : doSend()));
  imgBtn.addEventListener('click', () => {
    if (!imgOk()) { hint('请先连接 DeepSeek Harness 后再添加图片', true); return; }
    fileIn.click();
  });
  fileIn.addEventListener('change', () => { const f = Array.from(fileIn.files); fileIn.value = ''; C.addFiles(f); });
  shotBtn.addEventListener('click', shoot);
  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      const next = !(A.S.voice.enabled && A.S.voice.autoReply);
      if (next) {
        A.S.voice.enabled = true;
        A.S.voice.autoReply = true;
      } else {
        A.S.voice.autoReply = false;
        A.voice?.stop?.();
      }
      A.save(); A.emit('set:voice', A.S.voice); C.refreshComposer();
      const mimoReady = A.S.voice.hasKey;
      A.toast(next
        ? (mimoReady ? '已开启回复自动朗读（小米 MiMo 语音）' : '已开启回复自动朗读（请先在语音设置填写 MiMo Key）')
        : '已关闭回复自动朗读');
    });
  }
  if (tag) {
    tag.addEventListener('click', async () => {
      if (A.menu.isOpen()) { A.menu.close(); return; }
      const r = tag.getBoundingClientRect();
      const st = A.dshState;
      if (!st || !st.connected) {
        A.menu.open([
          { head: 'DeepSeek Harness 未连接' },
          { label: '重新检测连接', fn: () => A.agent?.reconnect?.() },
          { label: '打开 DSH 模型控制台…', fn: () => A.agent?.openConsole?.() },
          { label: '智能核心设置…', fn: () => A.openSettings?.('agent') },
        ], r.left, r.top - 8);
        return;
      }
      try {
        const out = await A.agent?.listModels?.();
        const providers = (out && out.providers) || [];
        const curProvider = (out && out.current && out.current.provider) || st.provider;
        const curModel = (out && out.current && out.current.model) || st.model;
        const items = [];
        providers.forEach((p, idx) => {
          const models = Array.isArray(p.models) ? p.models : [];
          if (!models.length) return;
          if (idx > 0 && items.length > 0) items.push({ sep: true });
          items.push({ head: p.name || p.id });
          models.forEach(m => {
            const active = p.id === curProvider && m.id === curModel;
            items.push({
              label: m.displayName || m.id,
              check: active,
              fn: async () => {
                if (active) return;
                try {
                  const sel = await A.agent?.selectModel?.(p.id, m.id);
                  const shown = (sel && sel.displayName) || m.displayName || m.id;
                  A.toast(`已切换模型为 ${shown}`);
                } catch (err) {
                  A.toast(String(err), 4500);
                }
              },
            });
          });
        });
        if (!items.length) {
          items.push({ head: '尚未检测到已配置凭据的模型' });
        } else {
          items.push({ sep: true });
        }
        items.push(
          { label: '管理模型与 API Key…', fn: () => A.agent?.openConsole?.() },
          { label: '智能核心设置…', fn: () => A.openSettings?.('agent') },
        );
        // Prefer positioning menu just above the model pill inside/near the panel
        A.menu.open(items, r.left, Math.max(8, r.top - Math.min(items.length * 30 + 24, 280)));
      } catch (err) {
        A.toast(String(err), 4000);
      }
    });
  }
  C.focusInput = () => { if (!input.disabled) input.focus({ preventScroll: true }); };
  A.init(() => { C.refreshComposer(); });
})();

export {};
