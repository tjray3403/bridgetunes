import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adapterDist = resolve(apiDirectory, '../packages/adapters/dist');
const installedAdapterDist = resolve(apiDirectory, 'node_modules/@bridgetunes/adapters/dist');

try {
  await access(resolve(adapterDist, 'index.d.ts'));
} catch {
  throw new Error('Adapter package is not built. Run "npm run build" in packages/adapters before building the API.');
}

await mkdir(installedAdapterDist, { recursive: true });
await cp(adapterDist, installedAdapterDist, { recursive: true, force: true });
