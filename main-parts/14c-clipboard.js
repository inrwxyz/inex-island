// ==================== 14c. CLIPBOARD HISTORY SHELF ====================
// Keeps ONLY the last CLIPBOARD_MAX copied text snippets and OS screenshot paths.
// Zero internal image storage (no IndexedDB blobs, no base64 thumbnails in localStorage).
// Deleted screenshot files are dropped automatically via ReadDirectoryChangesW & existence checks.
const CLIPBOARD_STORAGE_KEY = 'inex.island.clipboard.v1';
const CLIPBOARD_MAX = 20;
const CLIPBOARD_TEXT_LIMIT = 50000;
let clipboardItems = [];
let clipPreviewUrls = [];
let clipRenderGen = 0;

// Purge legacy IndexedDB full-image cache from older versions if present.
try { indexedDB.deleteDatabase('inex-island-clipboard'); } catch (_) {}

function revokeClipPreviews() {
  for (const url of clipPreviewUrls) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
  clipPreviewUrls = [];
}

function closeClipboardView() {
  clipRenderGen++;
  revokeClipPreviews();
  const container = document.getElementById('clipboard-list');
  if (container) container.innerHTML = '';
}

function clipPathKey(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function clipFileName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// ---------- history list ----------
function loadClipboardHistory() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      clipboardItems = [];
      return;
    }
    clipboardItems = parsed
      .filter((it) => {
        if (!it) return false;
        const kind = it.kind || (typeof it.text === 'string' ? 'text' : '');
        if (kind === 'text') return typeof it.text === 'string' && it.text.trim().length > 0;
        if (kind === 'screenshot') return typeof it.path === 'string' && it.path.trim().length > 0;
        return false; // Drop legacy 'image' blobs and regular 'files' entries
      })
      .map((it) => {
        const kind = it.kind || 'text';
        if (kind === 'screenshot') {
          return {
            id: it.id || (Date.now() + Math.random().toString(36).slice(2, 6)),
            kind: 'screenshot',
            hash: clipPathKey(it.path),
            path: it.path,
            name: it.name || clipFileName(it.path),
            time: it.time || Date.now()
          };
        }
        return {
          id: it.id || (Date.now() + Math.random().toString(36).slice(2, 6)),
          kind: 'text',
          hash: it.hash || clipHashString(it.text),
          text: it.text,
          time: it.time || Date.now()
        };
      })
      .slice(0, CLIPBOARD_MAX);
  } catch (_) {
    clipboardItems = [];
  }
}

function saveClipboardHistory() {
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems.slice(0, CLIPBOARD_MAX)));
  } catch (_) {
    try {
      clipboardItems = clipboardItems.slice(0, Math.ceil(CLIPBOARD_MAX / 2));
      localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems));
    } catch (_) {}
  }
}

function formatRelativeTime(ts) {
  if (!ts) return 'Just now';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 30) return 'Just now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clipHashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

function trimClipboardItems() {
  clipboardItems = clipboardItems.slice(0, CLIPBOARD_MAX);
}

function pushClipboardItem(item) {
  const idx = clipboardItems.findIndex((it) => it.kind === item.kind && it.hash === item.hash);
  if (idx === 0) return false;
  if (idx > 0) clipboardItems.splice(idx, 1);
  clipboardItems.unshift(item);
  trimClipboardItems();
  saveClipboardHistory();
  if (appState.currentView === 'view-clipboard') renderClipboardList();
  return true;
}

function addClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  let clean = text.trim();
  if (!clean) return false;
  if (clean.length > CLIPBOARD_TEXT_LIMIT) clean = clean.slice(0, CLIPBOARD_TEXT_LIMIT);
  return pushClipboardItem({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    kind: 'text',
    hash: clipHashString(clean),
    text: clean,
    time: Date.now()
  });
}

function addClipboardScreenshot(path) {
  if (!path || typeof path !== 'string') return false;
  const clean = path.trim();
  if (!clean) return false;
  return pushClipboardItem({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    kind: 'screenshot',
    hash: clipPathKey(clean),
    path: clean,
    name: clipFileName(clean),
    time: Date.now()
  });
}

function removeScreenshotByPath(path) {
  const key = clipPathKey(path);
  if (!key) return false;
  const before = clipboardItems.length;
  clipboardItems = clipboardItems.filter((it) => !(it.kind === 'screenshot' && clipPathKey(it.path) === key));
  if (clipboardItems.length === before) return false;
  saveClipboardHistory();
  if (appState.currentView === 'view-clipboard') renderClipboardList();
  return true;
}

