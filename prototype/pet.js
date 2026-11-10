/* 赛博伙伴 · 角色行为：位置、拖动、悬停、戳一戳、睡眠、勿扰、隐藏 */
(function () {
  'use strict';
  const A = window.App, { $, clamp } = A;
  const petEl = $('#pet'), quick = $('#quick');
  const robot = A.robot = new Robot($('canvas', petEl));
  const pet = A.pet = { x: 0, y: 0 };
  A.hidden = false; A.away = false; A.meeting = false;
  A.dnd = { until: 0 };
  A.missed = [];

  const dims = () => ({ w: parseFloat(robot.canvas.style.width), h: parseFloat(robot.canvas.style.height) });

  // 角色“身体”在屏幕上的矩形（点击与气泡定位都以它为准）
  const B = Robot.BOX, fx = u => u / Robot.W, fy = u => u / Robot.H;
  A.petBody = () => {
    const { w, h } = dims();
    return {
      left: pet.x + w * fx(B.l), right: pet.x + w * fx(B.r),
      top: pet.y + h * fy(B.t), bottom: pet.y + h * fy(B.b),
      cx: pet.x + w / 2, cy: pet.y + h * fy(B.cy),
    };
  };

  A.setPetPos = (x, y, persist) => {
    const { w, h } = dims();
    const minX = 8 - w * fx(B.l), maxX = innerWidth - 8 - w * fx(B.r);
    const minY = 36 - h * fy(B.t), maxY = innerHeight - 6 - h * fy(B.b);
    pet.x = clamp(x, minX, Math.max(minX, maxX));
    pet.y = clamp(y, minY, Math.max(minY, maxY));
    petEl.style.transform = `translate(${pet.x}px, ${pet.y}px)`;
    if (persist) {
      const b = A.petBody();
      A.S.pos = { fx: b.cx / innerWidth, fy: b.cy / innerHeight };
      A.save();
    }
    A.emit('petmove');
  };
  A.placePet = () => {
    const { w, h } = dims();
    if (A.S.pos) A.setPetPos(A.S.pos.fx * innerWidth - w / 2, A.S.pos.fy * innerHeight - h * fy(B.cy));
    else A.setPetPos(innerWidth - w - 24, innerHeight - h - 16);
  };
  A.resizePet = px => {
    const c = A.petBody();
    robot.setSize(px);
    const { w, h } = dims();
    A.setPetPos(c.cx - w / 2, c.cy - h * fy(B.cy), true);
  };

  A.applyLook = () => {
    const S = A.S, root = document.documentElement;
    root.classList.toggle('theme-dark', S.theme === 'dark');
    root.classList.toggle('theme-light', S.theme === 'light');
    root.classList.toggle('reduced', !!S.reduced);
    root.classList.toggle('no-top', S.onTop === false);
    root.style.setProperty('--glow-rgb', Robot.PALETTES[S.palette].join(', '));
    robot.palette = S.palette; robot.shell = S.shell; robot.reduced = !!S.reduced;
    if (robot.size !== S.size) A.resizePet(S.size);
  };
  A.setBase = name => { robot.setBase(name); A.emit('base', name); };

  // ---- 悬停与快捷按钮 ----
  let overPet = false, overQuick = false, leaveTimer = 0, drag = null;
  const panelOpen = () => A.panel && A.panel.isOpen();
  function placeQuick() {
    const b = A.petBody(), qw = quick.offsetWidth || 88, qh = quick.offsetHeight || 62;
    const right = b.right + 8 + qw < innerWidth - 8;
    quick.style.left = (right ? b.right + 4 : b.left - qw - 4) + 'px';
    quick.style.top = clamp(b.cy - qh / 2, 36, innerHeight - qh - 8) + 'px';
  }
  function setOver(p, q) {
    overPet = p; overQuick = q;
    robot.hover = p && !drag && !panelOpen();
    clearTimeout(leaveTimer);
    if ((p || q) && !drag && !panelOpen() && !A.hidden) { placeQuick(); quick.classList.add('show'); }
    else leaveTimer = setTimeout(() => quick.classList.remove('show'), 200);
  }
  A.refreshHover = () => setOver(overPet, overQuick);
  quick.addEventListener('pointerenter', () => setOver(overPet, true));
  quick.addEventListener('pointerleave', () => setOver(overPet, false));
  quick.addEventListener('click', e => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    if (b.dataset.q === 'dnd') A.isDnd() ? A.setDnd(0) : A.setDnd(30);
    else A.openSettings && A.openSettings();
  });

  addEventListener('pointermove', e => {
    robot.lookAtPoint(e.clientX, e.clientY);
    A.touch();
    if (drag) return;
    const blocked = e.target.closest && e.target.closest('#panel, .bubble, #menu, #console');
    const over = !A.hidden && !blocked && robot.hitTest(e.clientX, e.clientY);
    petEl.classList.toggle('interactive', over);
    if (over !== overPet) setOver(over, overQuick);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { petEl.classList.remove('interactive'); setOver(false, false); });
  addEventListener('keydown', () => A.touch());

  // ---- 拖动与点击 ----
  let lastClick = -1e9, burst = [];
  petEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    try { petEl.setPointerCapture(e.pointerId); } catch (_) { /* 指针已结束时忽略 */ }
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pet.x, oy: pet.y, lx: e.clientX, ly: e.clientY, moved: false };
    robot.press();
    A.menu.close();
  });
  petEl.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 5) {
      drag.moved = true; robot.release(false); robot.setHeld(true); robot.hover = false;
      petEl.classList.add('dragging'); quick.classList.remove('show');
    }
    if (drag.moved) {
      robot.drag(e.clientX - drag.lx, e.clientY - drag.ly);
      A.setPetPos(drag.ox + dx, drag.oy + dy);
    }
    drag.lx = e.clientX; drag.ly = e.clientY;
  });
  function endDrag(e) {
    if (!drag) return;
    const d = drag; drag = null;
    petEl.classList.remove('dragging');
    try { petEl.releasePointerCapture(d.id); } catch (_) { /* 已释放 */ }
    if (d.moved) {
      robot.setHeld(false); robot.drop(); robot.flash('happy', 1100);
      A.setPetPos(pet.x, pet.y, true);
      setOver(overPet, overQuick);
    } else {
      const click = e.type === 'pointerup';
      robot.release(click);
      if (click) onClick();
    }
  }
  petEl.addEventListener('pointerup', endDrag);
  petEl.addEventListener('pointercancel', endDrag);
  petEl.addEventListener('contextmenu', e => { e.preventDefault(); if (A.openContextMenu) A.openContextMenu(e.clientX, e.clientY); });

  // 450ms 内的连续点击算“戳”：第一下照常开关面板，之后的点击不再开关
  function onClick() {
    const now = performance.now();
    burst = burst.filter(t => now - t < 1500); burst.push(now);
    const gap = now - lastClick; lastClick = now;
    if (gap > 450) { A.panel.toggle(); return; }
    const n = burst.length;
    if (n === 2) robot.flash('surprised', 700);
    else if (n < 6) {
      robot.flash('annoyed', 1800);
      if (n === 3 && !panelOpen()) A.say('哼，再戳我就要记小本本了。', { expr: 'annoyed' });
    } else {
      robot.flash('happy', 2200);
      if (n === 6 && !panelOpen()) A.say('哈哈，好痒好痒！别戳啦～', { expr: 'happy' });
    }
  }

  // ---- 勿扰、会议、离开、隐藏 ----
  A.isDnd = () => A.dnd.until > Date.now() || A.meeting;
  A.dndLabel = () => A.meeting ? '勿扰中 · 会议进行中（自动）' : A.dnd.until > Date.now() ? `勿扰中 · 到 ${A.hm(A.dnd.until)}` : '';
  function syncDnd() {
    const on = A.isDnd();
    if (on && robot.base !== 'dnd' && !A.away) A.setBase('dnd');
    if (!on && robot.base === 'dnd') A.setBase('idle');
    $('#tray').classList.toggle('dnd', on);
    const q = $('[data-q="dnd"]', quick);
    q.classList.toggle('on', on); $('span', q).textContent = on ? '结束勿扰' : '勿扰';
    A.emit('dnd', on);
  }
  A.setDnd = m => {
    if (!m) { A.dnd.until = 0; syncDnd(); A.toast('勿扰已结束，我回来啦'); return; }
    let until;
    if (m === 'tomorrow') { const d = new Date(); d.setHours(24, 0, 0, 0); until = d.getTime(); }
    else until = Date.now() + m * 60000;
    A.dnd.until = until;
    if (A.bubble) A.bubble.hideSpeech();
    syncDnd();
    A.toast(`已开启勿扰（到${m === 'tomorrow' ? '明天 0:00' : ' ' + A.hm(until)}）：只有你设的提醒会静默出现`, 3400);
  };
  A.setMeeting = b => {
    A.meeting = !!b; syncDnd();
    A.toast(b ? '检测到会议进行中：自动进入勿扰' : '会议结束，勿扰已解除');
  };
  setInterval(() => {
    if (A.dnd.until && A.dnd.until <= Date.now()) { A.dnd.until = 0; syncDnd(); A.toast('勿扰时间到，已恢复'); }
  }, 1000);

  A.setAway = b => {
    b = !!b;
    if (b === A.away) return;
    A.away = b;
    if (b) { A.setBase('sleep'); if (A.bubble) A.bubble.hide(true); A.toast('模拟：你离开了电脑，角色进入睡眠，期间的提醒先攒着'); }
    else {
      A.setBase(A.isDnd() ? 'dnd' : 'idle'); robot.flash('happy', 2600);
      const miss = A.missed.splice(0), names = [...new Set(miss.map(e => e.title || '提醒'))].join('、');
      A.say(miss.length ? `你回来啦～ 刚才你不在，我替你记着 ${miss.length} 个提醒：${names}。` : '你回来啦！刚才没人陪我，我数了 300 次像素。', { pri: 'mid', expr: 'happy' });
    }
    A.emit('away', b);
  };

  A.setHidden = b => {
    A.hidden = !!b;
    petEl.classList.toggle('hidden', A.hidden); robot.paused = A.hidden;
    if (A.hidden) {
      A.panel.close(); A.bubble.hide(true); quick.classList.remove('show');
      A.toast('角色已隐藏。提醒仍会以系统通知出现，点菜单栏图标可以再叫我出来', 3800);
    } else A.toast('我回来啦～');
    A.emit('hidden', A.hidden);
  };

  // ---- 待机久了犯困，被打扰后醒来 ----
  let last = Date.now(), idleSleep = false;
  A.touch = () => {
    last = Date.now();
    if (!idleSleep) return;
    idleSleep = false;
    if (A.away) return;
    const deep = robot.base === 'sleep';
    A.setBase(A.isDnd() ? 'dnd' : 'idle'); robot.flash('surprised', 900);
    if (deep) setTimeout(() => A.say('你回来啦！刚才没人陪我，我数了 300 次像素。', { expr: 'happy' }), 1000);
  };
  setInterval(() => {
    if (A.away || A.isDnd() || (A.rest && A.rest.phase === 'resting')) return;
    const idle = Date.now() - last;
    if (robot.base === 'idle' && idle > 60000) { idleSleep = true; A.setBase('sleepy'); }
    else if (robot.base === 'sleepy' && idleSleep && idle > 120000) A.setBase('sleep');
  }, 1000);

  // 屏幕尺寸变化时按“相对位置”重新摆放，而不是沿用旧坐标（否则从小窗口放大后角色会卡在角落）
  addEventListener('resize', () => A.placePet());
  A.on('hidden', () => A.refreshHover());
  A.init(() => { A.applyLook(); A.placePet(); syncDnd(); });
})();
