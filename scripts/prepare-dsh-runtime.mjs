import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'runtime');
const output = join(root, 'src-tauri/resources/dsh-runtime');
const hash = data => createHash('sha256').update(data).digest('hex');
const exists = path => stat(path).then(() => true, () => false);

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${binary} exited with ${code}`)));
  });
}

async function licenses(nodeModules) {
  const notices = ['KBOT bundled runtime — third-party licenses', 'Node.js: see NODE_LICENSE.txt', ''];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(folder, entry.name);
      if (entry.name.startsWith('@')) { await visit(directory); continue; }
      const metadata = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse, () => null);
      if (metadata) {
        notices.push(`\n${metadata.name}@${metadata.version} (${typeof metadata.license === 'string' ? metadata.license : 'see package license'})`);
        for (const name of await readdir(directory)) {
          if (/^(licen[cs]e|copying|notice)([.-]|$)/i.test(name) && (await stat(join(directory, name))).isFile()) {
            notices.push(await readFile(join(directory, name), 'utf8'));
          }
        }
      }
      if (await exists(join(directory, 'node_modules'))) await visit(join(directory, 'node_modules'));
    }
  }
  await visit(nodeModules);
  return notices.join('\n');
}

async function pruneDevelopmentFiles(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await pruneDevelopmentFiles(path);
    else if (entry.isFile() && /(?:\.d\.(?:ts|cts|mts)|\.map|\.pdb)$/.test(entry.name)) await rm(path);
  }
}

export async function prepareRuntime(target) {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const platform = `${process.platform}-${process.arch}`;
  if (!manifest.nodeArchives[platform]) throw new Error(`Bundled DSH currently supports macOS arm64/x64; got ${platform}`);
  if (target && target !== `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`) {
    throw new Error('Build the DSH runtime on the matching macOS architecture. Cross-architecture bundles are not supported.');
  }
  const lock = await readFile(join(source, 'package-lock.json'));
  const packageJson = await readFile(join(source, 'package.json'));
  const fingerprint = hash(Buffer.concat([lock, packageJson, Buffer.from(JSON.stringify(manifest) + platform)]));
  const ready = await readFile(join(output, 'runtime.json'), 'utf8').then(JSON.parse, () => null);
  if (ready?.fingerprint === fingerprint && await exists(join(output, 'node/bin/node')) && await exists(join(output, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'))) return output;

  const cache = join(root, '.cache/dsh-runtime');
  await mkdir(cache, { recursive: true });
  const name = `node-v${manifest.nodeVersion}-${platform}`;
  const archive = join(cache, `${name}.tar.gz`);
  let archiveBytes = await readFile(archive).catch(() => null);
  if (!archiveBytes || hash(archiveBytes) !== manifest.nodeArchives[platform]) {
    console.log(`Downloading Node.js ${manifest.nodeVersion} (${platform})…`);
    const response = await fetch(`https://nodejs.org/dist/v${manifest.nodeVersion}/${name}.tar.gz`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Node.js download failed (${response.status})`);
    archiveBytes = Buffer.from(await response.arrayBuffer());
    if (hash(archiveBytes) !== manifest.nodeArchives[platform]) throw new Error('Node.js archive SHA-256 mismatch');
    await writeFile(archive, archiveBytes);
  }
  const staging = `${output}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'app'), { recursive: true });
  const extracted = join(cache, name);
  if (!await exists(join(extracted, 'bin/node'))) await run('/usr/bin/tar', ['-xzf', archive, '-C', cache]);
  await mkdir(join(staging, 'node/bin'), { recursive: true });
  await copyFile(join(extracted, 'bin/node'), join(staging, 'node/bin/node'));
  await chmod(join(staging, 'node/bin/node'), 0o755);
  await copyFile(join(extracted, 'LICENSE'), join(staging, 'NODE_LICENSE.txt'));
  for (const file of ['package.json', 'package-lock.json']) await copyFile(join(source, file), join(staging, 'app', file));
  console.log(`Installing pinned DeepSeek Harness ${manifest.dshVersion}…`);
  await run(join(extracted, 'bin/node'), [join(extracted, 'lib/node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: join(staging, 'app'),
    env: { ...process.env, PATH: [join(extracted, 'bin'), process.env.PATH].filter(Boolean).join(delimiter) },
  });
  await writeFile(join(staging, 'THIRD_PARTY_NOTICES.txt'), await licenses(join(staging, 'app/node_modules')));
  // These are compiler declarations and debugging symbols, never runtime code.
  await pruneDevelopmentFiles(join(staging, 'app/node_modules'));
  await writeFile(join(staging, 'runtime.json'), JSON.stringify({ ...manifest, platform, fingerprint }, null, 2) + '\n');
  // Publish only complete runtimes; a failed install never becomes a valid bundle.
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  console.log(`Bundled runtime ready: ${output}`);
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareRuntime(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
