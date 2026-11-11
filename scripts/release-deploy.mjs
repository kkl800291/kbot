#!/usr/bin/env node
/**
 * One-command local build & self-hosted server release script for KBOT.
 *
 * Usage:
 *   npm run release                                  # Build & publish current version in package.json
 *   npm run release -- 0.2.0 "新增某某能力"            # Bump version to 0.2.0, test, build & publish
 *   npm run release -- patch "修复某某问题"            # Auto bump patch (e.g. 0.1.9 -> 0.1.10), build & publish
 *   npm run release -- --notes "更新说明" --skip-tests
 *
 * Reads private SSH deployment settings from `.env.release.local` (gitignored).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function expandHome(p) {
  if (!p) return '';
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnvFile(path.join(rootDir, '.env.release.local'));
loadEnvFile(path.join(rootDir, '.env.local'));

const args = process.argv.slice(2);
let versionSpec = '';
let notes = '';
let skipTests = false;
let skipBuild = false;
let dryRun = false;

const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--notes' && args[i + 1]) {
    notes = args[++i];
  } else if (a === '--version' && args[i + 1]) {
    versionSpec = args[++i];
  } else if (a === '--skip-tests') {
    skipTests = true;
  } else if (a === '--skip-build') {
    skipBuild = true;
  } else if (a === '--dry-run') {
    dryRun = true;
  } else if (!a.startsWith('--')) {
    positional.push(a);
  }
}

if (!versionSpec && positional[0]) {
  const p0 = positional[0].trim();
  if (/^(patch|minor|major|v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i.test(p0)) {
    versionSpec = p0;
    if (!notes && positional[1]) notes = positional.slice(1).join(' ');
  } else if (!notes) {
    notes = positional.join(' ');
  }
}

function bumpSemver(current, spec) {
  if (!spec) return current;
  const clean = spec.replace(/^[vV]/, '');
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(clean)) return clean;
  const [maj, min, pat] = current.split('-')[0].split('.').map(Number);
  if (spec === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (spec === 'minor') return `${maj}.${min + 1}.0`;
  if (spec === 'major') return `${maj + 1}.0.0`;
  throw new Error(`不支持的版本号参数: ${spec}`);
}

function syncVersionFiles(nextVer) {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== nextVer) {
    pkg.version = nextVer;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  const lockPath = path.join(rootDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    let changed = false;
    if (lock.version !== nextVer) { lock.version = nextVer; changed = true; }
    if (lock.packages?.[''] && lock.packages[''].version !== nextVer) {
      lock.packages[''].version = nextVer;
      changed = true;
    }
    if (changed) fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  }

  const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  if (tauriConf.version !== nextVer) {
    tauriConf.version = nextVer;
    fs.writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');
  }

  const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
  const cargoRaw = fs.readFileSync(cargoPath, 'utf8');
  const cargoNext = cargoRaw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVer}"`);
  if (cargoNext !== cargoRaw) {
    fs.writeFileSync(cargoPath, cargoNext, 'utf8');
  }
}

function runStep(label, cmd, cmdArgs) {
  console.log(`\n==> ${label}`);
  const env = {
    ...process.env,
    PATH: [path.join(os.homedir(), '.cargo', 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const res = spawnSync(cmd, cmdArgs, { cwd: rootDir, stdio: 'inherit', env });
  if (res.status !== 0) {
    console.error(`\n[失败] ${label} (exit ${res.status ?? 1})`);
    process.exit(res.status ?? 1);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function resolveDefaultNotes(ver) {
  if (notes) return notes;
  try {
    const subj = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: rootDir, encoding: 'utf8' }).trim();
    if (subj) return subj;
  } catch {}
  return `KBOT v${ver} 更新`;
}

const pkgInitial = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = bumpSemver(pkgInitial.version, versionSpec);
syncVersionFiles(version);

const deploySsh = (process.env.KBOT_DEPLOY_SSH || '').trim();
const deployKey = expandHome((process.env.KBOT_DEPLOY_SSH_KEY || '').trim());
const deployDir = (process.env.KBOT_DEPLOY_DIR || '').trim();
const baseUrl = (process.env.KBOT_RELEASE_BASE_URL || 'https://schathub.xyz/kbot/releases').trim().replace(/\/+$/, '');
const keepRemote = Math.max(2, Number(process.env.KBOT_KEEP_REMOTE_VERSIONS || 3) || 3);

if (!dryRun && (!deploySsh || !deployDir)) {
  console.error(
    '缺少服务器部署配置：请在项目根目录创建 .env.release.local（参考 .env.example）配置 KBOT_DEPLOY_SSH 与 KBOT_DEPLOY_DIR。',
  );
  process.exit(1);
}

console.log(`准备发布 KBOT v${version}`);
console.log(`目标更新地址: ${baseUrl}/latest.json`);

if (!skipTests) {
  runStep('运行前端单元测试', 'npm', ['test']);
  runStep('运行 Rust 单元测试', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']);
}

if (!skipBuild) {
  runStep('构建 macOS KBOT.app 与 DMG 安装包', process.execPath, ['scripts/desktop.mjs', 'build']);
}

const appBundle = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'KBOT.app');
const dmgDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'dmg');
if (!fs.existsSync(appBundle)) {
  console.error(`未找到构建产物: ${appBundle}`);
  process.exit(1);
}

const dmgFiles = fs.existsSync(dmgDir)
  ? fs
      .readdirSync(dmgDir)
      .filter((f) => f.endsWith('.dmg') && f.includes(`_${version}_`))
      .sort((a, b) => fs.statSync(path.join(dmgDir, b)).mtimeMs - fs.statSync(path.join(dmgDir, a)).mtimeMs)
  : [];

if (!dmgFiles.length) {
  console.error(`未在 ${dmgDir} 找到版本 ${version} 的 .dmg 安装包`);
  process.exit(1);
}

const stageDir = path.join(rootDir, 'src-tauri', 'target', 'release-upload');
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const zipName = `KBOT_${version}_aarch64.app.zip`;
const dmgName = `KBOT_${version}_aarch64.dmg`;
const zipPath = path.join(stageDir, zipName);
const dmgPath = path.join(stageDir, dmgName);
const sumsPath = path.join(stageDir, 'SHA256SUMS.txt');
const manifestPath = path.join(stageDir, 'latest.json');

runStep('压缩热更新包 (.app.zip)', '/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, zipPath]);
fs.copyFileSync(path.join(dmgDir, dmgFiles[0]), dmgPath);

// Clean up any root-level KBOT_*.dmg left by copy-packages.mjs to keep workspace tidy
for (const entry of fs.readdirSync(rootDir)) {
  if (/^KBOT_.*\.dmg$/.test(entry)) {
    fs.rmSync(path.join(rootDir, entry), { force: true });
  }
}

const zipSha = sha256File(zipPath);
const dmgSha = sha256File(dmgPath);
fs.writeFileSync(sumsPath, `${zipSha}  ${zipName}\n${dmgSha}  ${dmgName}\n`, 'utf8');

const releaseNotes = resolveDefaultNotes(version);
runStep('生成自更新清单 (latest.json)', process.execPath, [
  'scripts/generate-update-manifest.mjs',
  zipPath,
  '--base-url',
  baseUrl,
  '--release-url',
  `${baseUrl}/${dmgName}`,
  '--notes',
  releaseNotes,
  '--out',
  manifestPath,
]);

if (dryRun) {
  console.log(`\n[Dry Run] 本地产物已准备于: ${stageDir}`);
  process.exit(0);
}

const sshOpts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
if (deployKey) {
  sshOpts.push('-o', 'IdentitiesOnly=yes', '-i', deployKey);
}

runStep('确保远端发布目录存在', 'ssh', [...sshOpts, deploySsh, `mkdir -p '${deployDir}'`]);

// Upload binaries FIRST, then atomically replace latest.json LAST so clients never see a half-uploaded archive
runStep('上传安装包产物 (.app.zip / .dmg / SHA256SUMS.txt)', 'scp', [
  ...sshOpts,
  zipPath,
  dmgPath,
  sumsPath,
  `${deploySsh}:${deployDir}/`,
]);

runStep('原子更新远端 latest.json 清单并清理旧版本归档', 'scp', [
  ...sshOpts,
  manifestPath,
  `${deploySsh}:${deployDir}/latest.json.tmp`,
]);

const pruneCmd = `
set -euo pipefail
cd '${deployDir}'
mv -f latest.json.tmp latest.json
chmod 644 latest.json '${zipName}' '${dmgName}' SHA256SUMS.txt
ls -1t KBOT_*_aarch64.app.zip 2>/dev/null | tail -n +$(( ${keepRemote} + 1 )) | xargs -r rm -f
ls -1t KBOT_*_aarch64.dmg 2>/dev/null | tail -n +$(( ${keepRemote} + 1 )) | xargs -r rm -f
ls -lh
`.trim();

runStep('生效远端清单并保留最近版本', 'ssh', [...sshOpts, deploySsh, pruneCmd]);

fs.rmSync(stageDir, { recursive: true, force: true });

console.log('\n==> 正在核验公网 HTTPS 更新源...');
const res = await fetch(`${baseUrl}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } });
if (!res.ok) {
  console.error(`远端校验失败: HTTP ${res.status} (${baseUrl}/latest.json)`);
  process.exit(1);
}
const remoteManifest = await res.json();
if (remoteManifest.version !== version || remoteManifest.sha256 !== zipSha) {
  console.error('远端 latest.json 版本或 SHA-256 与本次构建不一致:', remoteManifest);
  process.exit(1);
}

console.log(`\n发布成功！KBOT v${version} 已上线：`);
console.log(`  自动更新清单: ${baseUrl}/latest.json`);
console.log(`  热更新压缩包: ${baseUrl}/${zipName}`);
console.log(`  全新安装镜像: ${baseUrl}/${dmgName}`);
