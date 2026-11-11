/* KBOT · 对话：会话数据、历史列表、消息渲染、工具授权卡、主动发言 */
(function () {
  'use strict';
  const A = window.App, { $, h } = A;
  const C = A.chat = { convs: [], cur: null, generating: false };
  const box = $('#messages'), hist = $('#history'), hl = $('.h-list', hist), hs = $('input', hist);
  const DAY = 86400000;
  const EXAMPLES = [
    '20 分钟后提醒我站起来喝口水',
    '帮我搜索一下今天有什么值得看的科技动态',
    '记住我平时喜欢简洁直接、少客套的回复',
    '看看我的养成目录里现在都记了什么',
  ];

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
    id: c.id, title: c.title, t: c.t, dshSessionId: c.dshSessionId || null,
    messages: c.messages.map(m => {
      const o = {
        id: m.id, role: m.role, text: m.text, time: m.time, kind: m.kind, proactive: m.proactive, via: m.via, title: m.title, error: m.error, needModelConfig: !!m.needModelConfig,
        sources: m.sources, citations: m.citations, steps: m.steps, chips: m.chips, card: m.card, done: m.done,
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
        if (st && st.status === 'connecting') { text = '正在连接 DeepSeek Harness…'; cls = 'busy'; }
        else { text = '未连接 DeepSeek Harness · 请检查智能核心设置'; cls = 'off'; }
      } else {
        const mode = st && st.activeMode === 'external' ? '外部 DSH' : st && st.activeMode === 'managed' ? '内置 DSH' : 'DSH';
        text = A.dndLabel() || `已连接 ${mode} · 随时可聊`;
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
      C.cur.messages.push({ id: A.uid(), role: 'assistant', proactive: true, text, status: 'done', time: Date.now() });
      C.render();
      A.save();
    } else if (!box.children.length) C.render();
    else requestAnimationFrame(toBottom);
    if (pro) C.pushPro(pro);
  };

  // ---------- 渲染 ----------
  const ico = (n, s = 14) => A.icon(n, s);
  const abtn = (icon, title, a) => h('button', { title, 'aria-label': title, 'data-a': a, html: ico(icon) });
  const renderText = m => MD.render(citationLinks(m.text, m.citations, m.sources) + (m.status === 'streaming' ? '\u2588' : '')).replace(/\u2588/g, '<span class="caret"></span>');

  function emptyEl() {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'e-face' }, [h('i'), h('i')]),
      h('div', { class: 'e-title' }, '嗨，我是 KBOT～'),
      h('div', { class: 'e-sub' }, '智能核心由 DeepSeek Harness 驱动。查资料、看图片、写日记记忆、设定时提醒都可以直接对我说。'),
      h('div', { class: 'e-chips' }, EXAMPLES.map(t => h('button', { class: 'chip', 'data-a': 'example', 'data-send': t }, t))),
    ]);
  }
  function guideEl() {
    const st = A.dshState || {};
    const connecting = st.status === 'connecting';
    const ws = st.workspacePath || (A.S.dsh && A.S.dsh.workspace) || '~/KBOT';
    return h('div', { class: 'guide' }, [
      h('div', { class: 'e-face' + (connecting ? '' : ' sad') }, [h('i'), h('i')]),
      h('div', { class: 'e-title' }, connecting ? '正在连接 DeepSeek Harness…' : '尚未连接 DeepSeek Harness'),
      h('div', { class: 'e-sub' }, connecting
        ? '正在探测本机运行中的 DSH 实例；若未检测到外部实例，将自动后台启动并挂载养成目录。'
        : (st.error || '请确认本机已安装 DeepSeek Harness 并完成模型登录，或在「智能核心」设置中检查配置。')),
      h('div', { class: 'providers' }, ['DeepSeek Harness', '双模自动连接', '记忆养成', '小米 MiMo 语音'].map(n => h('span', {}, n))),
      h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap' }, [
        !connecting ? h('button', { class: 'btn', 'data-a': 'dsh-retry' }, '重新连接') : null,
        h('button', { class: 'btn primary', 'data-a': 'cfg' }, '智能核心设置'),
      ].filter(Boolean)),
      h('div', { class: 'e-tip' }, `默认养成目录：${ws}`),
    ]);
  }

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

  function traceEl(m) {
    const steps = Array.isArray(m.steps) ? m.steps : [];
    const toolSteps = steps.filter(s => s && s.kind !== 'note');
    const runningStep = toolSteps.find(s => !s.done);
    const doneCount = toolSteps.filter(s => s.done).length;
    const totalTools = toolSteps.length;
    const totalItems = totalTools || steps.length;
    const active = Boolean(runningStep) || (m.status === 'thinking' && !m.text);
    const hasPendingCard = m.card && (m.card.state === 'pending' || m.card.state === 'submitting');
    const defaultOpen = active && !(hasPendingCard && steps.length <= 1);
    const open = typeof m.traceOpen === 'boolean' ? m.traceOpen : defaultOpen;

    let headText;
    if (runningStep) {
      headText = runningStep.t;
    } else if (active) {
      headText = '正在整理结果…';
    } else if (totalTools === 1) {
      headText = `已完成 · ${toolSteps[0].t}`;
    } else if (totalTools > 1) {
      const lastLabel = toolSteps[toolSteps.length - 1]?.t || '';
      headText = lastLabel ? `已完成 ${totalTools} 步 · ${lastLabel}` : `已完成 ${totalTools} 步操作`;
    } else {
      headText = '思考过程';
    }

    const badgeText = active && totalTools > 0
      ? `${Math.min(doneCount + 1, totalTools)}/${totalTools}`
      : (!active && totalItems > 1 ? `${totalTools || totalItems} 步` : '');

    const wrap = h('div', { class: 'trace' + (open ? ' open' : '') + (active ? ' running' : ' done') });
    wrap.append(h('button', {
      type: 'button',
      class: 'trace-head',
      'data-a': 'trace-toggle',
      'aria-expanded': String(open),
      title: open ? '收起任务执行过程' : '展开查看任务执行过程',
    }, [
      active ? h('i', { class: 'spin' }) : h('span', { class: 'trace-ok', html: ico('check', 11) }),
      h('span', { class: 'trace-title' }, headText),
      badgeText ? h('span', { class: 'trace-badge' }, badgeText) : null,
      h('span', { class: 'trace-chev', html: ico('chevron', 13) }),
    ]));

    if (open) {
      const body = h('div', { class: 'trace-body' });
      steps.forEach(s => {
        if (!s || !s.t) return;
        if (s.kind === 'note') {
          body.append(h('div', { class: 'trace-note' }, [
            h('span', { class: 'tn-dot' }),
            h('span', { class: 'tn-text' }, s.t),
          ]));
        } else {
          body.append(h('div', { class: 'trace-step' + (s.done ? ' done' : ' running') }, [
            s.done ? h('span', { class: 'ts-ico', html: ico('check', 11) }) : h('i', { class: 'spin sm' }),
            h('span', { class: 'ts-text' }, s.t),
          ]));
        }
      });
      wrap.append(body);
    }
    return wrap;
  }

  function assistantEl(m) {
    const el = h('div', { class: 'msg assistant', 'data-id': m.id });
    if (m.via) el.append(h('div', { class: 'm-via' }, m.via));
    if (m.steps && m.steps.length) {
      el.append(traceEl(m));
    }
    const cardBeforeText =
      m.card && m.card.type === 'question' && m.card.state !== 'pending' && m.card.state !== 'submitting';
    if (cardBeforeText) el.append(cardEl(m));
    if (m.status === 'thinking' && !(m.steps && m.steps.length) && !m.card) {
      el.append(h('div', { class: 'typing' }, [h('i'), h('i'), h('i')]));
    }
    if (m.text || m.status === 'streaming') el.append(h('div', { class: 'md', html: renderText(m) }));
    if (m.sources && m.sources.length) {
      el.append(h('div', { class: 'sources' }, [
        h('div', { class: 's-title' }, `来源 · ${m.sources.length}`),
        ...m.sources.map((s, i) => h('a', { class: 'src', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, [h('b', {}, String(i + 1)), h('span', { class: 's-t' }, s.title), h('span', { class: 's-d' }, s.site)])),
      ]));
    }
    if (m.chips && m.chips.length && C.cur.messages[C.cur.messages.length - 1] === m) {
      el.append(h('div', { class: 'chips' }, m.chips.map(c => h('button', { class: 'chip', 'data-a': 'chip', 'data-send': c.send }, c.label))));
    }
    if (m.card && !cardBeforeText) el.append(cardEl(m));
    if (m.status === 'stopped') el.append(h('div', { class: 'm-status' }, '已停止生成'));
    if (m.status === 'error') {
      el.append(h('div', { class: 'm-status err' }, [
        h('span', {}, m.error || '回复中断，已保留已输出的内容'),
        h('span', { style: 'display:inline-flex;gap:6px;flex-shrink:0;align-items:center' }, [
          m.needModelConfig ? h('button', { class: 'btn sm primary', 'data-a': 'dsh-console' }, '配置模型') : null,
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
    toBottom();
    if (!C.generating) C.status();
    if (C.refreshComposer) C.refreshComposer();
  };
  C.append = m => {
    const near = nearBottom();
    const first = box.querySelector('.empty, .guide'); if (first) first.remove();
    box.append(msgEl(m));
    if (near || m.role === 'user') toBottom();
  };
  C.paint = m => {
    const el = box.querySelector(`[data-id="${m.id}"]`); if (!el) return;
    const near = nearBottom(); el.replaceWith(msgEl(m)); if (near) toBottom();
  };
  C.paintText = m => {
    const el = elOf(m.id), md = el && el.querySelector(':scope > .md');
    if (!md) return C.paint(m);
    const near = nearBottom(); md.innerHTML = renderText(m); if (near) toBottom();
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
      A.voice?.speakText?.(m.text, { force: true }).catch(err => A.toast(String(err), 4000));
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
      const steps = Array.isArray(m.steps) ? m.steps : [];
      const active = steps.some(s => s && s.kind !== 'note' && !s.done) || (m.status === 'thinking' && !m.text);
      const hasPendingCard = m.card && (m.card.state === 'pending' || m.card.state === 'submitting');
      const defaultOpen = active && !(hasPendingCard && steps.length <= 1);
      const curOpen = typeof m.traceOpen === 'boolean' ? m.traceOpen : defaultOpen;
      m.traceOpen = !curOpen;
      C.paint(m);
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
  hs.addEventListener('input', renderHistory);
  hl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('h-item')) C.switchTo(e.target.dataset.id); });
  hl.addEventListener('click', e => {
    const it = e.target.closest('.h-item'); if (!it || e.target.closest('input')) return;
    const c = C.convs.find(x => x.id === it.dataset.id), act = e.target.closest('[data-h]');
    if (!act) { C.switchTo(c.id); return; }
    if (act.dataset.h === 'del') { C.deleteConv(c.id); return; }
    const span = $('span', it), inp = h('input', { class: 'h-rename', value: c.title, maxlength: '40' });
    let finished = false;
    const done = ok => { if (finished) return; finished = true; if (ok && inp.value.trim()) { c.title = inp.value.trim(); A.save(); } renderHistory(); };
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
