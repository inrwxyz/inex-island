// ==================== 14c. CLIPBOARD HISTORY SHELF ====================
// Keeps the last CLIPBOARD_MAX copies: text, images and copied files.
// Text and image thumbnails live in localStorage; the full-size images live in IndexedDB (much bigger quota).
const CLIPBOARD_STORAGE_KEY = 'inex.island.clipboard.v1';
const CLIPBOARD_MAX = 20;            // how many items we remember
const CLIPBOARD_TEXT_LIMIT = 50000;  // longest text kept per item
const CLIPBOARD_THUMB_W = 520;       // thumbnail box (px), shown ~2x sharper than the card
const CLIPBOARD_THUMB_H = 180;
let clipboardItems = [];

// ---------- full-size image store (IndexedDB) ----------
let clipDbPromise = null;
function clipDb() {
  if (!clipDbPromise) {
    clipDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('inex-island-clipboard', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('images', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  return clipDbPromise;
}
async function clipIdb(mode, fn) {
  const db = await clipDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('images', mode);
      const req = fn(tx.objectStore('images'));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
const clipBlobPut = (id, blob) => clipIdb('readwrite', (s) => s.put({ id, blob }));
const clipBlobGet = async (id) => { const r = await clipIdb('readonly', (s) => s.get(id)); return r && r.blob ? r.blob : null; };
const clipBlobClear = () => clipIdb('readwrite', (s) => s.clear());
// Drop stored images that no longer belong to a history item
async function pruneClipboardBlobs() {
  const keys = await clipIdb('readonly', (s) => s.getAllKeys());
  if (!Array.isArray(keys)) return;
  const keep = new Set(clipboardItems.filter((i) => i.kind === 'image').map((i) => i.id));
  const stale = keys.filter((k) => !keep.has(k));
  if (stale.length) await clipIdb('readwrite', (s) => { stale.forEach((k) => s.delete(k)); return null; });
}

// ---------- history list ----------
function loadClipboardHistory() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    clipboardItems = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(clipboardItems)) clipboardItems = [];
  } catch (_) {
    clipboardItems = [];
  }
  // items saved by older versions have no "kind": they are text
  clipboardItems.forEach((it) => { if (!it.kind) it.kind = 'text'; });
  clipboardItems = clipboardItems.slice(0, CLIPBOARD_MAX);
}

function saveClipboardHistory() {
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems.slice(0, CLIPBOARD_MAX)));
  } catch (_) {
    // storage full: drop the oldest half and try once more
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

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clipFileName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// Same content as before? (cheap 32-bit FNV-1a)
function clipHashBytes(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + u8.length;
}
function clipHashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + s.length;
}

// Text and background items (images/files) are capped separately, so a burst of screenshots never pushes text out
const CLIPBOARD_MAX_HIDDEN = 8;
function trimClipboardItems() {
  // newest first: a new copy pushes the oldest one (text, image or file) out once there are more than CLIPBOARD_MAX
  clipboardItems = clipboardItems.slice(0, CLIPBOARD_MAX);
}

// Put a new item on top. A copy of something already in the list just moves that item to the top.
function pushClipboardItem(item) {
  const idx = clipboardItems.findIndex((it) => it.kind === item.kind && it.hash === item.hash);
  if (idx === 0) return false;                       // already the newest
  if (idx > 0) clipboardItems.splice(idx, 1);
  clipboardItems.unshift(item);
  trimClipboardItems();
  saveClipboardHistory();
  pruneClipboardBlobs();
  if (appState.currentView === 'view-clipboard') renderClipboardList();
  return true;
}

function addClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  let clean = text.trim();
  if (!clean) return false;
  if (clean.length > CLIPBOARD_TEXT_LIMIT) clean = clean.slice(0, CLIPBOARD_TEXT_LIMIT);
  // reuse the id of an identical item, otherwise make a new one
  return pushClipboardItem({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    kind: 'text',
    hash: clipHashString(clean),
    text: clean,
    time: Date.now()
  });
}

const CLIP_IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const CLIP_VID_EXT = /\.(mp4|mkv|mov|avi|webm|wmv|flv|m4v|mpg|mpeg|3gp)$/i;
const CLIP_ICON_FILE_BIG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>';
const CLIP_ICON_VIDEO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><polygon points="10.5 9.5 15 12 10.5 14.5" fill="currentColor" stroke="none"/></svg>';

// Small preview of a picture file (null for videos, documents, missing or huge files)
async function makeFileThumb(path) {
  try {
    if (!CLIP_IMG_EXT.test(path)) return null;
    const dataUrl = await tryInvoke('read_image_file', { path });
    if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.length < 32) return null;
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 360 / w, 160 / h);
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    c.getContext('2d').drawImage(img, 0, 0, tw, th);
    return c.toDataURL('image/webp', 0.8);
  } catch (_) {
    return null;
  }
}

// thumbs[i] belongs to paths[i] (only the first 3 are shown, so only those get a preview)
async function makeFileThumbs(paths) {
  const out = [];
  for (let i = 0; i < Math.min(3, paths.length); i++) out.push(await makeFileThumb(paths[i]));
  return out;
}

