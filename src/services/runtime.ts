import { invoke, Channel, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const native = isTauri();
export { Channel, listen };
const browserKey = 'cyber-companion-development-v1';

export async function command<T = any>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!native) throw new Error('此操作需要在桌面应用中完成');
  return invoke<T>(name, args);
}
export async function loadState(): Promise<Record<string, any>> {
  if (native) return command('load_state');
  try { return JSON.parse(localStorage.getItem(browserKey) || '{}'); } catch { return {}; }
}
export async function writeState(data: Record<string, unknown>) {
  if (native) await command('save_state', { data });
  else localStorage.setItem(browserKey, JSON.stringify(data));
}

export function installPersistence(A: any) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve();
  const snapshot = () => {
    const data: Record<string, unknown> = { S: A.S };
    for (const k in A.persisters) data[k] = A.persisters[k]();
    return JSON.parse(JSON.stringify(data));
  };
  A.flush = () => {
    clearTimeout(timer);
    const data = snapshot();
    const save = tail.catch(() => {}).then(() => writeState(data));
    tail = save;
    return save;
  };
  A.save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => A.flush().catch(() => A.toast('本地保存失败，请检查磁盘空间后重试', 6000)), 350);
  };
  A.resetData = async () => {
    A.chat.stop?.();
    clearTimeout(timer);
    try {
      await tail.catch(() => {});
      if (native) for (const slot of ['chat', 'vision', 'search', 'tts']) await command('delete_key', { slot });
      A.save = () => {};
      await writeState({});
      location.reload();
    } catch { A.toast('清除失败，请重试。现有数据已保留', 6000); }
  };
}
