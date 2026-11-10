import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyPackages } from './copy-packages.mjs';

const started = Date.now();
const args = process.argv.slice(2);
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PATH: [join(homedir(), '.cargo', 'bin'), process.env.PATH].filter(Boolean).join(delimiter) },
});
child.on('exit', async code => {
  if (code === 0 && args[0] === 'build') {
    const targetFlag = args.indexOf('--target');
    const target = targetFlag >= 0 ? args[targetFlag + 1] : args.find(arg => arg.startsWith('--target='))?.slice('--target='.length);
    try { await copyPackages(started, target); }
    catch (error) { console.error(`Installer copy failed: ${error.message}`); process.exit(1); }
  }
  process.exit(code ?? 1);
});
child.on('error', error => { console.error(error.message); process.exit(1); });