async function addClipboardFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  const list = paths.slice(0, 200);
  const hash = clipHashString(list.join('|'));
  const old = clipboardItems.find((it) => it.kind === 'files' && it.hash === hash);
  if (old) { old.time = Date.now(); return pushClipboardItem(old); }
  const thumbs = await makeFileThumbs(list);
  return pushClipboardItem({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    kind: 'files',
    hash,
    paths: list,
    thumbs: thumbs.some(Boolean) ? thumbs : null,
    thumbsDone: true,
    time: Date.now()
  });
}

// Files copied before previews existed: make them once, then redraw
async function fillMissingFileThumbs() {
  let changed = false;
  for (const it of clipboardItems) {
    if (it.kind !== 'files' || it.thumbsDone) continue;
    it.thumbsDone = true;
    const thumbs = await makeFileThumbs(it.paths);
    if (thumbs.some(Boolean)) { it.thumbs = thumbs; changed = true; }
  }
  if (changed) {
    saveClipboardHistory();
    if (appState.currentView === 'view-clipboard') renderClipboardList();
  }
}

async function addClipboardImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return false;

    // full image as PNG (a PNG from the clipboard is kept as it is; a bitmap is converted)
    let blob;
    if (dataUrl.startsWith('data:image/png')) {
      blob = await (await fetch(dataUrl)).blob();
    } else {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    }
    if (!blob) return false;
    const hash = clipHashBytes(new Uint8Array(await blob.arrayBuffer()));

    // thumbnail for the list
    const scale = Math.min(1, CLIPBOARD_THUMB_W / w, CLIPBOARD_THUMB_H / h);
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    const tc = document.createElement('canvas');
    tc.width = tw; tc.height = th;
    tc.getContext('2d').drawImage(img, 0, 0, tw, th);
    const thumb = tc.toDataURL('image/webp', 0.82);

    const id = Date.now() + Math.random().toString(36).slice(2, 6);
    // same picture copied again: just bring the old item to the top
    const old = clipboardItems.find((it) => it.kind === 'image' && it.hash === hash);
    if (old) { old.time = Date.now(); return pushClipboardItem(old); }

    await clipBlobPut(id, blob);
    return pushClipboardItem({ id, kind: 'image', hash, thumb, w, h, bytes: blob.size, time: Date.now() });
  } catch (_) {
    return false;
  }
}

// ---------- drawing ----------
const CLIP_ICON_FILE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>';

