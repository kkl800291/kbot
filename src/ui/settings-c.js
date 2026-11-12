import { MIMO_VOICES, MIMO_VOICE_DESIGNS, MIMO_VOICEDESIGN_MODEL } from '../services/voice';

/* KBOT · 设置页（三）：语音（小米 MiMo TTS 语音合成） */
(function () {
  'use strict';
  const A = window.App, { h } = A, X = A.sx, pages = A.settingsPages;

  pages.voice = el => {
    const testStatus = h('span', { class: 'sx-d', style: 'margin-right:8px' }, '');
    const testBtn = X.btn('试听', async () => {
      testBtn.disabled = true;
      testStatus.className = 'sx-d';
      testStatus.textContent = '正在合成并播放…';
      try {
        const out = await A.voice?.speakText?.('你好呀，我是 Kbot！很高兴在你的桌面上陪着你。', {
          force: true,
          emotion: 'happy',
        });
        testStatus.className = 'sx-d ok';
        testStatus.textContent = out?.provider === 'mimo' ? '播放成功（小米 MiMo 语音）' : '播放完成';
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

    const designBtn = X.btn('套用英式 AI 管家', () => {
      const [, , prompt] = MIMO_VOICE_DESIGNS[0];
      A.sput('voice.model', MIMO_VOICEDESIGN_MODEL);
      A.sput('voice.style', prompt);
      A.toast('已套用英式 AI 管家音色，点击“试听”确认效果');
    }, 'ghost');

    el.append(
      X.group('播报',
        X.row('语音', null, X.toggle('voice.enabled')),
        X.row('朗读回复', '自动跳过代码块', X.toggle('voice.autoReply')),
        X.row('朗读提醒和气泡', '勿扰或隐藏时静音', X.toggle('voice.autoProactive')),
      ),
      X.group('发音引擎',
        X.row('引擎', null, h('span', { class: 'sx-status' }, '小米 MiMo 语音')),
        X.row('试听', null, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [testStatus, testBtn, stopBtn])),
      ),
      X.note('需要配置 MiMo API Key。网络或服务不可用时不会朗读。'),
      X.group('小米 MiMo',
        X.row('API 地址', null, X.text('voice.base', { ph: 'https://api.xiaomimimo.com/v1', w: 250, max: 200 })),
        X.row('模型', null, X.text('voice.model', { ph: 'mimo-v2.5-tts', w: 190, max: 80 })),
        X.row('音色', '推荐“冰糖”或“茉莉”', X.select('voice.mimoVoice', MIMO_VOICES, null, 210)),
        X.row('语气风格', '留空时跟随性格与表情', X.text('voice.style', { ph: '自动', w: 250, max: 420, allowEmpty: true })),
        X.row('音色方案', '用文字生成原创音色，不需要上传样本', designBtn),
        X.row('API Key', '只保存在这台 Mac 上', X.keyCtl('voice', 'tts')),
      ),
      X.note('对话里每条回复下方的喇叭按钮，可以单独朗读这一条。'),
    );
  };
})();

export {};
