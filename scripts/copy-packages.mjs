import { copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Keep the user-facing installer beside package.json, even though Tauri also
// maintains its intermediate bundle directory under target/.
export async function copyPackages(since = 0, target) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const bundle = join(root, 'src-tauri/target', ...(target ? [target] : []), 'release/bundle/dmg');
  const files = await readdir(bundle).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of files) {
    if (!name.startsWith(`${config.productName}_${config.version}_`) || !name.endsWith('.dmg')) continue;
    const source = join(bundle, name);
    if ((await stat(source)).mtimeMs < since) continue;
    const destination = join(root, name);
    await copyFile(source, destination);
    console.log(`Installer: ${destination}`);
  }
}
