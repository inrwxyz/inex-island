// Joins styles-parts/*.css (in file-name order) into src/styles.css.
//
//   npm run build:styles
//
// `tauri dev` and `tauri build` run this automatically.
// Edit the files in styles-parts/, never src/styles.css directly.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const partsDir = join(root, 'styles-parts');
const outFile = join(root, 'src', 'styles.css');

const parts = readdirSync(partsDir).filter((n) => n.endsWith('.css')).sort();
if (parts.length === 0) {
  console.error('build-styles: no files found in styles-parts/');
  process.exit(1);
}

const banner = '/* GENERATED from styles-parts/*.css by scripts/build-styles.mjs. Edit the parts, not this file. */\n';
const body = parts.map((name) => readFileSync(join(partsDir, name), 'utf8')).join('');
const next = banner + body;

const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
if (current !== next) {
  writeFileSync(outFile, next);
  console.log(`build-styles: wrote src/styles.css from ${parts.length} parts`);
} else {
  console.log('build-styles: src/styles.css already up to date');
}
