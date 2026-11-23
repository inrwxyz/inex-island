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

const banner = '/* GENERATED from styles-parts/*.css and src/js/features by scripts/build-styles.mjs. Edit the source files, not this file. */\n';
const body = parts.map((name) => readFileSync(join(partsDir, name), 'utf8')).join('');

const featuresDir = join(root, 'src', 'js', 'features');
let featureStyles = '';
if (existsSync(featuresDir)) {
  const dirs = readdirSync(featuresDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const fPath = join(featuresDir, d.name);
    const cssFiles = readdirSync(fPath).filter((f) => f.endsWith('.css'));
    for (const cf of cssFiles) {
      featureStyles += `\n/* Feature: ${d.name}/${cf} */\n` + readFileSync(join(fPath, cf), 'utf8');
    }
  }
}

const next = banner + body + featureStyles;

const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
if (current !== next) {
  writeFileSync(outFile, next);
  console.log(`build-styles: wrote src/styles.css from ${parts.length} parts`);
} else {
  console.log('build-styles: src/styles.css already up to date');
}
