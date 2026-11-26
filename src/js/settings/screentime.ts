import { invoke, esc } from './state.js';

interface AppUsageEntry {
  exe: string;
  name: string;
  secs: number;
}

interface RawHistoryDay {
  date?: string;
  total?: number;
  apps?: AppUsageEntry[];
}

interface SessionEntry {
  status?: string;
  start_label?: string;
  end_label?: string;
  duration_secs?: number;
}

interface RawSessionDay {
  date?: string;
  total_secs?: number;
  sessions?: SessionEntry[];
}

interface HistoryDayItem {
  date: string;
  dateObj: Date;
  total: number;
  apps: AppUsageEntry[];
}

interface SessionDayItem {
  date: string;
  dateObj: Date;
  total: number;
  sessions: SessionEntry[];
}

let stHistoryCache: HistoryDayItem[] = [];
let stSessionCache: SessionDayItem[] | null = null;
let stSessionFetchedAt = 0;
let stSessionInFlight: Promise<SessionDayItem[]> | null = null;
let stSelectedDayIdx = 29;
let stViewMode: 'apps' | 'sessions' = 'apps';
const stIconCache: Record<string, string> = {};

function fmtDuration(secs?: number): string {
  const s = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtDateTitle(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (isToday) {
    return `Today, ${d.getDate()} ${months[d.getMonth()]}`;
  }
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`;
}

const APP_BADGE_COLORS: Record<string, string> = {
  Chrome: '#2563eb',
  'Google Chrome': '#2563eb',
  'VS Code': '#0284c7',
  'Visual Studio Code': '#0284c7',
  Discord: '#6366f1',
  Spotify: '#16a34a',
  Explorer: '#d97706',
  Others: '#64748b'
};

function getBadgeColor(name: string): string {
  return APP_BADGE_COLORS[name] || '#64748b';
}

function buildLast30DateGrid(): Array<{ date: string; dateObj: Date }> {
  const now = new Date();
  const out: Array<{ date: string; dateObj: Date }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push({ date: `${yyyy}-${mm}-${dd}`, dateObj: d });
  }
  return out;
}

function renderBarsForActiveMode(): void {
  const container = document.getElementById('st-bars-container');
  if (!container) return;

  const list: Array<{ dateObj: Date; total: number }> = stViewMode === 'sessions' && stSessionCache ? stSessionCache : stHistoryCache;
  if (!list.length) return;

  const startLbl = document.getElementById('st-chart-start-date');
  if (startLbl && list[0]) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    startLbl.textContent = `${list[0].dateObj.getDate()} ${months[list[0].dateObj.getMonth()]}`;
  }

  const maxTotal = Math.max(60, ...list.map((d) => d.total || 0));
  container.innerHTML = list.map((d, idx) => {
    const t = d.total || 0;
    const heightPct = Math.min(100, Math.max(6, Math.round((t / maxTotal) * 100)));
    const isOn = idx === stSelectedDayIdx;
    return `<div class="st-bar-col${isOn ? ' on' : ''}" data-idx="${idx}" title="${fmtDateTitle(d.dateObj)}: ${fmtDuration(t)}">
      <div class="st-bar-fill" style="height:${heightPct}%"></div>
    </div>`;
  }).join('');

  container.querySelectorAll<HTMLElement>('.st-bar-col').forEach((col) => {
    col.addEventListener('click', () => {
      stSelectedDayIdx = parseInt(col.dataset.idx || '29', 10);
      container.querySelectorAll('.st-bar-col').forEach((c, i) => c.classList.toggle('on', i === stSelectedDayIdx));
      renderSelectedDayView();
    });
  });
}

async function ensureSessionCache(force = false): Promise<SessionDayItem[]> {
  if (!force && stSessionCache && Date.now() - stSessionFetchedAt < 60_000) {
    return stSessionCache;
  }
  if (stSessionInFlight) return stSessionInFlight;
  stSessionInFlight = (async () => {
    try {
      const res = await invoke<RawSessionDay[]>('get_pc_session_history');
      const rawSessions = Array.isArray(res) ? res : [];
      const sessMap: Record<string, RawSessionDay> = {};
      for (const d of rawSessions) {
        if (d && d.date) sessMap[d.date] = d;
      }
      stSessionCache = buildLast30DateGrid().map(({ date, dateObj }) => {
        const rec = sessMap[date];
        return { date, dateObj, total: rec?.total_secs || 0, sessions: rec?.sessions || [] };
      });
      stSessionFetchedAt = Date.now();
    } catch (err) {
      console.error('Failed loading PC session history:', err);
      if (!stSessionCache) {
        stSessionCache = buildLast30DateGrid().map(({ date, dateObj }) => ({ date, dateObj, total: 0, sessions: [] }));
      }
    } finally {
      stSessionInFlight = null;
    }
    return stSessionCache!;
  })();
  return stSessionInFlight;
}

function bindModeToggle(): void {
  const btns = document.querySelectorAll<HTMLElement>('.st-mode-btn[data-st-mode]');
  if (!btns.length) return;
  btns.forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.stMode === stViewMode);
    btn.addEventListener('click', async () => {
      const nextMode = (btn.dataset.stMode as 'apps' | 'sessions') || 'apps';
      if (nextMode === stViewMode) return;
      stViewMode = nextMode;
      btns.forEach((b) => b.classList.toggle('on', b.dataset.stMode === stViewMode));

      if (stViewMode === 'sessions' && (!stSessionCache || Date.now() - stSessionFetchedAt >= 60_000)) {
        const listEl = document.getElementById('st-app-list');
        if (listEl) listEl.innerHTML = `<div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">Reading event log...</div></div>`;
        await ensureSessionCache();
      }

      renderBarsForActiveMode();
      renderSelectedDayView();
    });
  });
}

