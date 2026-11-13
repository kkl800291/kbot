// The native settings window is a view of the main window's state. It sends
// intent at field granularity, never an old copy of the full persisted state.
export interface Birthday {
  id: string;
  [key: string]: any;
}

export interface SettingsSnapshot {
  S: Record<string, any>;
  builtin: Record<string, any>;
  birthdays: Birthday[];
  [key: string]: any;
}

export interface SettingsValue {
  exists: boolean;
  value?: any;
}

export type SettingsChange = {
  kind: 'field';
  path: string[];
  before: SettingsValue;
  after: SettingsValue;
} | {
  kind: 'birthday';
  id: string;
  before?: Birthday;
  after?: Birthday;
};

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const userSettings = new Set([
  'theme', 'palette', 'reduced', 'outsideClose', 'sound',
  'persona', 'freq', 'nickname', 'work', 'rest', 'webDefault', 'screenPerm',
  'autostart', 'workFrom', 'workTo', 'holidays', 'params', 'festival',
  'term', 'city', 'senseIdle', 'senseApp', 'senseWeather', 'senseCal', 'apps',
  'hotkey', 'retention', 'send', 'ai', 'aiCompanion', 'cityInfo', 'cityCoords',
  'dsh', 'voice', 'updater',
]);
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: any, key: string) => value != null && Object.prototype.hasOwnProperty.call(value, key);

function assertKey(key: string) {
  if (unsafeKeys.has(key)) throw new Error('无效的设置路径');
}

function safeValue(value: any) {
  if (Array.isArray(value)) value.forEach(safeValue);
  else if (object(value)) for (const key of Object.keys(value)) { assertKey(key); safeValue(value[key]); }
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (!object(value)) return value;
  const result: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    // defineProperty also makes copying an untrusted own '__proto__' safe.
    Object.defineProperty(result, key, { value: clone(value[key]), writable: true, configurable: true, enumerable: true });
  }
  return result as T;
}

function equal(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
}

function matches(a: SettingsValue, b: SettingsValue) {
  return a.exists === b.exists && (!a.exists || equal(a.value, b.value));
}

function allowed(path: string[]) {
  if (!Array.isArray(path) || path.length < 2 || path.length > 8 || path.some(key => typeof key !== 'string' || !key || unsafeKeys.has(key))) return false;
  if (path[0] === 'builtin') return path.length === 2;
  if (path[0] !== 'S' || !userSettings.has(path[1])) return false;
  if (path[1] === 'ai') {
    // Never permit replacing an ancestor of ai.calls with a stale object.
    return path.length >= 4 && ['chat', 'vision', 'search'].includes(path[2]);
  }
  if (path[1] === 'dsh' || path[1] === 'voice' || path[1] === 'updater') return path.length >= 3;
  return true;
}

function birthdayMap(items: Birthday[]) {
  const result = new Map<string, Birthday>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || result.has(item.id)) throw new Error('生日数据的标识无效或重复');
    safeValue(item);
    result.set(item.id, item);
  }
  return result;
}

export function diffSettings(before: SettingsSnapshot, after: SettingsSnapshot): SettingsChange[] {
  const changes: SettingsChange[] = [];
  const visit = (left: any, right: any, path: string[]) => {
    for (const key of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
      assertKey(key);
      const nextPath = [...path, key];
      // Exclude derived/runtime fields before descending into them.
      if (nextPath[0] === 'S' && nextPath.length === 2 && !userSettings.has(key)) continue;
      if (nextPath[0] === 'S' && nextPath[1] === 'ai' && nextPath.length === 3 && !['chat', 'vision', 'search'].includes(key)) continue;
      const l: SettingsValue = { exists: own(left, key), value: left?.[key] };
      const r: SettingsValue = { exists: own(right, key), value: right?.[key] };
      if (matches(l, r)) continue;
      if (object(l.value) || object(r.value)) {
        // Objects are containers; arrays intentionally remain a single field.
        // Settings containers themselves are never writable, preserving sibling
        // fields that may have changed in the main window in the meantime.
        if ((l.exists && !object(l.value)) || (r.exists && !object(r.value))) throw new Error('设置分组的格式无效');
        visit(l.value, r.value, nextPath);
      } else if (allowed(nextPath)) {
        if (l.exists) safeValue(l.value);
        if (r.exists) safeValue(r.value);
        changes.push({ kind: 'field', path: nextPath, before: clone(l), after: clone(r) });
      }
    }
  };
  visit(before.S, after.S, ['S']);
  visit(before.builtin, after.builtin, ['builtin']);
  const oldBirthdays = birthdayMap(before.birthdays || []), newBirthdays = birthdayMap(after.birthdays || []);
  for (const id of new Set([...oldBirthdays.keys(), ...newBirthdays.keys()])) {
    const left = oldBirthdays.get(id), right = newBirthdays.get(id);
    if (!equal(left, right)) changes.push({ kind: 'birthday', id, before: clone(left), after: clone(right) });
  }
  return changes;
}

function readAt(root: any, path: string[]): SettingsValue {
  let value = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!own(value, path[i]) || !object(value[path[i]])) return { exists: false };
    value = value[path[i]];
  }
  const key = path[path.length - 1];
  return { exists: own(value, key), value: value?.[key] };
}

function writeAt(root: any, path: string[], slot: SettingsValue) {
  let parent = root;
  for (const key of path.slice(0, -1)) {
    if (!own(parent, key)) parent[key] = {};
    if (!object(parent[key])) throw new Error('设置分组的格式已改变，请重新打开设置');
    parent = parent[key];
  }
  const key = path[path.length - 1];
  if (slot.exists) parent[key] = clone(slot.value);
  else delete parent[key];
}

export function applySettingsChanges(current: SettingsSnapshot, changes: SettingsChange[]): SettingsSnapshot {
  const result = clone(current);
  for (const change of changes) {
    if (change.kind === 'field') {
      if (!allowed(change.path)) throw new Error('无效或不可修改的设置路径');
      if (change.before.exists) safeValue(change.before.value);
      if (change.after.exists) safeValue(change.after.value);
      const actual = readAt(result, change.path);
      if (matches(actual, change.after)) continue; // A repeated RPC is harmless.
      if (!matches(actual, change.before)) throw new Error(`设置已在另一个窗口更新，请重试：${change.path.join('.')}`);
      writeAt(result, change.path, change.after);
    } else if (change.kind === 'birthday') {
      if (typeof change.id !== 'string' || !change.id || (!change.before && !change.after) ||
        (change.before && change.before.id !== change.id) || (change.after && change.after.id !== change.id)) throw new Error('生日数据的标识无效');
      if (change.before) safeValue(change.before);
      if (change.after) safeValue(change.after);
      const map = birthdayMap(result.birthdays);
      const actual = map.get(change.id);
      if (equal(actual, change.after)) continue;
      if (!equal(actual, change.before)) throw new Error('生日已在另一个窗口更新，请重试');
      const index = result.birthdays.findIndex(item => item.id === change.id);
      if (!change.after) result.birthdays.splice(index, 1);
      else if (index === -1) result.birthdays.push(clone(change.after));
      else result.birthdays[index] = clone(change.after);
    } else throw new Error('无效的设置变更');
  }
  return result;
}
