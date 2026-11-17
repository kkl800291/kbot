import { accountDescription, loginPending } from '../services/account';
import { formatElapsedDuration, summarizeSourceLinks } from '../services/agent';

/* KBOT · 对话：会话数据、历史列表、消息渲染、工具授权卡、主动发言 */
(function () {
  'use strict';
  const A = window.App, { $, h } = A;
  const C = A.chat = { convs: [], cur: null, generating: false };
  const box = $('#messages'), hist = $('#history'), hl = $('.h-list', hist), hs = $('input', hist);
  const DAY = 86400000;
  let openers = null;
  let openersPending = false;

  function requestOpeners() {
    if (openers || openersPending || !A.agent?.suggestOpeners) return;
    openersPending = true;
    A.agent.suggestOpeners().then(list => {
      openersPending = false;
      openers = Array.isArray(list) ? list.slice(0, 4) : [];
      if (C.cur && !C.cur.messages.length && A.S.model !== 'none') C.render();
    }).catch(() => {
      openersPending = false;
      openers = [];
    });
  }

  const citationLinks = (text, _citations, sources) => {
    if (!text || !Array.isArray(sources) || !sources.length) return text || '';
    return String(text).replace(/\[(\d{1,2})\](?!\()/g, (full, n) => {
      const src = sources[Number(n) - 1];
      return src && src.url ? `[${n}](${src.url})` : full;
    });
  };

  const mkConv = () => ({ id: A.uid(), title: '新对话', t: Date.now(), dshSessionId: null, messages: [] });
  const find = id => C.cur && C.cur.messages.find(m => m.id === id);
  const elOf = id => box.querySelector(`.msg[data-id="${id}"]`);
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const toBottom = () => box.scrollTo({ top: box.scrollHeight, behavior: 'auto' });
  C.find = find;

  C.serialize = () => C.convs.filter(c => c.messages.length).map(c => ({
    id: c.id, title: c.title, titleLocked: !!c.titleLocked, titleSource: c.titleSource || null, t: c.t, dshSessionId: c.dshSessionId || null,
    messages: c.messages.map(m => {
      const o = {
        id: m.id, role: m.role, text: m.text, time: m.time, startedAt: m.startedAt ?? null, durationMs: m.durationMs ?? null,
        kind: m.kind, proactive: m.proactive, via: m.via, title: m.title, error: m.error, needModelConfig: !!m.needModelConfig,
        sources: m.sources, citations: m.citations, steps: m.steps, chips: m.chips, card: m.card, done: m.done, accountAction: m.accountAction, refused: !!m.refused,
        ...(typeof m.traceOpen === 'boolean' ? { traceOpen: m.traceOpen } : {}),
        status: m.status === 'streaming' || m.status === 'thinking' ? 'stopped' : m.status,
      };
      if (m.images) o.images = m.images.map(i => ({ src: i.src, thumb: i.thumb || i.src, ow: i.ow, oh: i.oh }));
      return o;
    }),
  }));
  A.persisters.convs = C.serialize;

  // ---------- 状态行 ----------
  C.status = (text, cls) => {
    const s = $('#pSub');
    if (!text) {
      const st = A.dshState;
      if (A.S.model === 'none') {
        if (st && st.status === 'connecting') { text = '正在准备智能核心…'; cls = 'busy'; }
        else { text = '尚未就绪 · 请在设置中检查连接'; cls = 'off'; }
      } else {
        text = A.dndLabel() || '在线 · 随时可聊';
        cls = '';
      }
    }
    s.textContent = text; s.className = 'p-sub' + (cls ? ' ' + cls : '');
  };
  A.on('dnd', () => { if (!C.generating) C.status(); });
  A.on('dsh:state', () => {
    if (!C.generating) {
      C.status();
      if (C.cur && (!C.cur.messages.length || box.querySelector('.guide'))) C.render();
    }
  });

  // ---------- 会话 ----------
  C.newConv = focus => {
    if (C.generating && C.stop) C.stop();
    if (C.cur && !C.cur.messages.length) {
      C.closeHistory(); if (focus) { C.render(); $('#input').focus(); }
      return C.cur;
    }
    const c = mkConv(); C.convs.unshift(c); C.cur = c;
    C.closeHistory(); C.render();
    if (focus && !$('#input').disabled) $('#input').focus();
    return c;
  };
  C.switchTo = id => {
    const c = C.convs.find(x => x.id === id); if (!c) return;
    if (c === C.cur) { C.closeHistory(); C.render(); return; }
    if (C.generating && C.stop) C.stop();
    C.cur = c; C.closeHistory(); C.render();
  };
  C.deleteConv = id => {
    const c = C.convs.find(x => x.id === id); if (!c) return;
    C.convs = C.convs.filter(x => x !== c);
    if (c === C.cur) { C.cur = null; C.newConv(false); }
    A.save(); renderHistory(); A.toast(`已删除对话「${c.title}」`);
  };
  // 按“对话记录保留期限”删除过期对话；当前正在看的对话不删
  C.prune = () => {
    const days = A.S.retention; if (!days) return 0;
    const cut = Date.now() - days * DAY, keep = C.convs.filter(c => c === C.cur || c.t >= cut), n = C.convs.length - keep.length;
    if (n) { C.convs = keep; A.save(); if (hist.classList.contains('open')) renderHistory(); }
    return n;
  };
  C.clearAll = () => { if (C.generating && C.stop) C.stop(); C.convs = []; C.cur = null; C.newConv(false); A.save(); };

  C.onOpen = ({ convId, seed: text, pro } = {}) => {
    if (convId) {
      C.switchTo(convId);
    } else if (text) {
      if (C.cur.messages.length) C.newConv(false);
      C.cur.title = text.slice(0, 18);
      C.cur.titleSource = 'auto';
      C.cur.messages.push({ id: A.uid(), role: 'assistant', proactive: true, text, status: 'done', time: Date.now() });
      C.render();
      A.save();
    } else if (!box.children.length) C.render();
    else if (C.cur.messages.length) requestAnimationFrame(toBottom);
    else box.scrollTo({ top: 0, behavior: 'auto' });
    if (pro) C.pushPro(pro);
  };

  // ---------- 渲染 ----------
  const ico = (n, s = 14) => A.icon(n, s);
  const abtn = (icon, title, a) => h('button', { title, 'aria-label': title, 'data-a': a, html: ico(icon) });
  const renderText = m => MD.render(citationLinks(m.text, m.citations, m.sources));

  function emptyEl() {
    if (!openers) requestOpeners();
    const chips = Array.isArray(openers) && openers.length
      ? h('div', { class: 'e-chips' }, openers.map(t => h('button', { class: 'chip', 'data-a': 'example', 'data-send': t }, t)))
      : h('div', { class: 'e-tip' }, openers ? '直接输入你想聊的' : '正在准备开场建议…');
    return h('div', { class: 'empty' }, [
      h('div', { class: 'e-title' }, '你好，我是 Kbot。'),
      h('div', { class: 'e-sub' }, '查资料、看图片、记笔记或设定时提醒，直接说就好。'),
      chips,
    ]);
  }
  function guideEl() {
    const st = A.dshState || {};
    const connecting = st.status === 'connecting';
    const signedIn = A.accountState?.status === 'credential-stored';
    const pending = loginPending(A.accountState);
    const ws = st.workspacePath || (A.S.dsh && A.S.dsh.workspace) || '~/KBOT';
    return h('div', { class: 'guide' }, [
      h('div', { class: 'e-title' }, connecting ? '正在准备智能核心…' : signedIn ? '正在检查模型连接' : '登录后就可以开始使用。'),
      h('div', { class: 'e-sub' }, connecting
        ? 'KBOT 正在启动智能核心，稍候片刻即可开始。'
        : (st.error || accountDescription(A.accountState))),
      h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap' }, [
        st.connected && !signedIn ? h('button', { class: 'btn primary', 'data-a': 'account-login', disabled: pending || A.accountState?.busy || !A.native }, pending ? '等待浏览器授权…' : '登录账号') : null,
        !connecting && (!st.connected || signedIn) ? h('button', { class: 'btn primary', 'data-a': 'dsh-retry' }, '重新连接') : null,
        pending ? h('button', { class: 'btn', 'data-a': 'account-cancel' }, '取消登录') : null,
        h('button', { class: 'btn', 'data-a': 'cfg' }, '账号与高级设置'),
      ].filter(Boolean)),
      h('div', { class: 'e-tip' }, `默认养成目录：${ws}`),
    ]);
  }
  A.on('account:state', () => {
    if (C.cur && !C.generating && (!C.cur.messages.length || box.querySelector('.guide'))) C.render();
  });

  function userEl(m) {
    const el = h('div', { class: 'msg user', 'data-id': m.id });
    if (m.images && m.images.length) {
      el.append(h('div', { class: 'm-images' }, m.images.map((im, i) => h('img', { src: im.src, alt: `图片 ${i + 1}`, 'data-a': 'img', 'data-i': i }))));
    }
    if (m.text) el.append(h('div', { class: 'm-bubble' }, m.text));
    el.append(h('div', { class: 'm-actions' }, [abtn('copy', '复制', 'copy'), abtn('pencil', '编辑后重新发送', 'edit')]));
    return el;
  }

  const REC_SUFFIX_RE = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  function cleanOptLabel(raw) {
    return String(raw || '').replace(REC_SUFFIX_RE, '').trim() || String(raw || '');
  }

  function questionCardEl(m) {
    const c = m.card;
    const questions = Array.isArray(c.questions) ? c.questions : [];
    const total = questions.length;
    if (!total) return h('div', { class: 'card question cancelled' }, '提问内容为空');

    if (c.state === 'answered') {
      const wrap = h('div', { class: 'card question answered' });
      wrap.append(h('div', { class: 'q-done-head' }, [
        h('span', { class: 'q-done-ico', html: ico('check', 12) }),
        h('span', { class: 'q-done-title' }, total > 1 ? `已完成回答 · 共 ${total} 题` : '已完成回答'),
      ]));
      const ansList = Array.isArray(c.answers) ? c.answers : (A.agent?.buildQuestionAnswers?.(c) || []);
      const ansMap = new Map(ansList.map(a => [a.id, a]));
      const rows = h('div', { class: 'q-sum-list' });
      questions.forEach((q, i) => {
        const ans = ansMap.get(q.id);
        const selLabels = Array.isArray(ans?.selected)
          ? ans.selected.map(raw => {
              const found = Array.isArray(q.options) ? q.options.find(o => o.label === raw) : null;
              return found?.displayLabel || cleanOptLabel(raw);
            })
          : [];
        const custom = typeof ans?.custom === 'string' ? ans.custom.trim() : '';
        const merged = [...selLabels, custom].filter(Boolean).join('；');
        rows.append(h('div', { class: 'q-sum-row' }, [
          total > 1 || q.header
            ? h('span', { class: 'q-sum-k' }, q.header || `问题 ${i + 1}`)
            : null,
          h('span', { class: 'q-sum-v' + (merged ? '' : ' muted') }, merged || '已跳过'),
        ].filter(Boolean)));
      });
      wrap.append(rows);
      return wrap;
    }

    if (c.state === 'cancelled') {
      const wrap = h('div', { class: 'card question cancelled' });
      wrap.append(h('div', { class: 'q-done-head muted' }, [
        h('span', { class: 'q-done-ico muted', html: ico('x', 11) }),
        h('span', { class: 'q-done-title' }, '已取消本次提问'),
      ]));
      return wrap;
    }

    const idx = Math.max(0, Math.min(total - 1, Number(c.index) || 0));
    c.index = idx;
    const curQ = questions[idx];
    c.drafts = c.drafts || {};
    const draft = c.drafts[curQ.id] = c.drafts[curQ.id] || { selected: [], custom: '', skipped: false };
    const submitting = c.state === 'submitting';
    const customTrim = String(draft.custom || '').trim();
    const hasCustomSingle = !curQ.multiSelect && Boolean(customTrim);

    const wrap = h('div', { class: 'card question pending' + (submitting ? ' submitting' : '') });

    // Top bar: header tag + multi-select pill + pager + cancel
    const headLeft = h('div', { class: 'q-head-l' }, [
      h('span', { class: 'q-badge', html: ico('sparkle', 12) + `<span>${MD.esc(curQ.header || '提问 · 等待回答')}</span>` }),
      curQ.multiSelect ? h('span', { class: 'q-pill' }, '可多选') : null,
      c.mode === 'continued' ? h('span', { class: 'q-pill warm' }, '随时补充') : null,
    ].filter(Boolean));

    const headRight = h('div', { class: 'q-head-r' });
    if (total > 1) {
      const prevBtn = h('button', { type: 'button', class: 'q-pg', 'data-a': 'q-prev', title: '上一题' }, '‹');
      const nextBtn = h('button', { type: 'button', class: 'q-pg', 'data-a': 'q-next', title: '下一题' }, '›');
      if (idx <= 0 || submitting) prevBtn.disabled = true;
      if (idx >= total - 1 || submitting) nextBtn.disabled = true;
      headRight.append(h('div', { class: 'q-pager' }, [
        prevBtn,
        h('span', { class: 'q-pg-num' }, `${idx + 1} / ${total}`),
        nextBtn,
      ]));
    }
    const closeBtn = h('button', { type: 'button', class: 'q-close', 'data-a': 'q-cancel', title: '取消本次提问', html: ico('x', 13) });
    if (submitting) closeBtn.disabled = true;
    headRight.append(closeBtn);
    wrap.append(h('div', { class: 'q-head' }, [headLeft, headRight]));

    // Question prompt & optional detail (e.g. plan review markdown)
    wrap.append(h('div', { class: 'q-ask' }, curQ.question || '请选择你的偏好或输入回答：'));
    if (curQ.detail) {
      wrap.append(h('div', { class: 'q-detail md', html: MD.render(curQ.detail) }));
    }

    // Preset options
    const opts = Array.isArray(curQ.options) ? curQ.options : [];
    if (opts.length) {
      const optsBox = h('div', { class: 'q-opts' });
      opts.forEach((opt, i) => {
        const rawSelected = !draft.skipped && Array.isArray(draft.selected) && draft.selected.includes(opt.label);
        const on = rawSelected && !hasCustomSingle;
        const btn = h('button', {
          type: 'button',
          class: 'q-opt' + (on ? ' on' : '') + (rawSelected && hasCustomSingle ? ' shadowed' : ''),
          'data-a': 'q-opt',
          'data-i': String(i),
        }, [
          h('span', {
            class: 'q-idx' + (curQ.multiSelect ? ' box' : ''),
            html: curQ.multiSelect ? (on ? ico('check', 11) : '') : String(i + 1),
          }),
          h('span', { class: 'q-opt-body' }, [
            h('span', { class: 'q-opt-top' }, [
              h('span', { class: 'q-opt-label' }, opt.displayLabel || cleanOptLabel(opt.label)),
              opt.recommended ? h('em', { class: 'q-rec' }, '推荐') : null,
            ].filter(Boolean)),
            opt.description ? h('span', { class: 'q-opt-desc' }, opt.description) : null,
          ].filter(Boolean)),
          !curQ.multiSelect && on ? h('span', { class: 'q-opt-chk', html: ico('check', 13) }) : null,
        ].filter(Boolean));
        if (submitting) btn.disabled = true;
        optsBox.append(btn);
      });
      wrap.append(optsBox);
    }

    // Custom free-form input row
    const customRow = h('div', { class: 'q-custom' + (customTrim ? ' active' : '') });
    customRow.append(
      opts.length
        ? h('span', { class: 'q-idx' }, String(opts.length + 1))
        : h('span', { class: 'q-idx icon', html: ico('pencil', 11) }),
    );
    const ta = h('textarea', {
      class: 'q-input',
      rows: '1',
      placeholder: opts.length
        ? (curQ.multiSelect ? '补充你的其他想法（可选）…' : '输入你的答案…')
        : '输入你的回答，按 Enter 提交…',
    });
    ta.value = draft.custom || '';
    if (submitting) ta.disabled = true;
    customRow.append(ta);
    wrap.append(customRow);

    // Footer actions
    const dots = total > 1
      ? h('div', { class: 'q-dots' }, questions.map((q, qi) => {
          const d = c.drafts[q.id];
          const filled = d && !d.skipped && ((Array.isArray(d.selected) && d.selected.length > 0) || String(d.custom || '').trim());
          return h('i', { class: (qi === idx ? 'cur ' : '') + (filled ? 'done' : '') });
        }))
      : h('span', { class: 'q-foot-tip' }, curQ.multiSelect ? '可勾选多项后提交' : '点击选项或直接输入');

    const skipBtn = h('button', { type: 'button', class: 'btn sm ghost', 'data-a': 'q-skip' }, '跳过');
    const submitBtn = h('button', {
      type: 'button',
      class: 'btn sm primary',
      'data-a': 'q-submit',
    }, submitting ? '提交中…' : (idx < total - 1 ? '下一题' : '提交回答'));
    if (submitting) {
      skipBtn.disabled = true;
      submitBtn.disabled = true;
    }

    wrap.append(h('div', { class: 'q-foot' }, [
      dots,
      h('div', { class: 'q-btns' }, [skipBtn, submitBtn]),
    ]));
    return wrap;
  }

  function cardEl(m) {
    const c = m.card;
    const B = (label, d, cls) => h('button', { class: 'btn sm' + (cls ? ' ' + cls : ''), 'data-a': 'card', 'data-do': d }, label);

    if (c.type === 'question') {
      return questionCardEl(m);
    }

    if (c.type === 'approval') {
      const el = h('div', { class: `card reminder ${c.state}` });
      el.append(h('div', { class: 'c-title', html: ico('shield', 15) + '<span>工具执行确认</span>' }));
      const rows = h('div', { class: 'c-rows' });
      [['工具', c.toolName || 'tool'], ['说明', c.reason || '该操作需要你的授权后才能继续执行']].forEach(([l, v]) => {
        rows.append(h('span', {}, l), h('b', {}, v));
      });
      el.append(rows);
      const foot = h('div', { class: 'c-foot' });
      if (c.state === 'pending') {
        foot.append(B('允许本次', 'allow-once', 'primary'), B('拒绝执行', 'reject', 'ghost'));
      } else if (c.state === 'saved') {
        foot.append(h('span', { class: 'done', html: ico('check') + '已允许本次工具执行' }));
      } else {
        foot.append(h('span', { class: 'done muted' }, '已拒绝本次工具调用'));
      }
      el.append(foot);
      return el;
    }

    // 兼容旧版历史对话里已持久化的卡片展示
    const rem = c.type === 'reminder';
    const el = h('div', { class: `card ${c.type || ''} ${c.state || 'done'}` });
    el.append(h('div', { class: 'c-title', html: ico(rem ? 'bell' : 'bookmark', 15) + `<span>${rem ? '历史提醒记录' : '历史记忆记录'}</span>` }));
    el.append(h('div', { class: 'c-text' }, c.content || c.when || ''));
    return el;
  }

  function isTraceActive(m) {
    const steps = Array.isArray(m.steps) ? m.steps : [];
    const hasRunningStep = steps.some(s => s && s.kind !== 'note' && !s.done);
    return hasRunningStep || m.status === 'thinking' || (m.status === 'streaming' && steps.length > 0);
  }

  function traceDefaultOpen(m) {
    const steps = Array.isArray(m.steps) ? m.steps.filter(s => s && s.t) : [];
    const active = isTraceActive(m);
    const hasPendingCard = m.card && (m.card.state === 'pending' || m.card.state === 'submitting');
    if (active) return !(hasPendingCard && steps.length <= 1);
    return steps.length > 0 && steps.length <= 8;
  }

  function inferStepIcon(s) {
    const valid = new Set(['think', 'globe', 'terminal', 'file', 'clock', 'sparkle', 'tool']);
    if (s?.icon && valid.has(s.icon)) return s.icon;
    const text = String(s?.t || '');
    if (s?.kind === 'reasoning' || /思考/.test(text)) return 'think';
    if (/技能/.test(text)) return 'tool';
    if (/搜索|网页/.test(text)) return 'globe';
    if (/命令/.test(text)) return 'terminal';
    if (/文件|记忆|角色|日记/.test(text)) return 'file';
    if (/定时|提醒/.test(text)) return 'clock';
    return 'tool';
  }

  function traceGridEl() {
    return h('span', { class: 'trace-grid', 'aria-hidden': 'true' },
      Array.from({ length: 9 }, (_, i) => h('i', { style: `--d:${((i % 3) * 0.14 + Math.floor(i / 3) * 0.12).toFixed(2)}s` })),
    );
  }

  let elapsedTimer = 0;
  function syncElapsedTimer() {
    const nodes = box.querySelectorAll('.trace.running .trace-elapsed[data-start]');
    if (!nodes.length) {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = 0; }
      return;
    }
    const update = () => {
      const now = Date.now();
      let alive = 0;
      box.querySelectorAll('.trace.running .trace-elapsed[data-start]').forEach(node => {
        const start = Number(node.dataset.start);
        if (!Number.isFinite(start)) return;
        alive++;
        node.textContent = `正在执行 ${formatElapsedDuration(now - start, true)}`;
      });
      if (!alive && elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = 0; }
    };
    if (!elapsedTimer) elapsedTimer = setInterval(update, 1000);
  }

  function stepDetailText(s) {
    if (!s || typeof s !== 'object') return '';
    const detail = typeof s.detail === 'string' ? s.detail.trim() : '';
    const output = typeof s.output === 'string' ? s.output.trim() : '';
    if (detail && output) return `${detail}\n\n${s.isError ? '错误：' : '结果：'}${output}`;
    return detail || (output ? `${s.isError ? '错误：' : '结果：'}${output}` : '');
  }

  function traceEl(m) {
    const rawSteps = Array.isArray(m.steps) ? m.steps : [];
    const steps = rawSteps.map((s, idx) => ({ s, idx })).filter(item => item.s && item.s.t);
    const active = isTraceActive(m);
    const open = typeof m.traceOpen === 'boolean' ? m.traceOpen : traceDefaultOpen(m);
    const hasSteps = steps.length > 0;
    const started = typeof m.startedAt === 'number' ? m.startedAt : (typeof m.time === 'number' ? m.time : Date.now());

    const wrap = h('div', {
      class: 'trace' + (open ? ' open' : '') + (active ? ' running' : ' done') + (hasSteps ? ' has-steps' : ''),
    });

    if (active) {
      const elapsed = formatElapsedDuration(Date.now() - started, true);
      wrap.append(h('button', {
        type: 'button',
        class: 'trace-head',
        'data-a': 'trace-toggle',
        'aria-expanded': String(open),
        title: open ? '收起执行过程' : '展开查看执行过程',
      }, [
        traceGridEl(),
        h('span', { class: 'trace-title trace-elapsed', 'data-start': String(started) }, `正在执行 ${elapsed}`),
        hasSteps ? h('span', { class: 'trace-chev', html: ico('chevron', 13) }) : null,
      ].filter(Boolean)));
    } else {
      const dur = typeof m.durationMs === 'number'
        ? m.durationMs
        : (typeof m.startedAt === 'number' && typeof m.time === 'number' ? Math.max(0, m.time - m.startedAt) : null);
      const durText = dur != null ? ` ${formatElapsedDuration(dur, false)}` : '';
      const countText = !open && hasSteps ? ` · ${steps.length} 步` : '';
      const headText = m.status === 'stopped'
        ? `已停止${durText}${countText}`
        : m.status === 'error'
          ? `执行中断${durText}${countText}`
          : `任务已完成${durText}${countText}`;
      wrap.append(h('button', {
        type: 'button',
        class: 'trace-head',
        'data-a': 'trace-toggle',
        'aria-expanded': String(open),
        title: open ? '收起任务过程' : '展开任务过程',
      }, [
        h('span', { class: 'trace-title' }, headText),
        hasSteps ? h('span', { class: 'trace-chev', html: ico('chevron', 13) }) : null,
      ].filter(Boolean)));
    }

    if (open && hasSteps) {
      const body = h('div', { class: 'trace-body' });
      steps.forEach(({ s, idx }) => {
        if (s.kind === 'note') {
          body.append(h('div', { class: 'trace-note' }, [
            h('span', { class: 'tn-dot' }),
            h('span', { class: 'tn-text' }, s.t),
          ]));
        } else {
          const iconName = inferStepIcon(s);
          const detailText = stepDetailText(s);
          const hasDetail = Boolean(detailText);
          const stepOpen = hasDetail && Boolean(s.open);
          const rowChildren = [
            s.done
              ? h('span', { class: 'ts-ico', html: ico(iconName, 14) })
              : h('span', { class: 'ts-ico spin-ico' }, [h('i', { class: 'spin sm' })]),
            h('span', { class: 'ts-text' }, s.isError ? `${s.t}（失败）` : s.t),
            hasDetail ? h('span', { class: 'ts-chev', html: ico('chevron', 11) }) : null,
          ].filter(Boolean);
          const stepRow = hasDetail
            ? h('button', {
                type: 'button',
                class: 'trace-step-head',
                'data-a': 'trace-step-toggle',
                'data-i': String(idx),
                'aria-expanded': String(stepOpen),
                title: stepOpen ? '收起详情' : '点击查看详情',
              }, rowChildren)
            : h('div', { class: 'trace-step-head static' }, rowChildren);
          body.append(h('div', {
            class: 'trace-step' + (s.done ? ' done' : ' running') + (stepOpen ? ' open' : '') + (s.isError ? ' is-err' : ''),
          }, [
            stepRow,
            stepOpen ? h('pre', { class: 'trace-step-detail' }, detailText) : null,
          ].filter(Boolean)));
        }
      });
      wrap.append(body);
    }
    return wrap;
  }

  function assistantEl(m) {
    const el = h('div', { class: 'msg assistant', 'data-id': m.id });
    const hasSteps = Boolean(m.steps && m.steps.length);
    const showTrace = hasSteps || (m.status === 'thinking' && !m.card) || (m.status === 'streaming' && hasSteps);
    if (showTrace) {
      el.append(traceEl(m));
    }
    const cardBeforeText =
      m.card && m.card.type === 'question' && m.card.state !== 'pending' && m.card.state !== 'submitting';
    if (cardBeforeText) el.append(cardEl(m));
    if (m.text || m.status === 'streaming') {
      const streaming = m.status === 'streaming';
      const mdEl = h('div', { class: 'md' + (streaming ? ' streaming' : ''), html: renderText(m) });
      if (streaming) {
        requestAnimationFrame(() => {
          if (mdEl.isConnected && mdEl.classList.contains('streaming')) {
            mdEl.classList.toggle('is-tall', mdEl.scrollHeight > 54);
          }
        });
      }
      el.append(mdEl);
    }
    const sourceLinks = summarizeSourceLinks(m.sources);
    if (sourceLinks.length) {
      const nodes = [h('span', { class: 's-label' }, '来源：')];
      sourceLinks.forEach((s, idx) => {
        if (idx > 0) nodes.push(h('span', { class: 's-sep' }, '、'));
        nodes.push(h('a', {
          class: 'src-link',
          href: s.url,
          title: s.title,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, s.label));
      });
      el.append(h('div', { class: 'sources-inline' }, nodes));
    }
    if (m.chips && m.chips.length && C.cur.messages[C.cur.messages.length - 1] === m) {
      el.append(h('div', { class: 'chips' }, m.chips.map(c => h('button', { class: 'chip', 'data-a': 'chip', 'data-send': c.send }, c.label))));
    }
    if (m.card && !cardBeforeText) el.append(cardEl(m));
    if (m.refused && m.status === 'done') el.append(h('div', { class: 'm-status' }, '模型未回答这条请求'));
    if (m.status === 'stopped') el.append(h('div', { class: 'm-status' }, '已停止生成'));
    if (m.status === 'error') {
      el.append(h('div', { class: 'm-status err' }, [
        h('span', {}, m.error || '回复中断，已保留已输出的内容'),
        h('span', { style: 'display:inline-flex;gap:6px;flex-shrink:0;align-items:center' }, [
          m.needModelConfig ? h('button', { class: 'btn sm primary', 'data-a': 'dsh-console' }, '配置模型') : null,
          m.accountAction === 'sign-in' ? h('button', { class: 'btn sm primary', 'data-a': 'account-login' }, '登录账号') : null,
          m.accountAction === 'top-up' ? h('button', { class: 'btn sm primary', 'data-a': 'account-top-up' }, '充值额度') : null,
          h('button', { class: 'btn sm', 'data-a': 'retry' }, '重试'),
        ].filter(Boolean)),
      ]));
    }
    if (m.status === 'done' || m.status === 'stopped' || m.status === 'error') {
      el.append(h('div', { class: 'm-actions' }, [
        abtn('copy', '复制', 'copy'),
        m.text ? abtn('speaker', '朗读回复', 'speak') : null,
        abtn('refresh', '重新生成', 'regen'),
      ].filter(Boolean)));
    }
    return el;
  }

  function proEl(m) {
    const icon = m.kind === 'rest' ? 'leaf' : m.kind === 'remind' ? 'bell' : 'sparkle';
    return h('div', { class: `msg pro ${m.kind}`, 'data-id': m.id }, [
      h('div', { class: 'm-tag', html: ico(icon, 12) + `<span>KBOT 主动说${m.title ? ' · ' + MD.esc(m.title) : ''}</span>` }),
      h('div', { class: 'm-body md', html: MD.render(m.text) }),
      m.ring ? A.makeRing() : null,
      m.actions && !m.done ? h('div', { class: 'm-btns' }, m.actions.map((a, i) => h('button', { class: 'btn sm' + (a.primary ? ' primary' : ''), 'data-a': 'pro', 'data-i': String(i) }, a.label))) : null,
      m.done ? h('div', { class: 'done muted' }, `已处理：${m.done}`) : null,
    ]);
  }

  function msgEl(m) {
    if (m.role === 'user') return userEl(m);
    if (m.role === 'assistant') return assistantEl(m);
    if (m.role === 'pro') return proEl(m);
    return h('div', { class: 'notice', 'data-id': m.id }, m.text);
  }

  C.render = () => {
    box.innerHTML = '';
    const c = C.cur;
    if (A.S.model === 'none') { box.append(guideEl()); c.messages.forEach(m => box.append(msgEl(m))); }
    else if (!c.messages.length) box.append(emptyEl());
    else c.messages.forEach(m => box.append(msgEl(m)));
    if (c.messages.length) toBottom(); else box.scrollTo({ top: 0, behavior: 'auto' });
    syncElapsedTimer();
    if (!C.generating) C.status();
    if (C.refreshComposer) C.refreshComposer();
  };
  C.append = m => {
    const near = nearBottom();
    const first = box.querySelector('.empty, .guide'); if (first) first.remove();
    box.append(msgEl(m));
    syncElapsedTimer();
    if (near || m.role === 'user') toBottom();
  };
  // 每次重画一条消息都广播出去，召唤态的字幕跟着它走
  C.paint = m => {
    A.emit('chat:msg', m);
    const el = box.querySelector(`[data-id="${m.id}"]`); if (!el) return;
    const near = nearBottom(); el.replaceWith(msgEl(m)); syncElapsedTimer(); if (near) toBottom();
  };
  C.paintTrace = m => {
    const el = elOf(m.id), oldTrace = el && el.querySelector(':scope > .trace');
    if (!oldTrace) return C.paint(m);
    const oldBody = oldTrace.querySelector('.trace-body');
    const bodyScroll = oldBody ? oldBody.scrollTop : 0;
    A.emit('chat:msg', m);
    const near = nearBottom();
    const nextTrace = traceEl(m);
    oldTrace.replaceWith(nextTrace);
    const newBody = nextTrace.querySelector('.trace-body');
    if (newBody && bodyScroll > 0) newBody.scrollTop = bodyScroll;
    syncElapsedTimer();
    if (near) toBottom();
  };
  C.paintText = m => {
    const el = elOf(m.id), md = el && el.querySelector(':scope > .md');
    if (!md) return C.paint(m);
    A.emit('chat:msg', m);
    const near = nearBottom();
    const streaming = m.status === 'streaming';
    md.classList.toggle('streaming', streaming);
    md.innerHTML = renderText(m);
    md.classList.toggle('is-tall', streaming && md.scrollHeight > 54);
    if (near) toBottom();
  };
  /** 滚到某条消息的开头（从召唤态的“查看全文”进来时用）。 */
  C.reveal = id => {
    const el = elOf(id); if (!el) return;
    box.scrollTo({ top: Math.max(0, el.offsetTop - box.offsetTop - 8), behavior: 'auto' });
  };
  C.dropChips = () => { C.cur.messages.forEach(m => { if (m.chips) { m.chips = null; const e = elOf(m.id); const c = e && e.querySelector('.chips'); if (c) c.remove(); } }); };

  // 对话面板打开时，主动发言以“KBOT 主动说”的形式出现在对话里
  C.pushPro = ev => {
    const m = { id: A.uid(), role: 'pro', kind: ev.kind || 'speech', text: ev.text, title: ev.title, ring: !!ev.ring, actions: ev.actions || null, time: Date.now() };
    C.cur.messages.push(m); C.cur.t = Date.now(); C.append(m); A.save();
  };

  // ---------- 消息上的操作（事件委托）----------
  async function cardAction(m, d) {
    const c = m.card;
    if (!c || c.type !== 'approval' || c.state !== 'pending') return;
    const allow = d === 'allow-once';
    c.state = allow ? 'saved' : 'cancelled';
    C.paint(m); A.save();
    try {
      await A.agent?.respondApproval?.(c.approvalId, allow ? 'allowed-once' : 'rejected');
    } catch (err) {
      A.toast(String(err), 4500);
    }
  }

  async function submitQuestionCard(m) {
    const c = m.card;
    if (!c || c.type !== 'question' || c.state !== 'pending') return;
    c.state = 'submitting';
    C.paint(m);
    try {
      await A.agent?.respondQuestion?.(m, 'answer');
      C.paint(m);
      A.save();
    } catch (err) {
      c.state = 'pending';
      C.paint(m);
      A.toast(String(err?.message || err), 4500);
    }
  }

  async function cancelQuestionCard(m) {
    const c = m.card;
    if (!c || c.type !== 'question' || c.state !== 'pending') return;
    c.state = 'cancelled';
    C.paint(m);
    A.save();
    try {
      await A.agent?.respondQuestion?.(m, 'cancel');
    } catch (err) {
      A.toast(String(err?.message || err), 4500);
    }
  }

  function advanceOrSubmitQuestion(m, skipCurrent = false) {
    const c = m.card;
    if (!c || c.type !== 'question' || c.state !== 'pending') return;
    const questions = Array.isArray(c.questions) ? c.questions : [];
    const idx = Math.max(0, Math.min(questions.length - 1, Number(c.index) || 0));
    const curQ = questions[idx];
    if (curQ) {
      c.drafts = c.drafts || {};
      const d = c.drafts[curQ.id] = c.drafts[curQ.id] || { selected: [], custom: '', skipped: false };
      if (skipCurrent) {
        d.skipped = true;
        d.selected = [];
        d.custom = '';
      } else {
        const hasVal = (Array.isArray(d.selected) && d.selected.length > 0) || String(d.custom || '').trim().length > 0;
        d.skipped = !hasVal;
      }
    }
    if (idx < questions.length - 1) {
      c.index = idx + 1;
      C.paint(m);
      A.save();
    } else {
      submitQuestionCard(m);
    }
  }

  // 召唤态字幕里的快捷操作：不打开窗口也能批准工具、回答选项题
  C.approve = (m, allow) => cardAction(m, allow ? 'allow-once' : 'deny');
  C.answerOption = (m, label) => {
    const c = m?.card;
    if (!c || c.type !== 'question' || c.state !== 'pending') return;
    const curQ = c.questions?.[c.index || 0];
    if (!curQ || curQ.multiSelect) return;
    c.drafts = c.drafts || {};
    c.drafts[curQ.id] = { selected: [label], custom: '', skipped: false };
    advanceOrSubmitQuestion(m, false);
  };
  C.cancelQuestion = m => cancelQuestionCard(m);
  C.optLabel = opt => opt.displayLabel || cleanOptLabel(opt.label);

  box.addEventListener('input', e => {
    const ta = e.target.closest('.q-input');
    if (!ta) return;
    const mEl = ta.closest('.msg'), m = mEl && find(mEl.dataset.id);
    const c = m?.card;
    if (!c || c.type !== 'question' || c.state !== 'pending') return;
    const curQ = c.questions?.[c.index || 0];
    if (!curQ) return;
    c.drafts = c.drafts || {};
    const d = c.drafts[curQ.id] = c.drafts[curQ.id] || { selected: [], custom: '', skipped: false };
    d.custom = ta.value;
    if (ta.value.trim()) d.skipped = false;
    ta.style.height = 'auto';
    ta.style.height = Math.min(96, ta.scrollHeight) + 'px';
    const customWrap = ta.closest('.q-custom');
    if (customWrap) customWrap.classList.toggle('active', Boolean(ta.value.trim()));
    if (!curQ.multiSelect) {
      const hasText = Boolean(ta.value.trim());
      mEl.querySelectorAll('.q-opt').forEach((btn, i) => {
        const opt = curQ.options?.[i];
        const rawSel = opt && Array.isArray(d.selected) && d.selected.includes(opt.label);
        btn.classList.toggle('on', Boolean(rawSel && !hasText));
        btn.classList.toggle('shadowed', Boolean(rawSel && hasText));
      });
    }
  });

  box.addEventListener('keydown', e => {
    const ta = e.target.closest('.q-input');
    if (!ta) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const mEl = ta.closest('.msg'), m = mEl && find(mEl.dataset.id);
      if (m) advanceOrSubmitQuestion(m, false);
    }
  });

  box.addEventListener('click', e => {
    const link = e.target.closest('a[href]');
    if (link) { e.preventDefault(); A.openUrl(link.getAttribute('href')); return; }
    const t = e.target.closest('[data-a]'); if (!t) return;
    const a = t.dataset.a, mEl = t.closest('.msg'), m = mEl && find(mEl.dataset.id);
    if (a === 'copy' && m) { A.copy(m.text || ''); A.toast('已复制'); }
    else if (a === 'speak' && m && m.text) {
      // 正在朗读时再点一次就是停
      if (A.voice?.speaking) A.voice.stop();
      else A.voice?.speakText?.(m.text, { force: true }).catch(err => A.toast(String(err), 4000));
    }
    else if (a === 'code-copy') {
      A.copy(t.closest('.code').querySelector('pre').textContent);
      t.textContent = '已复制'; setTimeout(() => { t.textContent = '复制'; }, 1300);
    }
    else if (a === 'edit' && m) C.edit(m.id);
    else if (a === 'regen' && m) C.regenerate(m.id);
    else if (a === 'retry' && m) C.regenerate(m.id);
    else if (a === 'img' && m) A.lightbox(m.images[+t.dataset.i].src);
    else if (a === 'chip' || a === 'example') C.send(t.dataset.send, []);
    else if (a === 'trace-toggle' && m) {
      const curOpen = typeof m.traceOpen === 'boolean' ? m.traceOpen : traceDefaultOpen(m);
      m.traceOpen = !curOpen;
      C.paintTrace(m);
      A.save();
    }
    else if (a === 'trace-step-toggle' && m) {
      const step = m.steps?.[+t.dataset.i];
      if (!step) return;
      step.open = !step.open;
      C.paintTrace(m);
      A.save();
    }
    else if (a === 'q-opt' && m && m.card?.type === 'question' && m.card.state === 'pending') {
      const c = m.card;
      const curQ = c.questions?.[c.index || 0];
      const opt = curQ?.options?.[+t.dataset.i];
      if (!curQ || !opt) return;
      c.drafts = c.drafts || {};
      const d = c.drafts[curQ.id] = c.drafts[curQ.id] || { selected: [], custom: '', skipped: false };
      d.skipped = false;
      if (curQ.multiSelect) {
        const cur = Array.isArray(d.selected) ? d.selected : [];
        d.selected = cur.includes(opt.label) ? cur.filter(x => x !== opt.label) : [...cur, opt.label];
      } else {
        d.selected = [opt.label];
        d.custom = '';
      }
      C.paint(m);
      A.save();
    }
    else if ((a === 'q-prev' || a === 'q-next') && m && m.card?.type === 'question' && m.card.state === 'pending') {
      const c = m.card;
      const total = Array.isArray(c.questions) ? c.questions.length : 1;
      const delta = a === 'q-prev' ? -1 : 1;
      c.index = Math.max(0, Math.min(total - 1, (Number(c.index) || 0) + delta));
      C.paint(m);
    }
    else if (a === 'q-skip' && m) advanceOrSubmitQuestion(m, true);
    else if (a === 'q-submit' && m) advanceOrSubmitQuestion(m, false);
    else if (a === 'q-cancel' && m) cancelQuestionCard(m);
    else if (a === 'card' && m) cardAction(m, t.dataset.do);
    else if (a === 'cfg') A.openSettings && A.openSettings('agent');
    else if (a === 'dsh-retry') A.agent?.reconnect?.();
    else if (a === 'dsh-console') A.agent?.openConsole?.();
    else if (a === 'account-login') A.account?.signIn?.();
    else if (a === 'account-cancel') A.account?.cancelSignIn?.();
    else if (a === 'account-top-up') A.account?.openTopUp?.();
    else if (a === 'pro' && m) {
      const act = m.actions && m.actions[+t.dataset.i]; if (!act) return;
      m.done = act.label; C.paint(m);
      if (act.fn) act.fn();
    }
  });

  // ---------- 历史对话 ----------
  C.closeHistory = () => hist.classList.remove('open');
  C.toggleHistory = force => {
    const on = force != null ? force : !hist.classList.contains('open');
    hist.classList.toggle('open', on);
    if (on) { hs.value = ''; renderHistory(); setTimeout(() => hs.focus({ preventScroll: true }), 230); }
  };
  function renderHistory() {
    const q = hs.value.trim().toLowerCase();
    const list = C.convs.filter(c => c.messages.length && (!q || c.title.toLowerCase().includes(q) || c.messages.some(m => (m.text || '').toLowerCase().includes(q))));
    hl.innerHTML = '';
    if (!list.length) { hl.append(h('div', { class: 'h-empty' }, q ? '没有找到相关对话' : '还没有历史对话')); return; }
    const today = new Date().setHours(0, 0, 0, 0), groups = { 今天: [], 昨天: [], 更早: [] };
    list.sort((a, b) => b.t - a.t).forEach(c => {
      const d = Math.round((today - new Date(c.t).setHours(0, 0, 0, 0)) / DAY);
      groups[d <= 0 ? '今天' : d === 1 ? '昨天' : '更早'].push(c);
    });
    Object.keys(groups).forEach(g => {
      if (!groups[g].length) return;
      hl.append(h('div', { class: 'h-group' }, g));
      groups[g].forEach(c => hl.append(h('div', { class: 'h-item' + (c === C.cur ? ' current' : ''), role: 'button', tabindex: '0', 'data-id': c.id }, [
        h('span', {}, c.title),
        h('button', { title: '重命名', 'aria-label': '重命名', 'data-h': 'rename', html: ico('pencil', 13) }),
        h('button', { title: '删除', 'aria-label': '删除', 'data-h': 'del', html: ico('trash', 13) }),
      ])));
    });
  }
  C.refreshHistory = () => { if (hist.classList.contains('open')) renderHistory(); };
  hs.addEventListener('input', renderHistory);
  hl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('h-item')) C.switchTo(e.target.dataset.id); });
  hl.addEventListener('click', e => {
    const it = e.target.closest('.h-item'); if (!it || e.target.closest('input')) return;
    const c = C.convs.find(x => x.id === it.dataset.id), act = e.target.closest('[data-h]');
    if (!act) { C.switchTo(c.id); return; }
    if (act.dataset.h === 'del') { C.deleteConv(c.id); return; }
    const span = $('span', it), inp = h('input', { class: 'h-rename', value: c.title, maxlength: '40' });
    let finished = false;
    const done = ok => { if (finished) return; finished = true; if (ok && inp.value.trim()) { c.title = inp.value.trim(); c.titleLocked = true; c.titleSource = 'manual'; A.save(); } renderHistory(); };
    span.replaceWith(inp); inp.focus(); inp.select();
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } });
    inp.addEventListener('blur', () => done(true));
  });

  A.on('set:model', () => { if (C.cur) C.render(); });
  A.init(() => {
    const saved = A.stored.convs;
    C.convs = Array.isArray(saved) ? saved : [];
    C.cur = null; C.prune(); C.newConv(false);
  });
})();

export {};
