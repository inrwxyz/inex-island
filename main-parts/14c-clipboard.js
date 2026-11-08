// ==================== 14c. CLIPBOARD HISTORY SHELF ====================
const CLIPBOARD_STORAGE_KEY = 'inex.island.clipboard.v1';
let clipboardItems = [];

function loadClipboardHistory() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    clipboardItems = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(clipboardItems)) clipboardItems = [];
  } catch (_) {
    clipboardItems = [];
  }
}

function saveClipboardHistory() {
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(clipboardItems.slice(0, 25)));
  } catch (_) {}
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

function addClipboardText(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim();
  if (!clean || clean.length < 1) return false;

  // Don't duplicate the top item
  if (clipboardItems.length > 0 && clipboardItems[0].text === clean) {
    return false;
  }

  // Remove existing match if already in list to bump to top
  const existIdx = clipboardItems.findIndex((it) => it.text === clean);
  if (existIdx >= 0) {
    clipboardItems.splice(existIdx, 1);
  }

  clipboardItems.unshift({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    text: clean,
    time: Date.now()
  });

  if (clipboardItems.length > 25) {
    clipboardItems = clipboardItems.slice(0, 25);
  }

  saveClipboardHistory();
  if (appState.currentView === 'view-clipboard') {
    renderClipboardList();
  }
  return true;
}

function renderClipboardList() {
  const container = document.getElementById('clipboard-list');
  if (!container) return;

  if (clipboardItems.length === 0) {
    container.innerHTML = `
      <div class="clipboard-empty">
        <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.8" fill="none" opacity="0.4"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        <span>No copied text yet</span>
        <small style="opacity:0.4; font-size:9.5px;">Copy text anywhere (Ctrl+C)</small>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  clipboardItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'clipboard-item';
    card.title = 'Click to copy';

    const header = document.createElement('div');
    header.className = 'clipboard-item-header';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = `${formatRelativeTime(item.time)} • ${item.text.length} chars`;

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

    const body = document.createElement('div');
    body.className = 'clipboard-item-text';
    body.textContent = item.text;

    card.appendChild(header);
    card.appendChild(body);

    card.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.text);
        card.classList.add('copied');
        showToast('snip', 'Copied to clipboard', 1200);
        setTimeout(() => { card.classList.remove('copied'); }, 1100);
      } catch (_) {
        showToast('snip', 'Copy failed', 1200);
      }
    });

    container.appendChild(card);
  });
}

async function checkSystemClipboard() {
  try {
    if (document.hasFocus() && navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) addClipboardText(text);
    }
  } catch (_) {}
}

function openClipboardView() {
  checkSystemClipboard().then(renderClipboardList);
}

// Initialise
loadClipboardHistory();

document.getElementById('btn-clipboard-clear')?.addEventListener('click', () => {
  if (clipboardItems.length === 0) return;
  clipboardItems = [];
  saveClipboardHistory();
  renderClipboardList();
  showToast('unlock', 'Clipboard cleared', 1200);
});

// Periodic and event-driven clipboard capture when user interacts
window.addEventListener('focus', checkSystemClipboard);
document.getElementById('island')?.addEventListener('mouseenter', checkSystemClipboard);

// System-wide copy -> little "Copied" popup in the island (Windows tells us the clipboard changed, no matter which app copied)
const CLIP_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path class="clip-tick" d="M8.5 14.5l2.5 2.5 4.5-5"/></svg>';
let clipHudAt = 0;

// Windows fires "clipboard changed" while the copying app can still be holding the clipboard open, so a single
// read often comes back empty and the popup was silently skipped. Read again a few times before giving up.
async function readClipboardWithRetry() {
  const waits = [0, 50, 120, 250, 450];
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    const t = await tryInvoke('get_clipboard_text', {});
    if (t && typeof t === 'string' && t.trim()) return t;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) return t;
    }
  } catch (_) {}
  return '';
}

let clipCopySeq = 0;
onTauriEvent('clipboard-copied', async () => {
  if (SET.general && SET.general.copyToast === false) return; // toggle OFF: do nothing
  const mySeq = ++clipCopySeq;
  const text = await readClipboardWithRetry();
  if (mySeq !== clipCopySeq) return;   // a newer copy arrived while waiting: that one shows the popup
  if (text) addClipboardText(text);

  // our own copy buttons already show a toast; do not stack a second popup
  if (appState.toast) return;
  const now = Date.now();
  if (now - clipHudAt < 500) return;
  clipHudAt = now;
  const one = text ? text.replace(/\s+/g, ' ').trim() : '';
  showDeviceHud({
    iconHTML: CLIP_HUD_SVG, plain: true,
    name: 'Copied',
    // nothing readable as text = a file / image was copied
    tag: one ? (one.length > 24 ? one.slice(0, 24) + '\u2026' : one) : 'Copied to Clipboard',
    ms: 1700
  });
});