function renderClipboardList() {
  const container = document.getElementById('clipboard-list');
  if (!container) return;

  // text, images / screenshots and copied files (photos, videos ...) all show here
  const visibleItems = clipboardItems;

  if (visibleItems.length === 0) {
    container.innerHTML = `
      <div class="clipboard-empty">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none" opacity="0.4"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        <span>Nothing copied yet</span>
        <small style="opacity:0.4; font-size:9.5px;">Copy text, an image or a file (Ctrl+C)</small>
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
    if (item.kind === 'image') {
      timeSpan.textContent = `${formatRelativeTime(item.time)} • Image`;
    } else if (item.kind === 'files') {
      const n = item.paths.length;
      const only = n === 1 ? item.paths[0] : '';
      const what = only ? (CLIP_IMG_EXT.test(only) ? 'Image' : CLIP_VID_EXT.test(only) ? 'Video' : 'File') : `${n} files`;
      timeSpan.textContent = `${formatRelativeTime(item.time)} • ${what}`;
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
      pruneClipboardBlobs();
      renderClipboardList();
    });

    actions.appendChild(copyTag);
    actions.appendChild(delBtn);
    header.appendChild(timeSpan);
    header.appendChild(actions);

    if (item.kind === 'image' || item.kind === 'files') {
      // same card height as a text item: small thumbnail in front, details on the side
      card.classList.add('clip-media');
      const row = document.createElement('div');
      row.className = 'clip-media-row';

      const th = document.createElement('div');
      th.className = 'clip-thumb';
      const firstPath = item.kind === 'files' ? item.paths[0] : '';
      const thumbSrc = item.kind === 'image' ? item.thumb : (item.thumbs && item.thumbs[0]);
      if (thumbSrc) {
        const im = document.createElement('img');
        im.src = thumbSrc;
        im.alt = '';
        im.draggable = false;
        th.appendChild(im);
      } else {
        th.innerHTML = (item.kind === 'files' && CLIP_VID_EXT.test(firstPath)) ? CLIP_ICON_VIDEO : CLIP_ICON_FILE_BIG;
      }

      const info = document.createElement('div');
      info.className = 'clip-media-info';
      info.appendChild(header);
      const det = document.createElement('div');
      det.className = 'clip-media-name';
      if (item.kind === 'image') {
        det.textContent = `${item.w}×${item.h}${item.bytes ? ' • ' + formatBytes(item.bytes) : ''}`;
      } else {
        const more = item.paths.length > 1 ? `  +${item.paths.length - 1} more` : '';
        det.textContent = clipFileName(item.paths[0]) + more;
      }
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
        if (item.kind === 'image') {
          const blob = await clipBlobGet(item.id);
          if (blob) {
            clipSelfImageUntil = Date.now() + 1500; // do not record our own copy as a new item
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            ok = true;
          }
        } else if (item.kind === 'files') {
          ok = !!(await tryInvoke('set_clipboard_files', { paths: item.paths }));
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
        showToast('snip', item.kind === 'image' && !(await clipBlobGet(item.id)) ? 'Image no longer stored' : 'Copy failed', 1200);
      }
    });

    container.appendChild(card);
  });
}

// ---------- reading the system clipboard ----------
let clipSelfImageUntil = 0; // set when WE put an image on the clipboard (history click)
let clipLastSeq = 0;        // Windows clipboard change counter we already recorded

// What is on the clipboard right now? Files first, then text, then image
// (Excel and Word put text AND a picture of it: the text is what we want there).
async function readClipboardOnce() {
  const files = await tryInvoke('get_clipboard_files', {});
  if (Array.isArray(files) && files.length) return { kind: 'files', paths: files };
  const t = await tryInvoke('get_clipboard_text', {});
  if (t && typeof t === 'string' && t.trim()) return { kind: 'text', text: t };
  const img = await tryInvoke('get_clipboard_image', {});
  if (img && typeof img === 'string' && img.length > 32) return { kind: 'image', dataUrl: img };
  return null;
}

// Windows fires "clipboard changed" while the copying app can still be holding the clipboard open, so a single
// read often comes back empty. Read again a few times before giving up.
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

async function recordClipboardPayload(got) {
  if (!got) return false;
  if (got.kind === 'files') return addClipboardFiles(got.paths);
  if (got.kind === 'text') return addClipboardText(got.text);
  if (got.kind === 'image') {
    if (Date.now() < clipSelfImageUntil) return false;
    return await addClipboardImage(got.dataUrl);
  }
  return false;
}

// Catches copies we did not see live (copied before the island started, or while it was asleep)
async function checkSystemClipboard() {
  try {
    const seq = await tryInvoke('clipboard_seq', {});
    if (seq && seq === clipLastSeq) return;      // nothing new since the last time
    const got = await readClipboardOnce();
    if (seq) clipLastSeq = seq;
    await recordClipboardPayload(got);
  } catch (_) {}
}

function openClipboardView() {
  checkSystemClipboard().then(renderClipboardList).then(fillMissingFileThumbs);
}

// Initialise
loadClipboardHistory();
pruneClipboardBlobs();
setTimeout(fillMissingFileThumbs, 1500);

document.getElementById('btn-clipboard-clear')?.addEventListener('click', () => {
  if (clipboardItems.length === 0) return;
  clipboardItems = [];
  saveClipboardHistory();
  clipBlobClear();
  renderClipboardList();
  showToast('unlock', 'Clipboard cleared', 1200);
});

// Periodic and event-driven clipboard capture when user interacts
window.addEventListener('focus', checkSystemClipboard);
document.getElementById('island')?.addEventListener('mouseenter', checkSystemClipboard);

// System-wide copy -> little "Copied" popup in the island (Windows tells us the clipboard changed, no matter which app copied)
const CLIP_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path class="clip-tick" d="M8.5 14.5l2.5 2.5 4.5-5"/></svg>';
let clipHudAt = 0;

let clipCopySeq = 0;
onTauriEvent('clipboard-copied', async () => {
  if (SET.general && SET.general.copyToast === false) return; // toggle OFF: do nothing
  const mySeq = ++clipCopySeq;
  const got = await readClipboardWithRetry();
  if (mySeq !== clipCopySeq) return;   // a newer copy arrived while waiting: that one shows the popup
  const seq = await tryInvoke('clipboard_seq', {});
  if (seq) clipLastSeq = seq;
  const selfImage = got && got.kind === 'image' && Date.now() < clipSelfImageUntil;
  await recordClipboardPayload(got);
  if (selfImage) return;               // our own history click: no popup

  // our own copy buttons already show a toast; do not stack a second popup
  if (appState.toast) return;
  const now = Date.now();
  if (now - clipHudAt < 500) return;
  clipHudAt = now;

  let tag = 'Copied to Clipboard';
  if (got && got.kind === 'text') {
    const one = got.text.replace(/\s+/g, ' ').trim();
    tag = one.length > 24 ? one.slice(0, 24) + '\u2026' : one;
  } else if (got && got.kind === 'image') {
    tag = 'Image copied';
  } else if (got && got.kind === 'files') {
    tag = got.paths.length === 1 ? clipFileName(got.paths[0]) : `${got.paths.length} files`;
    if (tag.length > 24) tag = tag.slice(0, 24) + '\u2026';
  }
  showDeviceHud({
    iconHTML: CLIP_HUD_SVG, plain: true,
    name: 'Copied',
    tag,
    ms: 1700
  });
});
