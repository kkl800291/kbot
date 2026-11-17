import { spawn } from 'node:child_process';
import { chmod, copyFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './prepare-dsh-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const installedApp = '/Applications/KBOT.app';
const installedBin = join(installedApp, 'Contents/MacOS/cyber-companion');
const installedRuntime = join(installedApp, 'Contents/Resources/dsh-runtime/runtime.json');
const repoRuntime = join(root, 'src-tauri/resources/dsh-runtime/runtime.json');
const releaseBin = join(root, 'src-tauri/target/release/cyber-companion');
const entitlements = join(root, 'src-tauri/Entitlements.plist');

const exists = path => stat(path).then(() => true, () => false);
const readJson = path => readFile(path, 'utf8').then(JSON.parse, () => null);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}

async function stopRunningKbot() {
  for (const pattern of ['/Applications/KBOT.app/Contents/', 'target/debug/cyber-companion']) {
    await run('pkill', ['-TERM', '-f', pattern]).catch(() => {});
  }
  await new Promise(resolve => setTimeout(resolve, 600));
}

async function needsFullBundle(forceFull) {
  if (forceFull) return true;
  if (!(await exists(installedBin)) || !(await exists(installedRuntime))) return true;
  const repoMeta = await readJson(repoRuntime);
  const installedMeta = await readJson(installedRuntime);
  return !repoMeta?.fingerprint || repoMeta.fingerprint !== installedMeta?.fingerprint;
}

const full = process.argv.includes('--full');
const noLaunch = process.argv.includes('--no-launch');

await prepareRuntime();
if (await needsFullBundle(full)) {
  console.log('Syncing full KBOT.app bundle...');
  await run(process.execPath, ['scripts/desktop.mjs', 'build', '--bundles', 'app']);
  await stopRunningKbot();
  await rm(installedApp, { recursive: true, force: true });
  await run('ditto', [join(root, 'src-tauri/target/release/bundle/macos/KBOT.app'), installedApp]);
} else {
  console.log('Incremental sync: rebuilding binary without re-bundling 1 GiB runtime...');
  await run(process.execPath, ['scripts/desktop.mjs', 'build', '--no-bundle']);
  await stopRunningKbot();
  await copyFile(releaseBin, installedBin);
  await chmod(installedBin, 0o755);
  await run('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, installedBin]);
  await run('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, installedApp]);
}

await run('codesign', ['--verify', '--deep', '--strict', installedApp]);
if (!noLaunch) {
  await run('open', ['-a', installedApp]);
}
console.log('Synced /Applications/KBOT.app successfully.');