async function pruneMissingScreenshots() {
  const shots = clipboardItems.filter((it) => it.kind === 'screenshot').map((it) => it.path);
  if (shots.length === 0) return false;
  const existing = await tryInvoke('filter_existing_paths', { paths: shots });
  if (!Array.isArray(existing)) return false;
  const keep = new Set(existing.map(clipPathKey));
  const before = clipboardItems.length;
  clipboardItems = clipboardItems.filter((it) => it.kind !== 'screenshot' || keep.has(clipPathKey(it.path)));
  if (clipboardItems.length === before) return false;
  saveClipboardHistory();
  return true;
}

const CLIP_ICON_SCREENSHOT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="1.5"/><path d="M21 15l-4.5-4.5L7 19"/></svg>';

// Transient 96px thumbnail created ONLY while Clipboard view is open; cleared on close.
async function hydrateScreenshotThumb(path, containerEl, gen) {
  try {
    const ab = await invokeTauri('read_screenshot_bytes', { path });
    if (gen !== clipRenderGen || appState.currentView !== 'view-clipboard') return;
    if (!ab || ab.byteLength === 0) {
      if (removeScreenshotByPath(path)) return;
      return;
    }
    const rawBlob = new Blob([ab]);
    const bmp = await createImageBitmap(rawBlob, { resizeWidth: 96, resizeHeight: 96, resizeQuality: 'medium' });
    let thumbUrl = '';
    try {
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const smallBlob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
      if (smallBlob && gen === clipRenderGen && appState.currentView === 'view-clipboard') {
        thumbUrl = URL.createObjectURL(smallBlob);
      }
    } finally {
      bmp.close();
    }
    if (!thumbUrl) return;
    clipPreviewUrls.push(thumbUrl);
    const im = document.createElement('img');
    im.src = thumbUrl;
    im.alt = '';
    im.draggable = false;
    containerEl.innerHTML = '';
    containerEl.appendChild(im);
  } catch (_) {
    // Missing or deleted screenshot file: remove from history automatically
    removeScreenshotByPath(path);
  }
}

