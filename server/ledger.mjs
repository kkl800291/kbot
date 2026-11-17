import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TRIAL_CREDITS = 20;

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizeAccount(raw) {
  return String(raw || '').trim().toLowerCase();
}

function randomCode() {
  const chunk = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `KBOT-${chunk()}-${chunk()}-${chunk()}`;
}

export class CreditLedger {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.resolve(process.cwd(), 'server/data/ledger.json');
    this.trialCredits = Number.isFinite(options.trialCredits) ? Math.max(0, options.trialCredits) : DEFAULT_TRIAL_CREDITS;
    this.signingSecret = options.signingSecret || '';
    this.state = { secret: '', devices: {}, accounts: {}, codes: {}, usage: [] };
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  async _ensureLoaded() {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.dataPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = {
          secret: String(parsed.secret || ''),
          devices: parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
          accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
          codes: parsed.codes && typeof parsed.codes === 'object' ? parsed.codes : {},
          usage: Array.isArray(parsed.usage) ? parsed.usage : [],
        };
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (!this.state.secret) {
      this.state.secret = this.signingSecret || randomSecret();
      await this._save();
    }
    if (this.signingSecret) this.state.secret = this.signingSecret;
    this.loaded = true;
  }

  async _save() {
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
    const tmp = `${this.dataPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.dataPath);
  }

  _withLock(fn) {
    const run = this.queue.then(async () => {
      await this._ensureLoaded();
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  signToken(sub, ttlSeconds = 30 * 24 * 3600) {
    const secret = this.signingSecret || this.state.secret;
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `kbot1.${body}.${sig}`;
  }

  async verifyToken(token) {
    await this._ensureLoaded();
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'kbot1') return null;
    const [, body, sig] = parts;
    const secret = this.signingSecret || this.state.secret;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!parsed?.sub || !parsed?.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
      return String(parsed.sub);
    } catch {
      return null;
    }
  }

  _recordFor(sub) {
    if (sub.startsWith('usr:')) {
      const id = sub.slice(4);
      return { kind: 'account', id, rec: this.state.accounts[id] || null };
    }
    if (sub.startsWith('dev:')) {
      const id = sub.slice(4);
      const dev = this.state.devices[id];
      if (!dev) return { kind: 'device', id, rec: null };
      if (dev.boundAccount && this.state.accounts[dev.boundAccount]) {
        return { kind: 'account', id: dev.boundAccount, rec: this.state.accounts[dev.boundAccount] };
      }
      return { kind: 'device', id, rec: dev };
    }
    return { kind: 'unknown', id: '', rec: null };
  }

  _view(kind, id, rec) {
    return {
      signedIn: kind === 'account',
      account: kind === 'account' ? id : null,
      credits: Number(rec?.credits || 0),
      trialTotal: this.trialCredits,
      trialGranted: Boolean(rec?.trialGranted),
    };
  }

  bootstrapDevice(rawDeviceId, existingToken = null) {
    const deviceId = String(rawDeviceId || '').trim();
    if (!deviceId || deviceId.length < 8 || deviceId.length > 120) {
      return Promise.reject(Object.assign(new Error('无效的设备标识'), { status: 400 }));
    }
    return this._withLock(async () => {
      if (existingToken) {
        const sub = await this.verifyToken(existingToken);
        if (sub && sub.startsWith('usr:')) {
          const found = this._recordFor(sub);
          if (found.rec) return { ...this._view('account', found.id, found.rec), token: existingToken };
        }
      }
      let dev = this.state.devices[deviceId];
      let newlyGranted = false;
      if (!dev) {
        dev = {
          credits: this.trialCredits,
          trialGranted: true,
          boundAccount: null,
          createdAt: Date.now(),
        };
        this.state.devices[deviceId] = dev;
        newlyGranted = true;
        await this._save();
      }
      if (dev.boundAccount && this.state.accounts[dev.boundAccount]) {
        const sub = `usr:${dev.boundAccount}`;
        return {
          ...this._view('account', dev.boundAccount, this.state.accounts[dev.boundAccount]),
          trialGranted: newlyGranted,
          token: this.signToken(sub),
        };
      }
      const sub = `dev:${deviceId}`;
      return {
        ...this._view('device', deviceId, dev),
        trialGranted: newlyGranted,
        token: this.signToken(sub),
      };
    });
  }

  loginAccount({ account, password = '', deviceId = '' }) {
    const acct = normalizeAccount(account);
    if (!acct || acct.length < 3 || acct.length > 120) {
      return Promise.reject(Object.assign(new Error('请输入有效的账号或邮箱'), { status: 400 }));
    }
    return this._withLock(async () => {
      let rec = this.state.accounts[acct];
      if (!rec) {
        rec = {
          credits: 0,
          passwordHash: password ? hashPassword(password) : '',
          trialGranted: false,
          createdAt: Date.now(),
        };
        this.state.accounts[acct] = rec;
      } else if (rec.passwordHash && password && !verifyPassword(password, rec.passwordHash)) {
        throw Object.assign(new Error('账号或密码不正确'), { status: 401 });
      } else if (rec.passwordHash && !password) {
        throw Object.assign(new Error('该账号已设置密码，请输入密码'), { status: 401 });
      }

      const cleanDev = String(deviceId || '').trim();
      const dev = cleanDev ? this.state.devices[cleanDev] : null;
      if (dev && !dev.boundAccount) {
        rec.credits += Number(dev.credits || 0);
        if (dev.trialGranted) rec.trialGranted = true;
        dev.credits = 0;
        dev.boundAccount = acct;
      } else if (!rec.trialGranted && !cleanDev) {
        rec.credits += this.trialCredits;
        rec.trialGranted = true;
      }

      await this._save();
      return {
        ...this._view('account', acct, rec),
        token: this.signToken(`usr:${acct}`),
      };
    });
  }

  getStatus(sub) {
    return this._withLock(async () => {
      const { kind, id, rec } = this._recordFor(sub);
      if (!rec) throw Object.assign(new Error('云端会话不存在或已失效'), { status: 401 });
      return this._view(kind, id, rec);
    });
  }

  consumeCredits(sub, cost, kindTag) {
    return this._withLock(async () => {
      const { kind, id, rec } = this._recordFor(sub);
      if (!rec) throw Object.assign(new Error('云端会话不存在或已失效'), { status: 401 });
      const amount = Math.max(0, Number(cost || 0));
      if (rec.credits < amount) {
        throw Object.assign(
          new Error('平台体验额度或点数已用完，请充值点数或切换自带 API Key'),
          { status: 402, code: 'quota_exhausted' },
        );
      }
      if (amount > 0) {
        rec.credits -= amount;
        this.state.usage.push({ ts: Date.now(), principal: `${kind}:${id}`, kind: kindTag, cost: amount });
        if (this.state.usage.length > 500) this.state.usage.splice(0, this.state.usage.length - 500);
        await this._save();
      }
      return this._view(kind, id, rec);
    });
  }

  refundCredits(sub, cost, kindTag) {
    const amount = Math.max(0, Number(cost || 0));
    if (amount <= 0) return Promise.resolve();
    return this._withLock(async () => {
      const { kind, id, rec } = this._recordFor(sub);
      if (!rec) return;
      rec.credits += amount;
      this.state.usage.push({ ts: Date.now(), principal: `${kind}:${id}`, kind: `${kindTag}:refund`, cost: -amount });
      if (this.state.usage.length > 500) this.state.usage.splice(0, this.state.usage.length - 500);
      await this._save();
    });
  }

  createCodes({ credits = 100, count = 1, note = '' }) {
    const value = Math.max(1, Math.min(1_000_000, Math.floor(Number(credits) || 0)));
    const n = Math.max(1, Math.min(100, Math.floor(Number(count) || 1)));
    return this._withLock(async () => {
      const created = [];
      for (let i = 0; i < n; i++) {
        let code = randomCode();
        while (this.state.codes[code]) code = randomCode();
        this.state.codes[code] = { credits: value, createdAt: Date.now(), note: String(note || '') };
        created.push({ code, credits: value });
      }
      await this._save();
      return created;
    });
  }

  redeemCode(sub, rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return Promise.reject(Object.assign(new Error('请输入兑换码'), { status: 400 }));
    return this._withLock(async () => {
      const { kind, id, rec } = this._recordFor(sub);
      if (!rec) throw Object.assign(new Error('云端会话不存在或已失效'), { status: 401 });
      const entry = this.state.codes[code];
      if (!entry) throw Object.assign(new Error('兑换码无效或不存在'), { status: 404 });
      if (entry.redeemedAt) throw Object.assign(new Error('该兑换码已被使用'), { status: 409 });
      entry.redeemedAt = Date.now();
      entry.redeemedBy = `${kind}:${id}`;
      rec.credits += Number(entry.credits || 0);
      this.state.usage.push({ ts: Date.now(), principal: `${kind}:${id}`, kind: 'redeem', cost: -Number(entry.credits || 0) });
      await this._save();
      return {
        ...this._view(kind, id, rec),
        addedCredits: Number(entry.credits || 0),
      };
    });
  }

  grantToAccount(account, credits) {
    const acct = normalizeAccount(account);
    const amount = Math.max(1, Math.floor(Number(credits) || 0));
    if (!acct) return Promise.reject(Object.assign(new Error('账号不能为空'), { status: 400 }));
    return this._withLock(async () => {
      const rec = this.state.accounts[acct] || { credits: 0, passwordHash: '', trialGranted: false, createdAt: Date.now() };
      rec.credits += amount;
      this.state.accounts[acct] = rec;
      await this._save();
      return this._view('account', acct, rec);
    });
  }
}
