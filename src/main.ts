import './desktop.css';
import { command, loadState, native, installPersistence } from './services/runtime';
import { installDesktop } from './services/desktop';
import { installWeather } from './services/weather';
import { installVoice } from './services/voice';
import { installAgent } from './services/agent';
import { installAccount } from './services/account';
import { installProactive } from './services/proactive';
import { installUpdater } from './services/updater';
import { onboarding } from './onboarding';
import { installSettingsOwner } from './services/settings-owner';
import { getVersion } from '@tauri-apps/api/app';
import { installInteractionDiagnostics } from './services/interaction-diagnostics';

async function boot() {
  if (native && new URLSearchParams(location.search).get('view') === 'settings') {
    const { bootSettingsWindow } = await import('./settings-window');
    await bootSettingsWindow();
    return;
  }
  window.__COMPANION_STATE__ = await loadState();
  await import('./ui/markdown.js');
  await import('./ui/icons.js');
  await import('./ui/core.js');
  const A = window.App;
  A.native = native;
  if (native) document.documentElement.classList.add('native-host');
  A.version = native ? await getVersion() : '开发预览';
  installPersistence(A);
  if (native) {
    const keys = await command('key_status');
    if (typeof keys.tts === 'boolean') A.S.voice.hasKey = keys.tts;
  }
  await import('./ui/top.js');
  await import('./ui/chat.js');
  await import('./ui/composer.js');
  await import('./ui/reply.js');
  installVoice(A);
  installAgent(A);
  installAccount(A);
  installProactive(A);
  installUpdater(A);
  await import('./ui/settings.js');
  await import('./ui/settings-a.js');
  await import('./ui/settings-b.js');
  await import('./ui/settings-c.js');
  await import('./ui/settings-d.js');
  await import('./ui/menus.js');
  installDesktop(A);
  if (native) await installInteractionDiagnostics(A);
  installWeather(A);
  if (native) await installSettingsOwner(A);
  window.Icons.mount();
  await A.start();
  window.Icons.mount();
  onboarding(A);

  // Isolated native visual QA can open a mode directly; release builds omit this path.
  if (import.meta.env.DEV && native) {
    const preview = new URLSearchParams(location.search).get('visualPreview');
    if (preview && ['idle', 'listen', 'think', 'talk'].includes(preview)) {
      document.querySelector('#onboarding')?.remove();
      A.S.onboarding = true; A.S.outsideClose = false;
      A.summon.open(); A.energy.setMode(preview);
      if (new URLSearchParams(location.search).has('visualCycle')) {
        setTimeout(() => A.summon.close(), 4000);
        setTimeout(() => A.summon.open(), 6500);
      }
    }
  }

  // All links from model output go through the system browser, never inside the webview.
  document.addEventListener('click', event => {
    const a = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && !event.defaultPrevented) { event.preventDefault(); A.openUrl(a.href); }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const lb = document.querySelector('#lightbox')!;
    if (lb.classList.contains('open')) { lb.classList.remove('open'); return; }
    if (A.menu.isOpen()) { A.menu.close(); return; }
    if (A.closeSettings()) return;
    if (document.querySelector('#history')!.classList.contains('open')) { A.chat.closeHistory(); return; }
    // 正在朗读时，第一下 Esc 只停朗读，不收起
    if (A.voice?.speaking) { A.voice.stop(); return; }
    if (A.summon.isOpen()) { A.summon.close(); return; }
    if (A.panel.isOpen()) { A.panel.close(); return; }
    if (A.bubble.current()) A.bubble.close();
  });
  // The menu entry is explicit; closing settings or chat never exits the process.
  A.quit = async () => {
    A.chat.stop?.();
    A.voice?.stop?.();
    try { await A.flush(); if (native) await command('quit_app'); }
    catch { A.toast('保存失败，尚未退出。请检查磁盘空间后重试。'); }
  };
  if (import.meta.env.DEV && native && await command('debug_smoke_enabled')) {
    const { nativeSmoke } = await import('./smoke');
    await nativeSmoke(A);
  }
}

boot().catch(error => {
  console.error('Companion startup failed', error);
  document.body.replaceChildren();
  const message = document.createElement('div');
  message.className = 'startup-error';
  message.textContent = `启动失败：${String(error)}。数据未被覆盖，请重启应用。`;
  document.body.append(message);
  if (native) command('desktop_ready').then(() => command('focus_companion')).catch(() => {});
});
