import {
  DEFAULT_JARVIS_SAMPLE_URL,
  DEFAULT_REALTIME_BASE,
  mergeCustomRealtimeVoices,
  MIMO_VOICES,
  MIMO_VOICE_DESIGNS,
  MIMO_VOICEDESIGN_MODEL,
  normalizeCustomVoices,
  normalizeRealtimeSettings,
  QWEN_REALTIME_MODELS,
  REALTIME_MODES,
  realtimeVoiceOptions,
  removeCustomRealtimeVoice,
} from '../services/voice';

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
    const testRow = X.row('试听', null, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end' }, [testBtn, stopBtn]));
    $$('.sx-l', testRow)[0].append(testStatus);

    const mimoModelInput = X.text('voice.model', { ph: 'mimo-v2.5-tts', w: 190, max: 80 });
    const mimoStyleInput = X.text('voice.style', { ph: '自动', w: 250, max: 420, allowEmpty: true });
    const designBtn = X.btn('套用英式 AI 管家', () => {
      const [, , prompt] = MIMO_VOICE_DESIGNS[0];
      A.sput('voice.model', MIMO_VOICEDESIGN_MODEL);
      A.sput('voice.style', prompt);
      mimoModelInput.value = MIMO_VOICEDESIGN_MODEL;
      mimoStyleInput.value = prompt;
      A.toast('已套用英式 AI 管家音色，点击“试听”确认效果');
    }, 'ghost');

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

    el.append(
      X.group('召唤语音交流',
        X.row('召唤即开启语音交流', '默认关闭。开启后每次唤起都会请求麦克风并自动倾听；关闭时点输入框左侧的麦克风再说话', X.toggle('voice.summonVoice')),
        X.row('语音对话方案', '“自动”模式下，已保存百炼 Key 时优先走实时语音大模型', X.select('voice.realtimeMode', REALTIME_MODES, null, 250)),
      ),
      X.group('阿里云百炼 · 实时语音大模型',
        X.row('WebSocket 地址', '默认北京 DashScope，可切换专属空间接入点', X.text('voice.realtimeBase', { ph: DEFAULT_REALTIME_BASE, w: 250, max: 240 })),
        X.row('实时模型', null, modelSelect),
        X.row('实时音色', '复刻后的音色将出现在列表顶部；可随时切换回官方预设', voiceSelect),
        cloneRow,
        customVoicesSlot,
        X.row('自定义音色 ID', '也可直接粘贴百炼控制台生成的 voice_id', customIdInput),
        X.row('API Key', '只保存在这台 Mac 上', X.keyCtl('voice', 'realtime', null, 'realtimeHasKey')),
      ),
      X.note('实时语音开启后支持全双工随时插话打断；涉及读写记忆、文件、命令或定时提醒时会自动桥接本机 DeepSeek Harness 执行。'),
      X.group('播报',
        X.row('语音', null, X.toggle('voice.enabled')),
        X.row('朗读回复', '自动跳过代码块', X.toggle('voice.autoReply')),
        X.row('朗读提醒和气泡', '勿扰或隐藏时静音', X.toggle('voice.autoProactive')),
      ),
      X.group('发音引擎',
        X.row('引擎', null, h('span', { class: 'sx-status' }, '小米 MiMo 语音')),
        testRow,
      ),
      X.note('对话窗自动朗读与本机听写回退模式使用小米 MiMo 语音。'),
      X.group('小米 MiMo',
        X.row('API 地址', null, X.text('voice.base', { ph: 'https://api.xiaomimimo.com/v1', w: 250, max: 200 })),
        X.row('模型', null, mimoModelInput),
        X.row('音色', '推荐“冰糖”或“茉莉”', X.select('voice.mimoVoice', MIMO_VOICES, null, 210)),
        X.row('语气风格', '留空时跟随性格与表情', mimoStyleInput),
        X.row('音色方案', '用文字生成原创音色，不需要上传样本', designBtn),
        X.row('API Key', '只保存在这台 Mac 上', X.keyCtl('voice', 'tts')),
      ),
      X.note('对话里每条回复下方的喇叭按钮，可以单独朗读这一条。'),
    );
    drawCustomVoices();
  };
})();

export {};
