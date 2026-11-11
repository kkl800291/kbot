import { MIMO_VOICES, listVoices } from '../services/voice';

/* KBOT · 设置页（三）：语音（小米 MiMo TTS 语音合成与 macOS 系统朗读回退） */
(function () {
  'use strict';
  const A = window.App, { h } = A, X = A.sx, pages = A.settingsPages;

  const PROVIDERS = [
    ['mimo', '小米 MiMo TTS（mimo-v2.5-tts · 推荐）'],
    ['say', 'macOS 系统语音（离线可用）'],
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
    const testBtn = X.btn('试听语音', async () => {
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
      X.group('语音播报开关',
        X.row('启用语音功能', '开启后支持自动播报提醒与回复；输入框底部工具栏也可一键开关回复朗读', X.toggle('voice.enabled')),
        X.row('自动朗读对话回复', '每次 DSH 回复完成后自动用当前音色朗读文本内容（自动过滤代码块与表情标记）', X.toggle('voice.autoReply')),
        X.row('自动朗读主动提醒与气泡', '定时提醒、回来问候等气泡出现时同步语音播报（勿扰或隐藏时自动静音）', X.toggle('voice.autoProactive')),
      ),
      X.group('语音合成引擎',
        X.row('首选发音引擎', '选择小米 MiMo 时，若未配置 Key 或网络异常会自动无缝回退到 macOS 系统语音', X.select('voice.provider', PROVIDERS, null, 250)),
        X.row('效果试听', '点击试听当前所选语音引擎与音色（选择 MiMo 时将严格校验接口连通性）', h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [testStatus, testBtn, stopBtn])),
      ),
      X.group('小米 MiMo TTS 配置',
        X.row('API 地址', '默认使用小米 MiMo 官方 OpenAI 兼容接口地址', X.text('voice.base', { ph: 'https://api.xiaomimimo.com/v1', w: 250, max: 200 })),
        X.row('语音模型', '默认 mimo-v2.5-tts，支持通过自然语言指令控制情绪与语气', X.text('voice.model', { ph: 'mimo-v2.5-tts', w: 190, max: 80 })),
        X.row('预设音色', '中文陪伴推荐「冰糖」或「茉莉」', X.select('voice.mimoVoice', MIMO_VOICES, null, 210)),
        X.row('自定义语气风格（可选）', '留空则根据角色性格与每次回复的实时表情（开心、思考、提醒等）自动生成风格指令', X.text('voice.style', { ph: '留空自动跟随角色性格与表情', w: 250, max: 140, allowEmpty: true })),
        X.row('MiMo API Key', '独立保存在本机受保护凭据库（0600 仅当前用户可读，版本升级不再弹出钥匙串授权窗）', X.keyCtl('voice', 'tts')),
      ),
      X.group('macOS 系统语音（离线与自动回退）',
        X.row('系统发音人', '在离线环境或切换至系统语音时使用', saySelect),
        X.row('系统语速', '默认 190 词/分钟', X.num('voice.rate', { min: 100, max: 320, unit: '词/分钟', w: 72 })),
      ),
      X.note('提示：你还可以在对话窗每条回复下方的操作栏点击小喇叭图标，单独朗读任意一条历史回复。'),
    );
  };
})();

export {};
