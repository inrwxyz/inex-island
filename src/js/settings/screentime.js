import { invoke, esc } from './state.js';

let stHistoryCache = [];
let stSelectedDayIdx = 29;
const stIconCache = {};

function fmtDuration(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

function fmtDateTitle(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (isToday) {
    return `Today, ${d.getDate()} ${months[d.getMonth()]}`;
  }
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
}

const APP_BADGE_COLORS = {
  Chrome: '#2563eb',
  'Google Chrome': '#2563eb',
  'VS Code': '#0284c7',
  'Visual Studio Code': '#0284c7',
  Discord: '#6366f1',
  Spotify: '#16a34a',
  Explorer: '#d97706',
  Others: '#64748b'
};

function getBadgeColor(name) {
  return APP_BADGE_COLORS[name] || '#64748b';
}

export async function renderScreenTimeData() {
  const container = document.getElementById('st-bars-container');
  if (!container) return;

  try {
    const rawHistory = await invoke('get_screen_time_history') || [];
    const histMap = {};
    for (const d of rawHistory) {
      if (d && d.date) histMap[d.date] = d;
    }

    const days30 = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const dateKey = `${yyyy}-${mm}-${dd}`;
      const rec = histMap[dateKey] || { date: dateKey, total: 0, apps: [] };
      days30.push({ date: dateKey, dateObj: d, total: rec.total || 0, apps: rec.apps || [] });
    }
    stHistoryCache = days30;
    stSelectedDayIdx = 29;

    const startLbl = document.getElementById('st-chart-start-date');
    if (startLbl && days30[0]) {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      startLbl.textContent = `${days30[0].dateObj.getDate()} ${months[days30[0].dateObj.getMonth()]}`;
    }

    const maxTotal = Math.max(60, ...days30.map(d => d.total));

    container.innerHTML = days30.map((d, idx) => {
      const heightPct = Math.min(100, Math.max(6, Math.round((d.total / maxTotal) * 100)));
      const isOn = idx === stSelectedDayIdx;
      return `<div class="st-bar-col${isOn ? ' on' : ''}" data-idx="${idx}" title="${fmtDateTitle(d.dateObj)}: ${fmtDuration(d.total)}">
        <div class="st-bar-fill" style="height:${heightPct}%"></div>
      </div>`;
    }).join('');

    container.querySelectorAll('.st-bar-col').forEach(col => {
      col.addEventListener('click', () => {
        const idx = parseInt(col.dataset.idx, 10);
        stSelectedDayIdx = idx;
        container.querySelectorAll('.st-bar-col').forEach((c, i) => c.classList.toggle('on', i === idx));
        renderSelectedDayView();
      });
    });

    renderSelectedDayView();
    setupHistoryClear();
  } catch (err) {
    console.error('Error loading screen time data:', err);
  }
}

async function renderSelectedDayView() {
  const day = stHistoryCache[stSelectedDayIdx];
  if (!day) return;

  const dayHdr = document.getElementById('st-day-header');
  const totVal = document.getElementById('st-total-val');
  const listEl = document.getElementById('st-app-list');
  if (dayHdr) dayHdr.textContent = fmtDateTitle(day.dateObj);
  if (totVal) totVal.textContent = fmtDuration(day.total);
  if (!listEl) return;

  if (!day.apps || day.apps.length === 0) {
    listEl.innerHTML = `<div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">No apps recorded</div></div>`;
    return;
  }

  const maxAppSecs = Math.max(1, ...day.apps.map(a => a.secs));

  listEl.innerHTML = day.apps.map(app => {
    const widthPct = Math.min(100, Math.max(4, Math.round((app.secs / maxAppSecs) * 100)));
    const cachedIcon = stIconCache[app.exe];
    const iconHtml = cachedIcon
      ? `<img src="${cachedIcon}" class="st-app-ico" alt="" />`
      : `<span class="st-app-badge" style="background:${getBadgeColor(app.name)}">${(app.name || 'O')[0].toUpperCase()}</span>`;
    return `<div class="st-app-row" data-exe="${esc(app.exe)}">
      <div class="st-app-icon-box">${iconHtml}</div>
      <div class="st-app-name" title="${esc(app.name)}">${esc(app.name)}</div>
      <div class="st-app-bar-wrap">
        <div class="st-app-bar-fill" style="width:${widthPct}%"></div>
      </div>
      <div class="st-app-dur">${fmtDuration(app.secs)}</div>
    </div>`;
  }).join('');

  const neededExes = day.apps.map(a => a.exe).filter(e => !stIconCache[e]);
  if (neededExes.length > 0) {
    try {
      const newIcons = await invoke('get_app_icons', { exes: neededExes });
      if (newIcons && typeof newIcons === 'object') {
        Object.assign(stIconCache, newIcons);
        listEl.querySelectorAll('.st-app-row').forEach(row => {
          const exe = row.dataset.exe;
          const url = stIconCache[exe];
          if (url) {
            const box = row.querySelector('.st-app-icon-box');
            if (box) box.innerHTML = `<img src="${url}" class="st-app-ico" alt="" />`;
          }
        });
      }
    } catch (_) {}
  }
}

function setupHistoryClear() {
  const actions = document.getElementById('st-hist-actions');
  if (!actions) return;

  actions.innerHTML = `<button class="btn" id="btn-st-clear" type="button" style="color:#ff453a">Clear history</button>`;
  document.getElementById('btn-st-clear')?.addEventListener('click', () => {
    actions.innerHTML = `
      <span class="st-clear-prompt">Clear all 30 days?</span>
      <button class="btn" id="btn-st-cancel" type="button">Cancel</button>
      <button class="btn" id="btn-st-confirm" type="button" style="color:#ff453a;background:rgba(255,69,58,0.15)">Clear</button>
    `;
    document.getElementById('btn-st-cancel')?.addEventListener('click', setupHistoryClear);
    document.getElementById('btn-st-confirm')?.addEventListener('click', async () => {
      await invoke('clear_screen_time');
      stHistoryCache = [];
      await renderScreenTimeData();
    });
  });
}
