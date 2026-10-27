// Joins main-parts/*.js (in file-name order) into src/main.js.
//
//   npm run build:main
//
// `tauri dev` and `tauri build` run this automatically (see tauri.conf.json).
// Edit the files in main-parts/, never src/main.js: it is regenerated.
// The parts are plain slices of one script, so they must stay in this order;
// they are not standalone modules.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const partsDir = join(root, 'main-parts');
const outFile = join(root, 'src', 'main.js');

const parts = readdirSync(partsDir).filter((n) => n.endsWith('.js')).sort();
if (parts.length === 0) {
  console.error('build-main: no files found in main-parts/');
  process.exit(1);
}

const banner = '// GENERATED from main-parts/*.js by scripts/build-main.mjs. Edit the parts, not this file.\n';
const body = parts.map((name) => readFileSync(join(partsDir, name), 'utf8')).join('');
const next = banner + body;

const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
if (current !== next) {
  writeFileSync(outFile, next);
  console.log(`build-main: wrote src/main.js from ${parts.length} parts`);
} else {
  console.log('build-main: src/main.js already up to date');
}
