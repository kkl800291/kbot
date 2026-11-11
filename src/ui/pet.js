/* KBOT · 角色行为：位置、拖动、悬停、戳一戳、睡眠、勿扰、隐藏 */
(function () {
  'use strict';
  const A = window.App, { $, clamp } = A;
  const petEl = $('#pet');
  const robot = A.robot = new Robot($('canvas', petEl));
  const pet = A.pet = { x: 0, y: 0 };
  A.hidden = false; A.away = false; A.meeting = false;
  A.dnd = { until: 0 };
  A.missed = [];

  const dims = () => ({ w: parseFloat(robot.canvas.style.width), h: parseFloat(robot.canvas.style.height) });

  // 角色“身体”在屏幕上的矩形（点击与气泡定位都以它为准）
  const fx = u => u / Robot.W, fy = u => u / Robot.H;
  A.petBody = () => {
    const { w, h } = dims(), B = robot.box;
    return {
      left: pet.x + w * fx(B.l), right: pet.x + w * fx(B.r),
      top: pet.y + h * fy(B.t), bottom: pet.y + h * fy(B.b),
      cx: pet.x + w / 2, cy: pet.y + h * fy(B.cy),
    };
  };

  A.setPetPos = (x, y, persist) => {
    const { w, h } = dims(), B = robot.box;
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
    const { w, h } = dims(), B = robot.box;
    if (A.S.pos) A.setPetPos(A.S.pos.fx * innerWidth - w / 2, A.S.pos.fy * innerHeight - h * fy(B.cy));
    else A.setPetPos(innerWidth - w - 24, innerHeight - h - 16);
  };
  A.resizePet = px => {
    const c = A.petBody();
    robot.setSize(px);
    const { w, h } = dims(), B = robot.box;
    A.setPetPos(c.cx - w / 2, c.cy - h * fy(B.cy), true);
  };

  A.applyLook = () => {
    const S = A.S, root = document.documentElement;
    root.classList.toggle('theme-dark', S.theme === 'dark');
    root.classList.toggle('theme-light', S.theme === 'light');
    root.classList.toggle('shell-graphite', S.shell === 'graphite');
    root.classList.toggle('reduced', !!S.reduced);
    root.classList.toggle('no-top', S.onTop === false);
    root.style.setProperty('--glow-rgb', (Robot.PALETTES[S.palette] || Robot.PALETTES.blue).join(', '));
    robot.palette = S.palette; robot.shell = S.shell; robot.reduced = !!S.reduced;
    if (robot.size !== S.size) A.resizePet(S.size);
  };
  A.setBase = name => { robot.setBase(name); A.emit('base', name); };

  // ---- 悬停（不弹出悬浮快捷按钮，设置与勿扰统一走右键菜单）----
  let overPet = false, drag = null;
  petEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); A.panel.toggle(); } });
  const panelOpen = () => A.panel && A.panel.isOpen();
  function setOver(p) {
    overPet = !!p;
    robot.hover = overPet && !drag && !panelOpen() && !A.hidden;
    A.emit('pethover');
  }
  A.refreshHover = () => setOver(overPet);
  A.updatePetHover = (x, y) => {
    if (drag) return;
    const target = document.elementFromPoint(x, y);
    const blocked = target?.closest('#panel, .bubble, #menu, #console, #sheet.open .sh-win, #onboarding, #lightbox.open');
    const p = !A.hidden && !blocked && robot.hitTest(x, y);
    petEl.classList.toggle('interactive', p);
    if (p !== overPet) setOver(p);
  };

  addEventListener('pointermove', e => {
    robot.lookAtPoint(e.clientX, e.clientY);
    A.touch();
    if (!A.native) A.updatePetHover(e.clientX, e.clientY);
  }, { passive: true });
  document.addEventListener('pointerleave', () => {
    if (A.native) return; // OS cursor samples remain authoritative while unfocused.
    if (!drag) petEl.classList.remove('interactive'); setOver(false);
  });
  addEventListener('keydown', () => A.touch());

  // ---- 拖动与点击 ----
  let lastClick = -1e9, burst = [], suppressClick = false;
  petEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (drag) endDrag({ type: 'cancel' });
    suppressClick = false;
    A.petPointerActive = true;
    A.petPointerAt = performance.now();
    A.petPointerStartedAt = Date.now();
    petEl.classList.add('pressed', 'interactive');
    try { petEl.setPointerCapture(e.pointerId); } catch (_) { /* 指针已结束时忽略 */ }
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: pet.x, oy: pet.y, lx: e.clientX, ly: e.clientY, moved: false };
    robot.press();
    A.menu.close();
    A.emit('petpointer', true);
  });
  petEl.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 5) {
      drag.moved = true; robot.release(false); robot.setHeld(true); robot.hover = false;
      petEl.classList.add('dragging');
    }
    if (drag.moved) {
      robot.drag(e.clientX - drag.lx, e.clientY - drag.ly);
      A.setPetPos(drag.ox + dx, drag.oy + dy);
    }
    drag.lx = e.clientX; drag.ly = e.clientY;
  });
  function endDrag(e) {
    if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    suppressClick = d.moved || e.type !== 'pointerup';
    A.petPointerActive = false;
    petEl.classList.remove('dragging', 'pressed');
    robot.setHeld(false);
    try { petEl.releasePointerCapture(d.id); } catch (_) { /* 已释放 */ }
    if (d.moved) {
      robot.setHeld(false); robot.drop(); robot.flash('happy', 1100);
      A.setPetPos(pet.x, pet.y, true);
      setOver(overPet);
    } else {
      const click = e.type === 'pointerup';
      robot.release(click);
    }
    A.emit('petpointer', false);
  }
  petEl.addEventListener('pointerup', endDrag);
  petEl.addEventListener('pointercancel', endDrag);
  petEl.addEventListener('lostpointercapture', e => {
    // A delayed loss from the previous click must not cancel a new capture.
    if (!petEl.hasPointerCapture(e.pointerId)) endDrag(e);
  });
  // Finish the browser's click sequence before changing native window focus.
  // Pointerup only releases the drag; click handles mouse and accessibility alike.
  petEl.addEventListener('click', e => {
    if (e.detail === 0 || !suppressClick) onClick();
    suppressClick = false;
  });
  addEventListener('blur', () => endDrag({ type: 'blur' }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) endDrag({ type: 'cancel' }); });
  A.cancelPetInteraction = () => endDrag({ type: 'cancel' });
  petEl.addEventListener('contextmenu', e => { e.preventDefault(); if (A.openContextMenu) A.openContextMenu(e.clientX, e.clientY); });

  // 每次有效点击都开关面板；连击只影响表情，不拦截点击或插入气泡。
  function onClick() {
    const now = performance.now();
    burst = burst.filter(t => now - t < 1500); burst.push(now);
    const gap = now - lastClick; lastClick = now;
    A.panel.toggle();
    if (gap > 450) return;
    const n = burst.length;
    if (n === 2) robot.flash('surprised', 700);
    else if (n < 6) {
      robot.flash('annoyed', 1800);
    } else {
      robot.flash('happy', 2200);
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
    if (A.meeting === !!b) return;
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
    if (b) { A.setBase('sleep'); if (A.bubble) A.bubble.hide(true); }
    else {
      A.setBase(A.isDnd() ? 'dnd' : 'idle'); robot.flash('happy', 2600);
    }
    A.emit('away', b);
  };

  A.setHidden = b => {
    if (b) A.cancelPetInteraction();
    A.hidden = !!b;
    petEl.inert = A.hidden;
    petEl.setAttribute('aria-hidden', String(A.hidden));
    petEl.classList.toggle('hidden', A.hidden); robot.paused = A.hidden;
    if (A.hidden) {
      A.panel.close(); A.bubble.hide(true);
      A.toast('角色已隐藏。提醒仍会以系统通知出现，点菜单栏图标可以再叫我出来', 3800);
    } else A.toast('我回来啦～');
    A.emit('hidden', A.hidden);
  };

  A.touch = () => {}; // Activity is sampled from macOS, not just this webview.

  // 屏幕尺寸变化时按“相对位置”重新摆放，而不是沿用旧坐标（否则从小窗口放大后角色会卡在角落）
  addEventListener('resize', () => A.placePet());
  A.on('hidden', () => A.refreshHover());
  A.init(() => { A.applyLook(); A.placePet(); syncDnd(); });
})();

export {};