export async function renderScreenTimeData(): Promise<void> {
  const container = document.getElementById('st-bars-container');
  if (!container) return;

  stViewMode = 'apps';

  try {
    const rawHistory = (await invoke<RawHistoryDay[]>('get_screen_time_history')) || [];
    const histMap: Record<string, RawHistoryDay> = {};
    for (const d of rawHistory) {
      if (d && d.date) histMap[d.date] = d;
    }

    stHistoryCache = buildLast30DateGrid().map(({ date, dateObj }) => {
      const rec = histMap[date] || { date, total: 0, apps: [] };
      return { date, dateObj, total: rec.total || 0, apps: rec.apps || [] };
    });
    stSelectedDayIdx = 29;

    bindModeToggle();
    renderBarsForActiveMode();
    renderSelectedDayView();
    setupHistoryClear();

    // Warm PC session cache quietly in the background so switching to Screen Time is instant.
    void ensureSessionCache();
  } catch (err) {
    console.error('Error loading screen time data:', err);
  }
}

async function renderSelectedDayView(): Promise<void> {
  if (stViewMode === 'sessions') {
    renderSelectedDaySessions();
    return;
  }

  const day = stHistoryCache[stSelectedDayIdx];
  if (!day) return;

  const dayHdr = document.getElementById('st-day-header');
  const totLbl = document.getElementById('st-total-label');
  const totVal = document.getElementById('st-total-val');
  const listEl = document.getElementById('st-app-list');
  if (dayHdr) dayHdr.textContent = fmtDateTitle(day.dateObj);
  if (totLbl) totLbl.textContent = 'Total';
  if (totVal) totVal.textContent = fmtDuration(day.total);
  if (!listEl) return;

  if (!day.apps || day.apps.length === 0) {
    listEl.innerHTML = `<div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">No apps recorded</div></div>`;
    return;
  }

  const maxAppSecs = Math.max(1, ...day.apps.map((a) => a.secs));

  listEl.innerHTML = day.apps.map((app) => {
    const widthPct = Math.min(100, Math.max(4, Math.round((app.secs / maxAppSecs) * 100)));
    const cachedIcon = stIconCache[app.exe];
    const iconHtml = cachedIcon
      ? `<img src="${esc(cachedIcon)}" class="st-app-ico" alt="" />`
      : `<span class="st-app-badge" style="background:${getBadgeColor(app.name)}">${esc((app.name || 'O')[0].toUpperCase())}</span>`;
    return `<div class="st-app-row" data-exe="${esc(app.exe)}">
      <div class="st-app-icon-box">${iconHtml}</div>
      <div class="st-app-name" title="${esc(app.name)}">${esc(app.name)}</div>
      <div class="st-app-bar-wrap">
        <div class="st-app-bar-fill" style="width:${widthPct}%"></div>
      </div>
      <div class="st-app-dur">${fmtDuration(app.secs)}</div>
    </div>`;
  }).join('');

  const neededExes = day.apps.map((a) => a.exe).filter((e) => !stIconCache[e]);
  if (neededExes.length > 0) {
    try {
      const newIcons = await invoke<Record<string, string>>('get_app_icons', { exes: neededExes });
      if (newIcons && typeof newIcons === 'object') {
        Object.assign(stIconCache, newIcons);
        listEl.querySelectorAll<HTMLElement>('.st-app-row').forEach((row) => {
          const exe = row.dataset.exe || '';
          const url = stIconCache[exe];
          if (url) {
            const box = row.querySelector('.st-app-icon-box');
            if (box) box.innerHTML = `<img src="${esc(url)}" class="st-app-ico" alt="" />`;
          }
        });
      }
    } catch { /* ignore */ }
  }
}

function renderSelectedDaySessions(): void {
  const day = stSessionCache?.[stSelectedDayIdx];
  if (!day) return;

  const dayHdr = document.getElementById('st-day-header');
  const totLbl = document.getElementById('st-total-label');
  const totVal = document.getElementById('st-total-val');
  const listEl = document.getElementById('st-app-list');
  if (dayHdr) dayHdr.textContent = fmtDateTitle(day.dateObj);
  if (totLbl) totLbl.textContent = 'PC Screen Time';
  if (totVal) totVal.textContent = fmtDuration(day.total);
  if (!listEl) return;

  if (!day.sessions || day.sessions.length === 0) {
    listEl.innerHTML = `<div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">No PC sessions logged</div></div>`;
    return;
  }

  listEl.innerHTML = day.sessions.map((s) => {
    const stLower = String(s.status || '').toLowerCase();
    const dotCls = stLower === 'active' ? ' active' : stLower === 'unexpected' ? ' unexpected' : stLower === 'sleep' ? ' sleep' : '';
    const tagText = s.status === 'Active' ? 'Active now' : s.status === 'Clean' ? 'Off' : esc(s.status);
    return `<div class="st-app-row">
      <span class="st-sess-dot${dotCls}"></span>
      <div class="st-sess-range">${esc(s.start_label)} – ${esc(s.end_label)}</div>
      <span class="st-sess-tag${dotCls}">${tagText}</span>
      <div class="st-app-dur">${fmtDuration(s.duration_secs)}</div>
    </div>`;
  }).join('');
}

function setupHistoryClear(): void {
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
      stSessionCache = null;
      await renderScreenTimeData();
    });
  });
}
