// Packages the static export (out/) into a webOS .ipk.
// Run after `npm run build:webos`. Requires @webosose/ares-cli (devDependency).
//
//   node scripts/package-webos.mjs
//
// Produces dist-webos/com.nuvio.clearkey.app_<version>_all.ipk
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'out');
const webosDir = resolve(root, 'webos');
const distDir = resolve(root, 'dist-webos');

if (!existsSync(resolve(outDir, 'index.html'))) {
  console.error('out/index.html not found. Run "npm run build:webos" first.');
  process.exit(1);
}

// webOS reads the app manifest and icons from the app root (the export dir).
for (const file of ['appinfo.json', 'icon.png', 'largeIcon.png']) {
  copyFileSync(resolve(webosDir, file), resolve(outDir, file));
}

mkdirSync(distDir, { recursive: true });

const bin = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'ares-package.cmd' : 'ares-package');
const cmd = existsSync(bin) ? bin : 'ares-package';
const result = spawnSync(cmd, [outDir, '-o', distDir, '--no-minify'], { stdio: 'inherit' });

if (result.status !== 0) {
  console.error('ares-package failed. Is @webosose/ares-cli installed?');
  process.exit(result.status ?? 1);
}
console.log(`\nWrote .ipk to ${distDir}`);
