import { defineConfig, type Plugin } from 'vite';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');

const STATIC_FILES = [
  'styles.css',
  'pet.css',
  'settings.css',
  'tabler-icons.min.css',
  'qrcode.js',
  'jsqr.js',
  'p2p-codec.js',
  'logo.png',
];

const STATIC_DIRS = ['fonts', 'audio'];

function syncJsQrIntoSrc() {
  const from = join(rootDir, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
  const to = join(srcDir, 'jsqr.js');
  if (existsSync(from)) {
    const content = readFileSync(from, 'utf8');
    if (!existsSync(to) || readFileSync(to, 'utf8') !== content) {
      writeFileSync(to, content, 'utf8');
    }
  }
}

function inexStaticAssetsPlugin(): Plugin {
  return {
    name: 'inex-static-assets',
    buildStart() {
      syncJsQrIntoSrc();
    },
    configureServer() {
      syncJsQrIntoSrc();
    },
    closeBundle() {
      mkdirSync(distDir, { recursive: true });
      for (const file of STATIC_FILES) {
        const from = join(srcDir, file);
        if (existsSync(from)) {
          copyFileSync(from, join(distDir, file));
        }
      }
      for (const dir of STATIC_DIRS) {
        const from = join(srcDir, dir);
        if (existsSync(from)) {
          cpSync(from, join(distDir, dir), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  root: srcDir,
  base: './',
  publicDir: false,
  plugins: [inexStaticAssetsPlugin()],
  build: {
    outDir: distDir,
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(srcDir, 'index.html'),
        settings: resolve(srcDir, 'settings.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
