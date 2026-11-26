import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const rootDir = resolve(import.meta.dirname, '..');
const captureMode = process.argv.includes('--capture');
const targetSubdir = process.argv.includes('--dist') ? 'dist' : 'src';
const serveRoot = join(rootDir, targetSubdir);
const goldenDir = join(rootDir, 'test-output', 'golden');
const currentDir = join(rootDir, 'test-output', 'current');
const diffDir = join(rootDir, 'test-output', 'diff');

mkdirSync(goldenDir, { recursive: true });
mkdirSync(currentDir, { recursive: true });
mkdirSync(diffDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function startStaticServer(dir) {
  return new Promise((resolveSrv) => {
    const srv = createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const safeRel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      let filePath = join(dir, safeRel);
      if (!filePath.startsWith(dir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolveSrv({ srv, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('Microsoft Edge not found on this machine.');
}

function installTauriMockScript(settingsOverride = null) {
  return ({ settingsOverride: ov }) => {
    // Freeze clock for deterministic golden screenshots
    const FIXED_MS = new Date('2026-11-26T14:30:00').getTime();
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [FIXED_MS]));
      }
      static now() { return FIXED_MS; }
    }
    window.Date = MockDate;

    if (ov) {
      localStorage.setItem('inex.settings.v1', JSON.stringify(ov));
    }
    localStorage.setItem('inex.welcome.done', '1');
    localStorage.setItem('inex.welcome.v1', '1');

    const listeners = new Map();
    window.__mockEmit = (name, payload) => {
      const list = listeners.get(name) || [];
      for (const fn of list) {
        try { fn({ event: name, payload }); } catch (e) { console.error(e); }
      }
    };

    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          switch (cmd) {
            case 'get_system_stats':
              return { cpu: 14, ram: 52, gpu: 8, disk: 41, net_down: 120, net_up: 35 };
            case 'get_battery':
              return { percent: 84, charging: false, present: true };
            case 'get_wifi_info':
              return { enabled: true, connected: true, ssid: 'Home-WiFi', present: true };
            case 'get_bluetooth_info':
              return { enabled: true, connected: true, present: true, devices: [{ name: 'Buds Pro', connected: true, battery: 80 }] };
            case 'get_volume':
              return { volume: 65, muted: false };
            case 'get_brightness':
              return 72;
            case 'get_audio_devices':
              return [{ id: 'dev1', name: 'Speakers (Realtek Audio)', is_default: true }];
            case 'get_media':
              return { playing: false, title: '', artist: '', app: '', position: 0, duration: 0 };
            case 'get_installed_browsers':
              return [{ id: 'msedge', name: 'Microsoft Edge' }, { id: 'chrome', name: 'Google Chrome' }];
            case 'get_screen_time_summary':
              return {
                trackingEnabled: true,
                todayTotalSecs: 7380,
                days: [{ date: '2026-11-26', totalSecs: 7380, topApps: [{ name: 'Code.exe', secs: 4200 }, { name: 'msedge.exe', secs: 2100 }] }],
                topApps: [{ name: 'Code.exe', secs: 4200 }, { name: 'msedge.exe', secs: 2100 }],
              };
            case 'get_pc_session_history':
              return { todayUptimeSecs: 7380, sessions: [{ start: '2026-11-26T10:00:00', end: '2026-11-26T14:30:00', secs: 7380, clean: true }] };
            case 'get_clipboard_history':
              return [];
            case 'get_shelf_files':
              return [];
            case 'get_startup_enabled':
              return true;
            case 'get_weather_cache':
              return null;
            case 'set_island_hit':
            case 'set_settings_glass':
            case 'save_settings_file':
              return null;
            default:
              return null;
          }
        },
      },
      event: {
        listen: async (name, cb) => {
          if (!listeners.has(name)) listeners.set(name, []);
          listeners.get(name).push(cb);
          return () => {};
        },
        emit: async (name, payload) => {
          window.__mockEmit(name, payload);
        },
      },
      window: {
        getCurrentWindow: () => ({
          show: async () => {},
          hide: async () => {},
          close: async () => {},
          startDragging: async () => {},
        }),
      },
    };
  };
}

function comparePng(name, goldenPath, curPath, diffPath) {
  if (!existsSync(goldenPath)) {
    throw new Error(`Missing golden baseline image: ${goldenPath}`);
  }
  const img1 = PNG.sync.read(readFileSync(goldenPath));
  const img2 = PNG.sync.read(readFileSync(curPath));
  if (img1.width !== img2.width || img1.height !== img2.height) {
    throw new Error(`${name}: dimension mismatch ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}`);
  }
  const diff = new PNG({ width: img1.width, height: img1.height });
  const badPixels = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, { threshold: 0.15 });
  writeFileSync(diffPath, PNG.sync.write(diff));
  const total = img1.width * img1.height;
  const pct = (badPixels / total) * 100;
  return { badPixels, total, pct };
}

