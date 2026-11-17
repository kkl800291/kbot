import {
  DEFAULT_JARVIS_SAMPLE_URL,
  DEFAULT_REALTIME_BASE,
  DEFAULT_TTS_BASE,
  mergeCustomRealtimeVoices,
  normalizeCustomVoices,
  normalizeRealtimeSettings,
  normalizeTtsSettings,
  QWEN_REALTIME_MODELS,
  QWEN_TTS_MODELS,
  QWEN_TTS_VOICES,
  REALTIME_MODES,
  realtimeVoiceOptions,
  removeCustomRealtimeVoice,
} from '../services/voice';
import { cloudAccountCard } from './cloud-card';

/* KBOT · 设置页（三）：语音（召唤实时语音交流 + 小米 MiMo TTS 语音合成） */
(function () {
  'use strict';
  const A = window.App, { h } = A, X = A.sx, pages = A.settingsPages;

  const fileToBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取本地音频文件失败'));
    reader.readAsDataURL(file);
  });

  pages.voice = el => {
    const { $$ } = A;
    const testStatus = h('div', { class: 'sx-d' }, '');
    const testBtn = X.btn('试听', async () => {
      testBtn.disabled = true;
      testStatus.className = 'sx-d';
      testStatus.textContent = '正在合成并播放…';
      try {
        const out = await A.voice?.speakText?.('你好，我是 Kbot，现在音色和语速都可以随时调整。', {
          force: true,
          emotion: 'happy',
        });
        testStatus.className = 'sx-d ok';
        testStatus.textContent = out?.provider === 'qwen' ? '播放成功（千问 Qwen3-TTS）' : '播放完成';
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
    const testRow = X.row('试听', null, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end' }, [testBtn, stopBtn]));
    $$('.sx-l', testRow)[0].append(testStatus);

    normalizeTtsSettings(A.S.voice);
    const ttsStyleInput = X.text('voice.style', { ph: '留空时跟随性格与表情', w: 250, max: 420, allowEmpty: true });

    let modelSelect;
    let voiceSelect;
    let customIdInput;
    const customVoicesSlot = h('div', {});

    const deleteCustomVoice = async (item, btn) => {
      if (btn) btn.disabled = true;
      cloneStatus.className = 'sx-d';
      cloneStatus.textContent = `正在删除「${item.name}」…`;
      try {
        await A.voice?.deleteRealtimeVoice?.(item.voice);
        const nextList = removeCustomRealtimeVoice(A.S.voice.customVoices, item.voice);
        A.sput('voice.customVoices', nextList);
        if (A.S.voice.realtimeVoice === item.voice) {
          A.S.voice.realtimeVoice = '';
          normalizeRealtimeSettings(A.S.voice);
          A.sput('voice.realtimeVoice', A.S.voice.realtimeVoice);
        }
        cloneStatus.className = 'sx-d ok';
        cloneStatus.textContent = `已删除「${item.name}」`;
        syncVoiceControls();
        A.toast(`已删除定制音色「${item.name}」`);
      } catch (err) {
        cloneStatus.className = 'sx-d bad';
        cloneStatus.textContent = String(err?.message || err);
        A.toast(String(err?.message || err), 5000);
        if (btn) btn.disabled = false;
      }
    };

    const drawCustomVoices = () => {
      const list = normalizeCustomVoices(A.S.voice.customVoices);
      if (!list.length) {
        customVoicesSlot.replaceChildren();
        customVoicesSlot.hidden = true;
        return;
      }
      customVoicesSlot.hidden = false;
      const curVoice = String(A.S.voice.realtimeVoice || '').trim();
      customVoicesSlot.replaceChildren(
        ...list.map(item => {
          const active = item.voice === curVoice;
          const tail = item.voice.slice(-6);
          const modelLabel = item.targetModel ? item.targetModel.replace(/-realtime$/, '') : '未指定模型';
          const useBtn = active
            ? h('span', { class: 'sx-status ok' }, '当前使用')
            : X.btn('使用', () => {
                if (item.targetModel && item.targetModel !== A.S.voice.realtimeModel) {
                  A.sput('voice.realtimeModel', item.targetModel);
                }
                A.sput('voice.realtimeVoice', item.voice);
                syncVoiceControls();
              }, 'ghost');
          const delBtn = X.danger('删除', '确认删除', () => deleteCustomVoice(item, delBtn));
          return X.row(
            item.name,
            `尾号 ${tail} · 绑定 ${modelLabel}`,
            h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end' }, [useBtn, delBtn]),
          );
        }),
      );
    };

    const syncVoiceControls = () => {
      if (modelSelect) modelSelect.value = String(A.S.voice.realtimeModel || '');
      if (voiceSelect) {
        const opts = realtimeVoiceOptions(A.S.voice);
        voiceSelect.replaceChildren(...opts.map(([v, l]) => h('option', { value: String(v) }, l)));
        voiceSelect.value = String(A.S.voice.realtimeVoice || '');
      }
      if (customIdInput) customIdInput.value = String(A.S.voice.realtimeVoice || '');
      drawCustomVoices();
    };

    const cloneStatus = h('div', { class: 'sx-d' }, '');
    const runEnroll = async ({ label, preferredName, sourceUrl, file }) => {
      jarvisBtn.disabled = true;
      uploadBtn.disabled = true;
      syncBtn.disabled = true;
      cloneStatus.className = 'sx-d';
      cloneStatus.textContent = file ? '正在提交音频复刻…' : '正在下载参考干声并提交复刻…';
      try {
        const payload = file
          ? {
              preferredName,
              audioBase64: await fileToBase64(file),
              mimeType: file.type || undefined,
              fileName: file.name,
            }
          : { preferredName, sourceUrl };
        const res = await A.voice?.enrollRealtimeVoice?.(payload);
        if (!res?.voice) throw new Error('声音复刻未返回可用音色');
        const nextList = mergeCustomRealtimeVoices(A.S.voice.customVoices, [
          { voice: res.voice, targetModel: res.targetModel, name: label },
        ]);
        A.sput('voice.customVoices', nextList);
        A.sput('voice.realtimeModel', res.targetModel);
        A.sput('voice.realtimeVoice', res.voice);
        cloneStatus.className = 'sx-d ok';
        cloneStatus.textContent = `已生成并切换为「${label}」`;
        syncVoiceControls();
        A.toast(`已生成并切换为「${label}」音色`);
      } catch (err) {
        cloneStatus.className = 'sx-d bad';
        cloneStatus.textContent = String(err?.message || err);
        A.toast(String(err?.message || err), 5000);
      } finally {
        jarvisBtn.disabled = false;
        uploadBtn.disabled = false;
        syncBtn.disabled = false;
      }
    };

    const jarvisBtn = X.btn('一键复刻贾维斯', () => runEnroll({
      label: '贾维斯（英伦男声）',
      preferredName: 'jarvis',
      sourceUrl: DEFAULT_JARVIS_SAMPLE_URL,
    }), 'primary');

    const fileInput = h('input', {
      type: 'file',
      accept: '.wav,.mp3,.m4a,audio/*',
      style: 'display:none',
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        A.toast('参考音频不能超过 10 MB', 4000);
        return;
      }
      const stem = file.name.replace(/\.[^.]+$/, '').trim() || '自定义音色';
      runEnroll({ label: stem, preferredName: stem, file });
    });
    const uploadBtn = X.btn('上传音频复刻', () => fileInput.click(), 'ghost');

    const syncBtn = X.btn('同步已有音色', async () => {
      jarvisBtn.disabled = true;
      uploadBtn.disabled = true;
      syncBtn.disabled = true;
      cloneStatus.className = 'sx-d';
      cloneStatus.textContent = '正在查询账号已复刻音色…';
      try {
        const list = await A.voice?.listRealtimeVoices?.();
        const nextList = mergeCustomRealtimeVoices(A.S.voice.customVoices, list || []);
        A.sput('voice.customVoices', nextList);
        cloneStatus.className = 'sx-d ok';
        cloneStatus.textContent = nextList.length ? `已同步 ${nextList.length} 个定制音色` : '账号下暂无复刻音色';
        syncVoiceControls();
      } catch (err) {
        cloneStatus.className = 'sx-d bad';
        cloneStatus.textContent = String(err?.message || err);
      } finally {
        jarvisBtn.disabled = false;
        uploadBtn.disabled = false;
        syncBtn.disabled = false;
      }
    }, 'ghost');

    modelSelect = X.select('voice.realtimeModel', QWEN_REALTIME_MODELS, () => {
      if (normalizeRealtimeSettings(A.S.voice)) {
        A.sput('voice.realtimeVoice', A.S.voice.realtimeVoice);
      }
      syncVoiceControls();
    }, 250);

    voiceSelect = X.select('voice.realtimeVoice', realtimeVoiceOptions(A.S.voice), v => {
      const custom = normalizeCustomVoices(A.S.voice.customVoices).find(c => c.voice === v);
      if (custom?.targetModel && custom.targetModel !== A.S.voice.realtimeModel) {
        A.sput('voice.realtimeModel', custom.targetModel);
      }
      syncVoiceControls();
    }, 250);

    customIdInput = X.text('voice.realtimeVoice', {
      ph: '或输入自定义 voice_id',
      w: 250,
      max: 160,
      after: () => syncVoiceControls(),
    });

    const cloneRow = X.stackRow(
      '声音复刻（自定义音色）',
      '使用 10–20 秒无背景音干声（WAV / MP3 / M4A，<10 MB），绑定当前所选实时模型',
      h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end' }, [jarvisBtn, uploadBtn, syncBtn, fileInput]),
    );
    $$('.sx-l', cloneRow)[0].append(cloneStatus);

    const cloudSlot = h('div', {});
    const drawCloud = () => {
      cloudSlot.replaceChildren(cloudAccountCard(A, { modeKey: 'voiceMode', onModeChange: () => drawCloud() }));
    };
    drawCloud();
    el._redraw = drawCloud;

    el.append(
      cloudSlot,
      X.group('语音通话入口',
        X.row('唤起时直接开启语音通话', '默认关闭。关闭时按快捷键只打开轻量文字输入框（点右侧电话图标随时进入纯语音通话）；开启后每次唤起直接进入纯语音通话界面', X.toggle('voice.summonVoice')),
      ),
      X.group('实时音色与声音复刻',
        X.row('实时对话音色', '复刻后的音色将出现在列表顶部；可随时切换回官方预设', voiceSelect),
        cloneRow,
        customVoicesSlot,
      ),
      X.group('播报与朗读',
        X.row('语音', null, X.toggle('voice.enabled')),
        X.row('朗读回复', '自动跳过代码块', X.toggle('voice.autoReply')),
        X.row('朗读提醒和气泡', '勿扰或隐藏时静音', X.toggle('voice.autoProactive')),
        X.row('朗读音色', '千问 Qwen3-TTS 预设音色，与实时语音共用同一套千问能力', X.select('voice.ttsVoice', QWEN_TTS_VOICES, null, 230)),
        testRow,
      ),
      X.note('实时语音（Qwen-Omni）与消息朗读（Qwen3-TTS）统一基于阿里云千问同一套密钥；对话里每条回复下方的喇叭按钮可单独朗读这一条。'),
      h('details', { class: 'sx-advanced' }, [
        h('summary', {}, '高级连接与自带 API Key（千问统一接入）'),
        X.note('支持由平台托管的体验额度与充值点数网关接入；如需使用自己的阿里云百炼 API Key 或指定托管网关地址，可在此展开配置（实时语音、声音复刻与文字朗读共用这一把 Key）。'),
        X.group('阿里云百炼统一凭据',
          X.row('百炼 API Key', '同时驱动千问实时语音与 Qwen3-TTS 朗读，只保存在这台 Mac 上', X.keyCtl('voice', 'realtime', v => { A.sput('voice.hasKey', !!v); }, 'realtimeHasKey')),
          X.row('语音对话方案', '“自动”模式下，已连接百炼能力时优先走实时语音大模型', X.select('voice.realtimeMode', REALTIME_MODES, null, 250)),
        ),
        X.group('实时语音进阶参数',
          X.row('WebSocket 地址', '默认北京 DashScope，可切换托管网关或专属空间接入点', X.text('voice.realtimeBase', { ph: DEFAULT_REALTIME_BASE, w: 250, max: 240 })),
          X.row('实时模型', null, modelSelect),
          X.row('自定义音色 ID', '也可直接粘贴百炼控制台生成的 voice_id', customIdInput),
        ),
        X.group('千问朗读（Qwen3-TTS）进阶参数',
          X.row('REST 地址', '默认北京 DashScope，可切换托管网关', X.text('voice.base', { ph: DEFAULT_TTS_BASE, w: 250, max: 200 })),
          X.row('朗读模型', 'qwen3-tts-instruct-flash 支持自定义语气指令', X.select('voice.model', QWEN_TTS_MODELS, null, 250)),
          X.row('语气指令', '配合 instruct 模型使用，留空时跟随性格与表情', ttsStyleInput),
        ),
      ]),
    );
    drawCustomVoices();
  };
})();

export {};
