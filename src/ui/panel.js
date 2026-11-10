/* KBOT · 对话面板：弹出/收起、随角色定位、缩放、拖入图片、快捷键 */
(function () {
  'use strict';
  const A = window.App, { $, clamp } = A, robot = A.robot;
  const panel = $('#panel'), input = $('#input'), resizeEl = $('#resize');
  const TOP = 34, M = 8, G = 10;
  let open = false, closeTimer = 0, focusTimer = 0, mode = 'above', anchor = { x: 'right', y: 'bottom' }, prevFocus = null, rs = null;

  const dims = () => ({
    w: clamp(A.S.panelW, 300, Math.max(300, innerWidth - 2 * M)),
    h: clamp(A.S.panelH, 380, Math.max(380, innerHeight - TOP - M)),
  });
  const fits = (m, b, w, h) => {
    const right = b.cx > innerWidth / 2;
    if (m === 'above') return b.top - TOP >= h + G;
    if (m === 'below') return innerHeight - b.bottom - M >= h + G;
    return (right ? b.left - M : innerWidth - b.right - M) >= w + G;
  };
  const limits = m => {
    const b = A.petBody(), right = b.cx > innerWidth / 2;
    return {
      w: m === 'beside' ? (right ? b.left - G - M : innerWidth - b.right - G - M) : innerWidth - 2 * M,
      h: m === 'above' ? b.top - G - TOP : m === 'below' ? innerHeight - b.bottom - G - M : innerHeight - TOP - M,
    };
  };

  // 面板优先放在角色上方，放不下就放到侧面，再不行放下方；opts.keep 表示拖动角色时尽量保持当前方向
  function place(opts = {}) {
    const b = A.petBody(), { w, h } = dims();
    const right = b.cx > innerWidth / 2, lower = b.cy > innerHeight / 2;
    let m = opts.mode;
    if (!m) {
      if (opts.keep && fits(mode, b, w, h)) m = mode;
      else m = ['above', 'beside', 'below'].find(x => fits(x, b, w, h)) || 'above';
    }
    let left, top;
    if (m === 'beside') {
      left = right ? b.left - G - w : b.right + G;
      top = lower ? b.bottom + 10 - h : b.top - 10;
      anchor = { x: right ? 'right' : 'left', y: lower ? 'bottom' : 'top' };
    } else {
      left = right ? b.right + 22 - w : b.left - 22;
      top = m === 'above' ? b.top - G - h : b.bottom + G;
      anchor = { x: right ? 'right' : 'left', y: m === 'above' ? 'bottom' : 'top' };
    }
    left = clamp(left, M, Math.max(M, innerWidth - w - M));
    top = clamp(top, TOP, Math.max(TOP, innerHeight - h - M));
    Object.assign(panel.style, {
      left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px',
      transformOrigin: `${b.cx - left}px ${b.cy - top}px`,
    });
    resizeEl.className = 'resize ' + (anchor.y === 'bottom' ? 't' : 'b') + (anchor.x === 'right' ? 'l' : 'r');
    mode = m;
  }

  const focusInput = () => { if (!input.disabled) input.focus({ preventScroll: true }); };

  function openPanel(opts = {}) {
    if (A.hidden || !A.chat?.cur) return;
    if (open) { if (opts.seed) A.chat.onOpen({ seed: opts.seed }); focusInput(); return; }
    A.focusWindow?.();
    open = true; panel.inert = false; clearTimeout(closeTimer);
    prevFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    let pro = null, seed = opts.seed;
    if (seed) A.bubble.hide(true);
    else {
      const ev = A.bubble.takeover();
      if (ev?.kind === 'speech') seed = ev.text;
      else if (ev) pro = ev;
    }
    panel.hidden = false;
    A.chat.onOpen({ seed, pro });
    place();
    void panel.offsetWidth;
    panel.classList.add('open');
    A.refreshHover();
    robot.flash('happy', 700);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (open && !panel.inert && !panel.hidden) focusInput(); }, 30);
    $('#pet').setAttribute('aria-expanded', 'true');
    A.emit('panel', true);
  }

  function closePanel() {
    if (!open) return;
    open = false; panel.inert = true;
    clearTimeout(focusTimer);
    panel.classList.remove('open');
    A.chat.closeHistory();
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!open) panel.hidden = true; }, 240);
    // 焦点还给原来的应用输入框
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); else input.blur();
    prevFocus = null;
    A.refreshHover();
    $('#pet').setAttribute('aria-expanded', 'false');
    A.emit('panel', false);
  }

  A.panel = {
    open: openPanel, close: closePanel, place,
    toggle: () => (open ? closePanel() : openPanel()),
    isOpen: () => open,
  };

  // ---- 放大 / 还原 ----
  function syncExpand() {
    const b = $('#expandBtn');
    b.innerHTML = A.icon(A.S.expanded ? 'shrink' : 'expand');
    b.title = A.S.expanded ? '还原大小' : '放大';
  }
  function toggleExpand() {
    const ex = !A.S.expanded;
    A.S.expanded = ex; A.S.panelW = ex ? 520 : 360; A.S.panelH = ex ? 720 : 480; A.save();
    panel.classList.add('anim'); setTimeout(() => panel.classList.remove('anim'), 280);
    place(); syncExpand();
  }
  $('.p-tools').addEventListener('click', e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    ({ history: () => A.chat.toggleHistory(), new: () => A.chat.newConv(true), expand: toggleExpand, close: closePanel })[b.dataset.p]();
  });

  // ---- 拖动自由角调整大小 ----
  resizeEl.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { resizeEl.setPointerCapture(e.pointerId); } catch (_) { /* 指针已结束时忽略 */ }
    const d = dims();
    rs = { id: e.pointerId, sx: e.clientX, sy: e.clientY, w: d.w, h: d.h, ax: anchor.x, ay: anchor.y, mode };
    panel.classList.add('resizing');
  });
  resizeEl.addEventListener('pointermove', e => {
    if (!rs) return;
    const lim = limits(rs.mode);
    const w = rs.w + (rs.ax === 'right' ? -1 : 1) * (e.clientX - rs.sx);
    const h = rs.h + (rs.ay === 'bottom' ? -1 : 1) * (e.clientY - rs.sy);
    A.S.panelW = Math.round(clamp(w, 300, Math.max(300, lim.w)));
    A.S.panelH = Math.round(clamp(h, 380, Math.max(380, lim.h)));
    A.S.expanded = false;
    place({ mode: rs.mode }); syncExpand();
  });
  const endResize = () => {
    if (!rs) return;
    const id = rs.id; rs = null; panel.classList.remove('resizing');
    try { resizeEl.releasePointerCapture(id); } catch (_) { /* Already released. */ }
    A.save();
  };
  resizeEl.addEventListener('pointerup', endResize);
  resizeEl.addEventListener('pointercancel', endResize);
  resizeEl.addEventListener('lostpointercapture', endResize);
  addEventListener('blur', endResize);

  // ---- 点外部收起、快捷键 ----
  document.addEventListener('pointerdown', e => {
    if (!open || !A.S.outsideClose) return;
    if (e.target.closest('#panel, #pet, #quick, #menu, #lightbox, .bubble, #toast, #console, #notify, #tray, #sheet, #shot')) return;
    closePanel();
  }, true);
  const hotkeyHit = e => { const k = A.S.hotkey; return e.code === k.code && e.altKey === k.alt && e.metaKey === k.meta && e.ctrlKey === k.ctrl && e.shiftKey === k.shift; };
  addEventListener('keydown', e => {
    if (e.defaultPrevented) return;
    if (!A.native && hotkeyHit(e)) {
      e.preventDefault();
      if (A.hidden) A.setHidden(false);
      A.panel.toggle();
    } else if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); if (A.openSettings) A.openSettings(); }
  });

  // ---- 拖入图片：拖到面板或角色身上都可以 ----
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const overPanel = e => open && e.target.closest && e.target.closest('#panel');
  const overPet = e => !A.hidden && robot.hitTest(e.clientX, e.clientY);
  let petHot = false;
  addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const op = !!overPanel(e), ot = overPet(e);
    panel.classList.toggle('dropping', op);
    if (ot && !petHot) robot.flash('surprised', 1500);
    petHot = ot;
    e.dataTransfer.dropEffect = op || ot ? 'copy' : 'none';
  });
  addEventListener('dragleave', e => { if (e.relatedTarget === null) panel.classList.remove('dropping'); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); panel.classList.remove('dropping'); petHot = false;
    if (!overPanel(e) && !overPet(e)) return;
    const files = Array.from(e.dataTransfer.files);
    if (!open) openPanel();
    setTimeout(() => A.chat.addFiles(files), 40);
  });

  A.on('petmove', () => { if (open) place(rs ? { mode: rs.mode } : { keep: true }); });
  addEventListener('resize', () => { if (open) place(); });
  A.init(syncExpand);
})();

export {};