async function run() {
  const { srv, baseUrl } = await startStaticServer(serveRoot);
  const browser = await chromium.launch({
    executablePath: findEdge(),
    headless: true,
    args: ['--disable-gpu', '--no-sandbox'],
  });

  const outDir = captureMode ? goldenDir : currentDir;
  const errors = [];
  const saved = [];

  try {
    // Abort external network requests (Google Fonts, Open-Meteo, etc.) cleanly so screenshots are instant & offline-deterministic
    async function attachOfflineFilter(page) {
      await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u.startsWith(baseUrl) || u.startsWith('data:') || u.startsWith('blob:')) {
          return route.continue();
        }
        return route.abort();
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const txt = msg.text();
          if (!txt.includes('net::ERR_FAILED')) {
            errors.push(`console.error: ${txt}`);
          }
        }
      });
    }

    // 1. Compact & Control Deck
    {
      const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
      const page = await ctx.newPage();
      await attachOfflineFilter(page);
      await page.addInitScript(installTauriMockScript(), { settingsOverride: null });
      await page.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        document.body.style.background = '#101218';
        const isl = document.getElementById('island');
        if (isl) {
          isl.classList.remove('intro-pre', 'smart-hidden', 'intro-play');
          isl.style.opacity = '1';
        }
      });
      await page.waitForTimeout(300);
      const p1 = join(outDir, '01_compact.png');
      await page.screenshot({ path: p1 });
      saved.push('01_compact.png');

      // Open Control Deck
      await page.evaluate(() => {
        if (typeof window.switchView === 'function') window.switchView('view-control-deck', 'state-control-deck', 548, 218);
      });
      await page.waitForTimeout(650);
      const p2 = join(outDir, '02_deck_menu.png');
      await page.screenshot({ path: p2 });
      saved.push('02_deck_menu.png');

      // Runtime UI interaction harness assertions (Control Deck tabs & theme consistency)
      await page.click('#mx-tab-widgets');
      await page.waitForTimeout(150);
      const widgetsActive = await page.evaluate(() => ({
        deckOpen: document.getElementById('view-control-deck')?.classList.contains('widgets-open') ?? false,
        tabActive: document.getElementById('mx-tab-widgets')?.classList.contains('active') ?? false,
      }));
      if (!widgetsActive.deckOpen || !widgetsActive.tabActive) {
        errors.push(`interaction: #mx-tab-widgets click did not activate widgets view (${JSON.stringify(widgetsActive)})`);
      }
      await page.click('#mx-tab-controls');
      await page.waitForTimeout(100);
      const controlsRestored = await page.evaluate(() =>
        !(document.getElementById('view-control-deck')?.classList.contains('widgets-open') ?? true),
      );
      if (!controlsRestored) {
        errors.push('interaction: #mx-tab-controls click did not restore controls tab');
      }

      await ctx.close();
    }

    // 2. Classic Menu
    {
      const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
      const page = await ctx.newPage();
      await attachOfflineFilter(page);
      await page.addInitScript(installTauriMockScript(), {
        settingsOverride: { appearance: { menuLayout: 'classic' } },
      });
      await page.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        document.body.style.background = '#101218';
        const isl = document.getElementById('island');
        if (isl) {
          isl.classList.remove('intro-pre', 'smart-hidden', 'intro-play');
          isl.style.opacity = '1';
        }
        if (typeof window.switchView === 'function') window.switchView('view-control', 'state-control', 316, 292);
      });
      await page.waitForTimeout(650);
      const p3 = join(outDir, '03_classic_menu.png');
      await page.screenshot({ path: p3 });
      saved.push('03_classic_menu.png');
      await ctx.close();
    }

    // 3. Settings Window (Notch & Screen Time tabs)
    {
      const ctx = await browser.newContext({ viewport: { width: 920, height: 640 } });
      const page = await ctx.newPage();
      await attachOfflineFilter(page);
      await page.addInitScript(installTauriMockScript(), { settingsOverride: null });
      await page.goto(`${baseUrl}/settings.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      const p4 = join(outDir, '04_settings_notch.png');
      await page.screenshot({ path: p4 });
      saved.push('04_settings_notch.png');

      await page.click('.nv[data-id="screentime"]');
      await page.waitForTimeout(350);
      const p5 = join(outDir, '05_settings_screentime.png');
      await page.screenshot({ path: p5 });
      saved.push('05_settings_screentime.png');
      await ctx.close();
    }

    console.log(`Captured ${saved.length} views from ${targetSubdir}/ -> ${outDir}`);
    if (errors.length > 0) {
      console.error('Runtime errors detected:\n' + errors.join('\n'));
      process.exitCode = 1;
    }

    if (!captureMode) {
      console.log('\n=== GOLDEN IMAGE COMPARISON ===');
      let failed = false;
      for (const name of saved) {
        const res = comparePng(name, join(goldenDir, name), join(currentDir, name), join(diffDir, name));
        const ok = res.pct <= 0.5; // allow tiny sub-pixel font anti-aliasing tolerance (<0.5%)
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: diff=${res.badPixels}/${res.total} px (${res.pct.toFixed(3)}%)`);
        if (!ok) failed = true;
      }
      if (failed) {
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
    srv.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
