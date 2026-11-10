/* 赛博伙伴 · 回复生成：思考、联网步骤、流式输出、停止、重新生成、编辑重发 */
(function () {
  'use strict';
  const A = window.App, C = A.chat, { $, h } = A, robot = A.robot;
  let gen = null;
  A.sim = { offline: false };

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

  C.respond = async um => {
    const conv = C.cur, S = A.S;
    const my = gen = { stop: false, timers: [], wake: [], convId: conv.id };
    const wait = ms => new Promise(res => { const t = setTimeout(res, ms); my.timers.push(t); my.wake.push(res); });
    const dead = () => my.stop;
    const imgs = um.images || [];

    C.setGenerating(true);
    const m = { id: A.uid(), role: 'assistant', text: '', status: 'thinking', time: Date.now() };
    A.countCall();
    if (imgs.length && S.model === 'fallback') m.via = `当前对话模型不支持图片，已自动改用看图模型「${S.ai.vision.model}」`;
    conv.messages.push(m); C.append(m);
    robot.flash('think', 6e5); C.status('思考中…', 'busy');

    const plan = MockAI.plan({ text: um.text, images: imgs, webOn: conv.webOn, webAvailable: S.webAvailable, serious: conv.serious });
    await wait(A.rand(650, 1000)); if (dead()) return;

    if (plan.search) {
      const n = plan.sources.length;
      m.steps = [{ t: `正在搜索：${plan.search}`, done: false }];
      C.status('联网搜索中…', 'busy'); C.paint(m);
      await wait(1300); if (dead()) return;
      m.steps = [{ t: `已搜索：${plan.search}`, done: true }, { t: `正在阅读 ${n} 个来源`, done: false }]; C.paint(m);
      await wait(900); if (dead()) return;
      m.steps[1] = { t: `已阅读 ${n} 个来源`, done: true };
    }

    m.status = 'streaming'; C.paint(m);
    robot.flash('talk', 6e5); C.status('正在回复…', 'busy');
    const full = plan.text, cut = A.sim.offline ? Math.floor(full.length * 0.45) : full.length;
    await new Promise(res => {
      let i = 0;
      const t = setInterval(() => {
        i = Math.min(cut, i + 2 + Math.floor(Math.random() * 3));
        m.text = full.slice(0, i);
        C.paintText(m); robot.talkPulse();
        if (i >= cut) { clearInterval(t); res(); }
      }, 32);
      my.timers.push(t); my.wake.push(res);
    });
    if (dead()) return;

    gen = null;
    robot.clearFlash();
    if (A.sim.offline) {
      A.sim.offline = false;
      m.status = 'error'; C.paint(m);
      robot.flash('sad', 2600); C.status('网络异常 · 回复已中断', 'off');
      setTimeout(() => { if (!C.generating) C.status(); }, 4000);
      C.setGenerating(false); A.save();
      return;
    }
    m.status = 'done'; m.sources = plan.sources; m.chips = plan.chips;
    m.card = plan.card ? Object.assign({}, plan.card) : null;
    if (plan.serious != null) conv.serious = plan.serious;
    if (plan.notice) conv.messages.push({ id: A.uid(), role: 'notice', text: plan.notice });
    C.paint(m);
    if (plan.notice) C.append(conv.messages[conv.messages.length - 1]);
    robot.flash(plan.expr || 'happy', 2400);
    C.setGenerating(false); C.status();
    conv.t = Date.now(); A.save();
    if (!A.panel.isOpen() && !A.isDnd() && !A.hidden) A.say('回复好啦，点我看看～', { pri: 'mid', expr: 'happy' });
  };

  C.stop = () => {
    if (!gen) return;
    const my = gen; gen = null; my.stop = true;
    my.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    my.wake.forEach(f => f());
    const conv = C.convs.find(c => c.id === my.convId);
    const m = conv && conv.messages[conv.messages.length - 1];
    if (m && m.role === 'assistant' && (m.status === 'thinking' || m.status === 'streaming')) {
      m.status = 'stopped';
      if (m.steps) m.steps = m.steps.filter(s => s.done);
      if (conv === C.cur) C.paint(m);
    }
    robot.clearFlash(); C.setGenerating(false); C.status(); A.save();
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