// ---------- drawing ----------
function renderClipboardList() {
  if (appState.currentView !== 'view-clipboard') return;
  const container = document.getElementById('clipboard-list');
  if (!container) return;

  const gen = ++clipRenderGen;
  revokeClipPreviews();
  const visibleItems = clipboardItems;

  if (visibleItems.length === 0) {
    container.innerHTML = `
      <div class="clipboard-empty">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none" opacity="0.4"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        <span>Nothing copied yet</span>
        <small style="opacity:0.4; font-size:9.5px;">Copied text &amp; screenshots appear here</small>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  visibleItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'clipboard-item';
    card.title = 'Click to copy';

    const header = document.createElement('div');
    header.className = 'clipboard-item-header';

    const timeSpan = document.createElement('span');
    if (item.kind === 'screenshot') {
      timeSpan.textContent = `${formatRelativeTime(item.time)} • Screenshot`;
    } else {
      timeSpan.textContent = `${formatRelativeTime(item.time)} • ${item.text.length} chars`;
    }

    const actions = document.createElement('div');
    actions.className = 'clipboard-item-actions';

    const copyTag = document.createElement('span');
    copyTag.className = 'clipboard-copy-tag';
    copyTag.textContent = 'Copied!';

    const delBtn = document.createElement('button');
    delBtn.className = 'clipboard-del-btn';
    delBtn.title = 'Remove';
    delBtn.innerHTML = '✕';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clipboardItems = clipboardItems.filter((x) => x.id !== item.id);
      saveClipboardHistory();
      renderClipboardList();
    });

    actions.appendChild(copyTag);
    actions.appendChild(delBtn);
    header.appendChild(timeSpan);
    header.appendChild(actions);

    if (item.kind === 'screenshot') {
      card.classList.add('clip-media');
      const row = document.createElement('div');
      row.className = 'clip-media-row';

      const th = document.createElement('div');
      th.className = 'clip-thumb';
      th.innerHTML = CLIP_ICON_SCREENSHOT;
      hydrateScreenshotThumb(item.path, th, gen);

      const info = document.createElement('div');
      info.className = 'clip-media-info';
      info.appendChild(header);
      const det = document.createElement('div');
      det.className = 'clip-media-name';
      det.textContent = item.name || clipFileName(item.path);
      info.appendChild(det);

      row.appendChild(th);
      row.appendChild(info);
      card.appendChild(row);
    } else {
      card.appendChild(header);
      const body = document.createElement('div');
      body.className = 'clipboard-item-text';
      body.textContent = item.text;
      card.appendChild(body);
    }

    card.addEventListener('click', async () => {
      let ok = false;
      try {
        if (item.kind === 'screenshot') {
          ok = !!(await tryInvoke('set_clipboard_files', { paths: [item.path] }));
          if (!ok) {
            removeScreenshotByPath(item.path);
            showToast('snip', 'Screenshot deleted', 1200);
            return;
          }
        } else {
          await navigator.clipboard.writeText(item.text);
          ok = true;
        }
      } catch (_) { ok = false; }

      if (ok) {
        card.classList.add('copied');
        showToast('snip', 'Copied to clipboard', 1200);
        setTimeout(() => { card.classList.remove('copied'); }, 1100);
      } else {
        showToast('snip', 'Copy failed', 1200);
      }
    });

    container.appendChild(card);
  });
}

// ---------- reading the system clipboard (Text + Screenshot paths only) ----------
let clipLastSeq = 0;

async function readClipboardOnce() {
  const files = await tryInvoke('get_clipboard_files', {});
  if (Array.isArray(files) && files.length > 0) {
    // Only record screenshots copied from the OS Screenshots folder; ignore other copied/cut files.
    const shots = await tryInvoke('filter_screenshot_paths', { paths: files });
    if (Array.isArray(shots) && shots.length > 0) {
      return { kind: 'screenshot', path: shots[0] };
    }
    return { kind: 'ignored' };
  }
  const t = await tryInvoke('get_clipboard_text', {});
  if (t && typeof t === 'string' && t.trim()) return { kind: 'text', text: t };
  return null;
}

async function readClipboardWithRetry() {
  const waits = [0, 50, 120, 250, 450];
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    const got = await readClipboardOnce();
    if (got) return got;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) return { kind: 'text', text: t };
    }
  } catch (_) {}
  return null;
}

function recordClipboardPayload(got) {
  if (!got || got.kind === 'ignored') return false;
  if (got.kind === 'screenshot') return addClipboardScreenshot(got.path);
  if (got.kind === 'text') return addClipboardText(got.text);
  return false;
}

async function checkSystemClipboard() {
  try {
    const seq = await tryInvoke('clipboard_seq', {});
    if (seq && seq === clipLastSeq) return;
    const got = await readClipboardOnce();
    if (seq) clipLastSeq = seq;
    recordClipboardPayload(got);
  } catch (_) {}
}

function openClipboardView() {
  Promise.all([checkSystemClipboard(), pruneMissingScreenshots()]).then(() => {
    renderClipboardList();
  });
}

// Initialise & prune stale/deleted items immediately
loadClipboardHistory();
saveClipboardHistory();
pruneMissingScreenshots();

document.getElementById('btn-clipboard-clear')?.addEventListener('click', () => {
  if (clipboardItems.length === 0) return;
  clipboardItems = [];
  revokeClipPreviews();
  saveClipboardHistory();
  renderClipboardList();
  showToast('unlock', 'Clipboard cleared', 1200);
});

window.addEventListener('focus', checkSystemClipboard);
document.getElementById('island')?.addEventListener('mouseenter', checkSystemClipboard);

const CLIP_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path class="clip-tick" d="M8.5 14.5l2.5 2.5 4.5-5"/></svg>';
let clipHudAt = 0;

function showClipboardHud(tag) {
  if (SET.general && SET.general.copyToast === false) return;
  if (appState.toast) return;
  const now = Date.now();
  if (now - clipHudAt < 500) return;
  clipHudAt = now;
  showDeviceHud({
    iconHTML: CLIP_HUD_SVG, plain: true,
    name: 'Copied',
    tag,
    ms: 1700
  });
}

// Native zero-polling OS screenshot folder watcher events (ReadDirectoryChangesW)
onTauriEvent('screenshot-added', (ev) => {
  const path = ev && ev.payload && ev.payload.path;
  if (!path) return;
  if (addClipboardScreenshot(path)) {
    const name = clipFileName(path);
    showClipboardHud(name.length > 24 ? name.slice(0, 24) + '\u2026' : name);
  }
});

onTauriEvent('screenshot-removed', (ev) => {
  const path = ev && ev.payload && ev.payload.path;
  if (path) removeScreenshotByPath(path);
});

let clipCopySeq = 0;
onTauriEvent('clipboard-copied', async () => {
  const mySeq = ++clipCopySeq;
  const got = await readClipboardWithRetry();
  if (mySeq !== clipCopySeq) return;
  const seq = await tryInvoke('clipboard_seq', {});
  if (seq) clipLastSeq = seq;
  if (!got || got.kind === 'ignored') return;
  recordClipboardPayload(got);

  if (got.kind === 'text') {
    const one = got.text.replace(/\s+/g, ' ').trim();
    showClipboardHud(one.length > 24 ? one.slice(0, 24) + '\u2026' : one);
  } else if (got.kind === 'screenshot') {
    const name = clipFileName(got.path);
    showClipboardHud(name.length > 24 ? name.slice(0, 24) + '\u2026' : name);
  }
});
