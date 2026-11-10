/* 赛博伙伴 · 设置页（一）：通用、角色、作息、日期 */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;
  const look = () => A.applyLook();

  // ---------- 通用 ----------
  const PAL_NAMES = { cyan: '青色', violet: '紫色', amber: '琥珀', mint: '薄荷' };
  function swatches() {
    const el = h('div', { class: 'sx-swatches' }, Object.keys(Robot.PALETTES).map(k => h('button', {
      type: 'button', 'data-pal': k, title: PAL_NAMES[k] || k, 'aria-label': PAL_NAMES[k] || k, style: `--c:${Robot.PALETTES[k].join(',')}`,
    })));
    const sync = () => $$('button', el).forEach(b => b.classList.toggle('on', b.dataset.pal === A.S.palette));
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      A.sput('palette', b.dataset.pal); look(); sync();
    });
    sync();
    return el;
  }

  pages.general = el => el.append(
    X.group('启动与窗口',
      X.row('开机启动', '登录 macOS 后自动出现在桌面，默认关闭', X.toggle('autostart')),
      X.row('角色置顶', '关闭后，角色会被其他应用的窗口遮住', X.toggle('onTop', look)),
    ),
    X.group('外观',
      X.row('角色大小', null, X.seg('size', [[96, '小'], [120, '中'], [150, '大']], look)),
      X.row('界面主题', '对话面板、气泡和设置窗口的明暗', X.seg('theme', [['dark', '深色'], ['light', '浅色']], look)),
      X.row('发光颜色', '屏幕脸的主色；提醒、犯困等状态会临时变色', swatches()),
      X.row('机身外壳', null, X.seg('shell', [['light', '亮色'], ['graphite', '石墨']], look)),
      X.row('减少动态效果', '跟随系统设置；开启后面板改为淡入淡出，角色动作更克制', X.toggle('reduced', look)),
    ),
    X.group('声音', X.row('提示音', '提醒出现时播放一声轻响；勿扰时不会响', X.toggle('sound', v => { if (v) A.blip(); }))),
  );

  // ---------- 角色 ----------
  const PERSONAS = [
    ['cute', '可爱淘气', '默认', '你已经 50 分钟没喝水啦，再不喝我就要干巴了。'],
    ['gentle', '温柔', '', '该喝点水了，润润嗓子吧。'],
    ['lively', '元气', '', '补水时间到！咕咚咕咚走起～'],
    ['quiet', '安静简洁', '', '喝水时间。'],
  ];
  const FREQ = {
    low: '安静：自言自语每 2 小时最多 1 次，主动发言每小时最多 2 次。',
    normal: '适中：自言自语每小时最多 1 次，主动发言每小时最多 4 次。',
    high: '话多：自言自语每小时最多 3 次，主动发言每小时最多 8 次。',
  };

  pages.persona = el => {
    const cards = h('div', { class: 'sx-persona' }, PERSONAS.map(([k, name, tag, line]) => h('button', { type: 'button', class: 'sx-pcard', 'data-k': k }, [
      h('b', {}, [name, tag ? h('em', {}, tag) : null]), h('span', {}, `「${line}」`),
    ])));
    const sync = () => $$('.sx-pcard', cards).forEach(b => b.classList.toggle('on', b.dataset.k === A.S.persona));
    cards.addEventListener('click', e => {
      const b = e.target.closest('.sx-pcard'); if (!b) return;
      A.sput('persona', b.dataset.k); sync();
      const line = PERSONAS.find(p => p[0] === b.dataset.k)[3];
      if (!A.hidden && !A.panel.isOpen()) A.bubble.show({ kind: 'speech', pri: 'low', text: line, expr: 'wink' });
    });
    sync();

    const freqNote = X.note(FREQ[A.S.freq]);
    const nick = X.text('nickname', { ph: '你', w: 130, max: 10, after: () => { prev.textContent = preview(); } });
    const preview = () => `例如早安播报：「早安呀${A.S.nickname && A.S.nickname !== '你' ? '，' + A.S.nickname : ''}！今天…」`;
    const prev = X.note(preview());
    el.append(
      X.group('性格倾向', cards),
      X.note('点一下会让我当场说一句，感受语气。性格只改变说话方式，不改变提醒的内容和时间。'),
      X.group('称呼', X.row('你希望我怎么叫你', '默认叫「你」；我自称「我」', nick)),
      prev,
      X.group('主动说话频率', X.row('频率', '用户明确设置的提醒不受限制', X.seg('freq', [['low', '安静'], ['normal', '适中'], ['high', '话多']], v => { freqNote.textContent = FREQ[v]; }))),
      freqNote,
      X.note('两次主动发言之间至少间隔 5 分钟；你连续忽略气泡时，我会自动少说一点。'),
    );
  };

  // ---------- 作息 ----------
  pages.routine = el => {
    const err = h('span', { class: 'sx-err' });
    const ruleCtl = h('span', { class: 'sx-num' }, [
      h('span', { class: 'sx-u' }, '每工作'), X.num('work', { min: 1, max: 999, err }),
      h('span', { class: 'sx-u' }, '分钟，休息'), X.num('rest', { min: 1, max: 120, err }), h('span', { class: 'sx-u' }, '分钟'),
    ]);
    const rows = A.BUILTINS.map(b => {
      const desc = h('div', { class: 'sx-d' }, b.desc());
      const upd = () => { desc.textContent = b.desc(); };
      const pc = !b.param ? null : b.param.type === 'time' ? X.time(b.param.path, upd) : X.num(b.param.path, Object.assign({}, b.param, { after: upd }));
      const row = X.row(b.name, null, [pc, X.switch(A.builtin[b.k] !== false, v => { A.builtin[b.k] = v; A.save(); })]);
      $$('.sx-l', row)[0].append(desc);
      if (b.k === 'rest') { upd(); A.on('set:work', upd); A.on('set:rest', upd); }
      return row;
    });
    const ruleRow = X.row('每工作 N 分钟，休息 M 分钟', '只累计你实际在用电脑的时间；离开电脑达到休息时长，就算已经休息，工作计时清零', ruleCtl);
    $$('.sx-l', ruleRow)[0].append(err);
    el.append(
      X.group('工作时间',
        X.row('工作日', '周一至周五；之外的时间不会主动打扰你', h('span', { class: 'sx-num' }, [X.time('workFrom'), h('span', { class: 'sx-u' }, '至'), X.time('workTo')])),
        X.row('跟随法定节假日与调休', '放假当天按休息日处理，调休的周末按工作日处理', X.toggle('holidays')),
      ),
      X.group('休息规则', ruleRow),
      X.note('提醒休息时可以选「过 10 分钟再说」或「跳过这次」；不会锁屏，也不会全屏遮挡。会议中或全屏演示时不提醒，结束后再说。'),
      X.group('内置提醒', ...rows),
    );
  };

  // ---------- 日期 ----------
  A.birthdays = (A.stored.birthdays || [{ id: 'b1', name: '小美', cal: 'solar', m: 11, d: 12, lead: 1 }]).map(b => Object.assign({}, b));
  A.persisters.birthdays = () => A.birthdays;
  const LM = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  const LD = n => (n <= 10 ? '初' + '一二三四五六七八九十'[n - 1] : n < 20 ? '十' + '一二三四五六七八九'[n - 11] : n === 20 ? '二十' : n < 30 ? '廿' + '一二三四五六七八九'[n - 21] : '三十');
  const bdayDate = b => (b.cal === 'lunar' ? `农历${LM[b.m - 1]}月${LD(b.d)}` : `${b.m}月${b.d}日`);
  const bdayLead = n => (n ? `提前 ${n} 天和当天提醒` : '仅当天提醒');
  A.bdayText = b => `${bdayDate(b)} · ${bdayLead(b.lead)}`;

  function bdayForm(done) {
    const name = h('input', { class: 'sx-in', type: 'text', maxlength: '10', placeholder: '例如：妈妈', style: 'width:150px' });
    const err = h('span', { class: 'sx-err' });
    const mk = (n, f) => Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1) }, f(i + 1)));
    const cal = h('select', { class: 'sx-in' }, [h('option', { value: 'solar' }, '公历'), h('option', { value: 'lunar' }, '农历')]);
    const mon = h('select', { class: 'sx-in' }), day = h('select', { class: 'sx-in' });
    const fill = () => {
      const lunar = cal.value === 'lunar', m = mon.value, d = day.value;
      mon.replaceChildren(...mk(12, i => (lunar ? LM[i - 1] + '月' : i + '月')));
      day.replaceChildren(...mk(lunar ? 30 : 31, i => (lunar ? LD(i) : i + '日')));
      if (m) mon.value = m; if (d) day.value = d;
    };
    cal.addEventListener('change', fill); fill();
    const lead = h('select', { class: 'sx-in' }, [[1, '提前 1 天和当天'], [0, '仅当天'], [3, '提前 3 天和当天'], [7, '提前 7 天和当天']].map(([v, l]) => h('option', { value: String(v) }, l)));
    const save = () => {
      const m = +mon.value, d = +day.value, nm = name.value.trim();
      if (!nm) { err.textContent = '请填写名字'; name.focus(); return; }
      if (cal.value === 'solar' && new Date(2024, m - 1, d).getMonth() !== m - 1) { err.textContent = `${m} 月没有 ${d} 日`; return; }
      A.birthdays.push({ id: A.uid(), name: nm, cal: cal.value, m, d, lead: +lead.value });
      A.save(); A.emit('birthdays'); done();
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    return h('div', { class: 'sx-form' }, [
      h('label', {}, '名字'), name,
      h('label', {}, '生日'), h('div', { class: 'inl' }, [cal, mon, day]),
      h('label', {}, '提醒'), lead,
      h('div', { class: 'full' }, [err, X.btn('取消', done, 'ghost'), X.btn('添加', save, 'primary')]),
    ]);
  }

  pages.dates = el => {
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren();
      if (!A.birthdays.length) list.append(X.empty('还没有添加生日。添加后，我会在前一天和当天提醒你。'));
      A.birthdays.forEach(b => list.append(h('div', { class: 'sx-item' }, [
        h('span', { class: 'ic', html: A.icon('sparkle', 16) }),
        h('div', { class: 'tx' }, [h('div', { class: 'tt' }, b.name), h('div', { class: 'ss' }, A.bdayText(b))]),
        h('div', { class: 'ops' }, [h('button', { class: 'ib', type: 'button', title: '删除', 'aria-label': `删除${b.name}的生日`, html: A.icon('trash', 15), onclick: () => { A.birthdays = A.birthdays.filter(x => x !== b); A.save(); A.emit('birthdays'); } })]),
      ])));
      const add = h('div', { class: 'sx-add' });
      add.append(X.btn('＋ 添加生日', () => { add.replaceWith(bdayForm(draw)); }));
      list.append(add);
    };
    draw();
    el.append(
      X.group('节日与节气', X.row('节日提示', '法定节日、传统节日和常见公历节日；当天早安时提到，部分节日前一天预告', X.toggle('festival')),
        X.row('节气提示', '二十四节气，本地计算，附一句饮食、天气或习俗的小提示', X.toggle('term'))),
      X.group('生日', list),
      X.note('支持公历和农历；自己的生日当天我会有特别的表现。农历和节气都在本机离线计算，不需要联网。'),
    );
  };
})();
