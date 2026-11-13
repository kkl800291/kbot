/* KBOT · 回复生成：思考、联网步骤、流式输出、停止、重新生成、编辑重发 */
(function () {
  'use strict';
  const A = window.App, C = A.chat, { $, h } = A;

  C.send = (text, images = []) => {
    text = (text || '').trim();
    if ((!text && !images.length) || C.generating || A.S.model === 'none') return;
    const conv = C.cur;
    C.dropChips();
    const um = { id: A.uid(), role: 'user', text, images, time: Date.now() };
    conv.messages.push(um);
    if (conv.title === '新对话') conv.title = (text || '图片提问').replace(/\s+/g, ' ').slice(0, 18);
    conv.t = Date.now();
    C.append(um); A.save();
    C.respond(um);
  };

  // 重新生成：去掉这条回复（及其后的内容），用同一条提问再答一次
  C.regenerate = id => {
    if (C.generating) C.stop();
    const msgs = C.cur.messages, i = msgs.findIndex(m => m.id === id);
    if (i < 0) return;
    let u = i - 1; while (u >= 0 && msgs[u].role !== 'user') u--;
    if (u < 0) return;
    const um = msgs[u];
    msgs.length = i; C.render(); C.respond(um);
  };

  // 编辑已发送的消息：就地改成输入框，发送后从这条开始重新对话
  C.edit = id => {
    if (C.generating) C.stop();
    const m = C.find(id), el = $(`.msg[data-id="${id}"]`);
    if (!m || !el) return;
    el.innerHTML = '';
    const ta = h('textarea', { class: 'edit-box', rows: '2' });
    ta.value = m.text;
    const done = ok => {
      if (!ok) { C.paint(m); return; }
      const t = ta.value.trim();
      if (!t && !(m.images && m.images.length)) return;
      const msgs = C.cur.messages; msgs.length = msgs.indexOf(m) + 1;
      m.text = t; C.render(); C.respond(m);
    };
    el.append(ta, h('div', { class: 'm-btns edit-btns' }, [
      h('button', { class: 'btn sm ghost', onclick: () => done(false) }, '取消'),
      h('button', { class: 'btn sm primary', onclick: () => done(true) }, '发送'),
    ]));
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    });
  };
})();

export {};
