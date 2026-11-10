/* 赛博伙伴 · 输入区：文本、图片附件（粘贴/拖入/选择/截图）、联网开关、发送与停止 */
(function () {
  'use strict';
  const A = window.App, C = A.chat, { $, h } = A;
  const input = $('#input'), sendBtn = $('#sendBtn'), attRow = $('#attRow'), hintEl = $('#hint');
  const fileIn = $('#file'), webBtn = $('#webBtn'), shotBtn = $('#shotBtn'), tag = $('#modelTag'), imgBtn = $('[data-t="image"]');
  let atts = [], hintTimer = 0;

  // 原型里的模型配置：仅文本 / 文本模型 + 独立看图模型 / 原生多模态
  const imgOk = () => A.S.model === 'vision' || A.S.model === 'fallback';
  C.modelName = withImages => {
    const { chat, vision } = A.S.ai;
    return A.S.model === 'none' ? '未配置' : A.S.model === 'fallback' && withImages ? `${vision.model}（看图）` : chat.model;
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
    input.disabled = off;
    input.placeholder = off ? '先在设置里配置 AI 服务，才能和我聊天' : '问我点什么，或者说「20 分钟后提醒我…」';
    tag.textContent = C.modelName(atts.length > 0);
    const on = !!C.cur && C.cur.webOn && S.webAvailable;
    webBtn.classList.toggle('on', on); webBtn.classList.toggle('na', !S.webAvailable);
    webBtn.title = !S.webAvailable ? '还没有配置搜索服务' : on ? '本次对话已联网，点击关闭' : '点击开启联网搜索';
    shotBtn.hidden = !S.screenPerm;
    imgBtn.disabled = off; webBtn.disabled = off;
    updateSend();
  };
  ['model', 'webAvailable', 'screenPerm'].forEach(k => A.on('set:' + k, () => { if (C.cur) C.refreshComposer(); }));

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
      // 发送前压缩：长边超过 2048 的大图缩小（原型只演示提示，不真正上传）
      return { id: A.uid(), src: scaled(960, 0.82), thumb: scaled(200, 0.6), ow, oh, color: [r / n, g / n, b / n].map(Math.round), compressed: Math.max(ow, oh) > 2048 };
    } finally { URL.revokeObjectURL(url); }
  }

  C.addFiles = async files => {
    files = Array.from(files).filter(Boolean);
    if (!files.length) return;
    if (A.S.model === 'none') { hint('先配置 AI 服务，才能发图片', true); return; }
    if (!imgOk()) { hint('当前模型不支持图片。请先在 设置 → AI 里配置一个「看图模型」，比如通义千问 VL、Grok 视觉模型或 GPT-4o。', true, 6500); return; }
    const okType = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i, okExt = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
    for (const f of files) {
      if (atts.length >= 4) { hint('一条消息最多 4 张图片，多的我先略过啦', true); break; }
      if (!okType.test(f.type) && !okExt.test(f.name)) { hint(`「${f.name}」不是支持的格式，目前支持 PNG、JPG、WebP、HEIC、GIF`, true, 5200); continue; }
      try { atts.push(await processImage(f)); }
      catch (e) { hint(/heic|heif/i.test(f.type + f.name) ? 'HEIC 在原型里无法预览，正式版会在本地自动转换' : `「${f.name}」打不开，文件可能已损坏`, true, 5200); }
    }
    renderAtts(); C.refreshComposer();
    if (A.panel.isOpen()) input.focus({ preventScroll: true });
  };

  // ---------- 截图提问（模拟区域截图）----------
  function fakeShot(w, hh) {
    const c = document.createElement('canvas'); c.width = Math.round(w * 2); c.height = Math.round(hh * 2);
    const x = c.getContext('2d'); x.scale(2, 2);
    const g = x.createLinearGradient(0, 0, w, hh); g.addColorStop(0, '#1d2236'); g.addColorStop(1, '#2d2a4a');
    x.fillStyle = g; x.fillRect(0, 0, w, hh);
    x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(0, 0, w, 24);
    const cols = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff'];
    for (let y = 40, i = 0; y < hh - 14; y += 18, i++) {
      x.globalAlpha = 0.75; x.fillStyle = cols[i % 5];
      x.fillRect(16, y, Math.min(40 + ((i * 53) % Math.max(60, w - 120)), w - 32), 6);
    }
    x.globalAlpha = 1; x.fillStyle = 'rgba(255,255,255,.75)'; x.font = '12px sans-serif'; x.fillText('屏幕截图（原型模拟）', 12, 16);
    return new Promise(res => c.toBlob(b => res(new File([b], '截图.png', { type: 'image/png' })), 'image/png'));
  }
  function shoot() {
    if (!imgOk()) { hint('当前模型不支持图片，截图也需要先配置看图模型', true, 5200); return; }
    A.panel.close();
    const ov = h('div', { id: 'shot', html: '<div class="shot-tip">拖动鼠标框选要提问的区域 · Esc 取消</div><div class="shot-box" hidden><span></span></div>' });
    document.body.append(ov);
    const box = $('.shot-box', ov), lab = $('span', box);
    let st = null;
    const rect = e => ({ x: Math.min(st.x, e.clientX), y: Math.min(st.y, e.clientY), w: Math.abs(e.clientX - st.x), h: Math.abs(e.clientY - st.y) });
    const end = () => { ov.remove(); removeEventListener('keydown', onKey, true); };
    // 取消后回到刚才的对话，而不是让面板消失
    const cancel = () => { end(); A.panel.open(); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    addEventListener('keydown', onKey, true);
    ov.addEventListener('pointerdown', e => {
      st = { x: e.clientX, y: e.clientY }; box.hidden = false;
      try { ov.setPointerCapture(e.pointerId); } catch (_) { /* 指针已结束时忽略 */ }
    });
    ov.addEventListener('pointermove', e => {
      if (!st) return;
      const r = rect(e);
      Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      lab.textContent = `${r.w} × ${r.h}`;
    });
    ov.addEventListener('pointerup', async e => {
      if (!st) return;
      const r = rect(e); end();
      if (r.w < 24 || r.h < 24) { A.toast('框选区域太小，已取消'); A.panel.open(); return; }
      const file = await fakeShot(r.w, r.h);
      A.panel.open();
      setTimeout(() => C.addFiles([file]), 60);
    });
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
    if (!imgOk()) { hint('当前模型不支持图片。请先在 设置 → AI 里配置一个「看图模型」，比如通义千问 VL、Grok 视觉模型或 GPT-4o。', true, 6500); return; }
    fileIn.click();
  });
  fileIn.addEventListener('change', () => { const f = Array.from(fileIn.files); fileIn.value = ''; C.addFiles(f); });
  shotBtn.addEventListener('click', shoot);
  webBtn.addEventListener('click', () => {
    if (!A.S.webAvailable) { hint('还没有配置搜索服务：服务商自带联网的话直接开启，否则请在 设置 → AI 里填一个搜索服务的 Key。', false, 6000); return; }
    C.cur.webOn = !C.cur.webOn; C.refreshComposer(); A.save();
    A.toast(C.cur.webOn ? '本次对话已开启联网搜索' : '本次对话已关闭联网搜索');
  });
  C.focusInput = () => { if (!input.disabled) input.focus({ preventScroll: true }); };
  A.init(() => { C.refreshComposer(); });
})();
