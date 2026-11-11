#!/usr/bin/env node
/**
 * Generate a KBOT self-update manifest (`latest.json`) from a built `.dmg` / `.zip` / `.app.tar.gz`.
 *
 * Usage:
 *   node scripts/generate-update-manifest.mjs [artifact-path] [--base-url https://example.com/releases] [--notes "更新说明"] [--out ~/KBOT/releases/latest.json]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
let artifactArg = '';
let baseUrl = '';
let releaseUrl = '';
let notes = '';
let outPath = '';

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--base-url' && args[i + 1]) {
    baseUrl = args[++i];
  } else if (a === '--release-url' && args[i + 1]) {
    releaseUrl = args[++i];
  } else if (a === '--notes' && args[i + 1]) {
    notes = args[++i];
  } else if (a === '--out' && args[i + 1]) {
    outPath = args[++i];
  } else if (!a.startsWith('--') && !artifactArg) {
    artifactArg = a;
  }
}

function expandTilde(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function findLatestDmg() {
  const dmgDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'dmg');
  if (!fs.existsSync(dmgDir)) return '';
  const files = fs
    .readdirSync(dmgDir)
    .filter((f) => f.endsWith('.dmg'))
    .map((f) => ({ name: f, full: path.join(dmgDir, f), mtime: fs.statSync(path.join(dmgDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full || '';
}

const artifactPath = path.resolve(expandTilde(artifactArg || findLatestDmg()));
if (!artifactPath || !fs.existsSync(artifactPath)) {
  console.error('未找到安装包产物，请先运行 npm run desktop:build 或指定产物路径。');
  process.exit(1);
}

const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(artifactPath));
const sha256 = hash.digest('hex');

const fileName = path.basename(artifactPath);
const downloadUrl = baseUrl
  ? `${baseUrl.replace(/\/+$/, '')}/${fileName}`
  : fileName;

const targetOut = outPath
  ? path.resolve(expandTilde(outPath))
  : path.join(path.dirname(artifactPath), 'latest.json');

fs.mkdirSync(path.dirname(targetOut), { recursive: true });
// If writing to a separate directory without --base-url, point downloadUrl to absolute artifact path unless copied alongside
const resolvedDownload =
  !baseUrl && path.dirname(targetOut) !== path.dirname(artifactPath)
    ? artifactPath
    : downloadUrl;

const manifest = {
  version: pkg.version,
  pubDate: new Date().toISOString(),
  notes: notes || `KBOT v${pkg.version} 更新`,
  downloadUrl: resolvedDownload,
  ...(releaseUrl ? { releaseUrl } : {}),
  sha256,
};

fs.writeFileSync(targetOut, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`已生成更新清单: ${targetOut}`);
console.log(JSON.stringify(manifest, null, 2));
