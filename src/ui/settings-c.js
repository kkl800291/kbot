import { MIMO_VOICES, listVoices } from '../services/voice';

/* KBOT · 设置页（三）：语音（小米 MiMo TTS 语音合成与 macOS 系统朗读回退） */
(function () {
  'use strict';
  const A = window.App, { h } = A, X = A.sx, pages = A.settingsPages;

  const PROVIDERS = [
    ['mimo', '小米 MiMo（推荐）'],
    ['say', 'macOS 系统语音'],
  ];

  pages.voice = el => {
    const saySelect = h('select', { class: 'sx-in', style: 'width:210px', 'aria-label': '系统发音人' }, [
      h('option', { value: '' }, '系统默认中文语音'),
    ]);
    saySelect.value = A.S.voice?.sayVoice || '';
    saySelect.addEventListener('change', () => { A.sput('voice.sayVoice', saySelect.value); });

    if (A.native) {
      listVoices(A.nativeCommand).then(voices => {
        const cur = A.S.voice?.sayVoice || '';
        saySelect.replaceChildren(h('option', { value: '' }, '系统默认中文语音'));
        (voices || []).forEach(v => {
          saySelect.append(h('option', { value: v.name }, `${v.name}（${v.locale}）`));
        });
        saySelect.value = cur;
      }).catch(() => {});
    }

    const testStatus = h('span', { class: 'sx-d', style: 'margin-right:8px' }, '');
    const testBtn = X.btn('试听', async () => {
      testBtn.disabled = true;
      testStatus.className = 'sx-d';
      testStatus.textContent = '正在合成并播放…';
      try {
        const useMimo = A.S.voice?.provider === 'mimo';
        const out = await A.voice?.speakText?.('你好呀，我是 KBOT！很高兴在你的桌面上陪着你。', {
          force: true,
          strict: useMimo,
          emotion: 'happy',
        });
        testStatus.className = 'sx-d ok';
        testStatus.textContent = out?.provider === 'mimo' ? '播放成功（小米 MiMo 语音）' : '播放成功（macOS 系统语音）';
      } catch (err) {
        testStatus.className = 'sx-d bad';
        testStatus.textContent = String(err?.message || err);
      } finally {
        testBtn.disabled = false;
      }
    }, 'primary');
    const stopBtn = X.btn('停止', () => {
      A.voice?.stop?.();
      testStatus.textContent = '';
    }, 'ghost');

    el.append(
      X.group('播报',
        X.row('语音', null, X.toggle('voice.enabled')),
        X.row('朗读回复', '自动跳过代码块', X.toggle('voice.autoReply')),
        X.row('朗读提醒和气泡', '勿扰或隐藏时静音', X.toggle('voice.autoProactive')),
      ),
      X.group('发音引擎',
        X.row('引擎', null, X.select('voice.provider', PROVIDERS, null, 190)),
        X.row('试听', null, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [testStatus, testBtn, stopBtn])),
      ),
      X.note('MiMo 没有配置 Key 或网络不通时，会自动改用系统语音。'),
      X.group('小米 MiMo',
        X.row('API 地址', null, X.text('voice.base', { ph: 'https://api.xiaomimimo.com/v1', w: 250, max: 200 })),
        X.row('模型', null, X.text('voice.model', { ph: 'mimo-v2.5-tts', w: 190, max: 80 })),
        X.row('音色', '推荐“冰糖”或“茉莉”', X.select('voice.mimoVoice', MIMO_VOICES, null, 210)),
        X.row('语气风格', '留空时跟随性格与表情', X.text('voice.style', { ph: '自动', w: 250, max: 140, allowEmpty: true })),
        X.row('API Key', '只保存在这台 Mac 上', X.keyCtl('voice', 'tts')),
      ),
      X.group('系统语音',
        X.row('发音人', null, saySelect),
        X.row('语速', null, X.num('voice.rate', { min: 100, max: 320, unit: '词/分钟', w: 72 })),
      ),
      X.note('对话里每条回复下方的喇叭按钮，可以单独朗读这一条。'),
    );
  };
})();

export {};
