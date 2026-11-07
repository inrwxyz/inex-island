
// ==================== 11. CLOCK ALARMS (quick tile "Alarm") ====================
// Alarms live in localStorage ("inex.alarms.v1"): [{ id, h, m, on, daily }]  (h = 0-23).
// A once-alarm switches itself off after it rang. Snooze rings again after 9 minutes.
const ALARM_KEY = 'inex.alarms.v1';
const ALARM_SNOOZE_MS = 9 * 60 * 1000;
let alarms = [];
try { const a = JSON.parse(localStorage.getItem(ALARM_KEY) || '[]'); if (Array.isArray(a)) alarms = a.filter((x) => x && Number.isFinite(x.h) && Number.isFinite(x.m)); } catch (_) {}
let alarmPick = { h: 7, m: 30, daily: false };
let alarmSnoozeAt = 0;          // ms timestamp, 0 = no snooze pending
let alarmLastFired = '';        // "<id>@<yyyy-mm-dd hh:mm>": never ring twice in one minute

function saveAlarms() { try { localStorage.setItem(ALARM_KEY, JSON.stringify(alarms)); } catch (_) {} }
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtAlarmTime(h, m) {
  if (SET.general && SET.general.hour24) return `${pad2(h)}:${pad2(m)}`;
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
function nextAlarmMs(a, from) {
  const d = new Date(from); d.setHours(a.h, a.m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function renderAlarmPicker() {
  const h24 = !!(SET.general && SET.general.hour24);
  const hh = h24 ? alarmPick.h : ((alarmPick.h + 11) % 12) + 1;
  document.getElementById('alarm-pick-h').textContent = pad2(hh);
  document.getElementById('alarm-pick-m').textContent = pad2(alarmPick.m);
  const ap = document.getElementById('alarm-pick-ampm');
  ap.classList.toggle('hidden', h24);
  ap.textContent = alarmPick.h >= 12 ? 'PM' : 'AM';
  document.getElementById('alarm-pick-daily').classList.toggle('on', alarmPick.daily);
}
function renderAlarmList() {
  const list = document.getElementById('alarm-list');
  if (!list) return;
  list.innerHTML = '';
  if (!alarms.length) {
    list.innerHTML = '<div class="empty-hint">No alarms yet. Pick a time and tap Add.</div>';
  }
  [...alarms].sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m)).forEach((a) => {
    const row = document.createElement('div');
    row.className = 'alarm-row' + (a.on ? '' : ' off');
    const t = document.createElement('div');
    t.className = 'alarm-row-time';
    t.textContent = fmtAlarmTime(a.h, a.m);
    const sub = document.createElement('small');
    sub.textContent = a.daily ? 'Every day' : 'Once';
    t.appendChild(sub);
    const sw = document.createElement('label');
    sw.className = 'ios-switch';
    sw.innerHTML = '<input type="checkbox"><span class="slider"></span>';
    const cb = sw.querySelector('input');
    cb.checked = !!a.on;
    cb.addEventListener('change', () => { a.on = cb.checked; saveAlarms(); renderAlarmList(); });
    const del = document.createElement('button');
    del.className = 'alarm-del';
    del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener('click', () => { alarms = alarms.filter((x) => x !== a); saveAlarms(); renderAlarmList(); });
    row.append(t, sw, del);
    list.appendChild(row);
  });
  const lbl = document.getElementById('alarm-next-label');
  if (lbl) {
    const now = Date.now();
    const next = alarms.filter((a) => a.on).map((a) => nextAlarmMs(a, now)).sort((a, b) => a - b)[0];
    if (next) {
      const mins = Math.max(1, Math.round((next - now) / 60000));
      lbl.textContent = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins}m`;
    } else lbl.textContent = '';
  }
}
function openAlarmView() { renderAlarmPicker(); renderAlarmList(); }

function alarmStep(kind) {
  if (kind === 'h+') alarmPick.h = (alarmPick.h + 1) % 24;
  else if (kind === 'h-') alarmPick.h = (alarmPick.h + 23) % 24;
  else if (kind === 'm+') alarmPick.m = (alarmPick.m + 1) % 60;
  else if (kind === 'm-') alarmPick.m = (alarmPick.m + 59) % 60;
  renderAlarmPicker();
}
document.querySelectorAll('#view-alarm .alarm-step').forEach((b) => {
  // tap = one step, hold = keeps stepping
  let rep = null, hold = null;
  const stop = () => { clearTimeout(hold); clearInterval(rep); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    alarmStep(b.dataset.step);
    hold = setTimeout(() => { rep = setInterval(() => alarmStep(b.dataset.step), 70); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
});
document.getElementById('alarm-pick-ampm')?.addEventListener('click', () => { alarmPick.h = (alarmPick.h + 12) % 24; renderAlarmPicker(); });
document.getElementById('alarm-pick-daily')?.addEventListener('click', () => { alarmPick.daily = !alarmPick.daily; renderAlarmPicker(); });
document.getElementById('alarm-add')?.addEventListener('click', () => {
  if (alarms.length >= 12) { showToast('done', 'Max 12 alarms', 1400); return; }
  const dup = alarms.find((a) => a.h === alarmPick.h && a.m === alarmPick.m && !!a.daily === alarmPick.daily);
  if (dup) dup.on = true;
  else alarms.push({ id: Date.now().toString(36), h: alarmPick.h, m: alarmPick.m, on: true, daily: alarmPick.daily });
  saveAlarms();
  renderAlarmList();
});

function ringClockAlarm(a, snoozed) {
  triggerTimerAlarm({
    title: snoozed ? 'Snoozed alarm' : 'Alarm',
    sub: a ? fmtAlarmTime(a.h, a.m) : 'Wake up',
    snooze: true,
    ms: 60000
  });
  appState.lastRungAlarm = a || null;
}
function snoozeClockAlarm() {
  alarmSnoozeAt = Date.now() + ALARM_SNOOZE_MS;
}
let alarmLastCheck = Date.now();
setInterval(() => {
  const now = new Date();
  const nowMs = now.getTime();
  const elapsed = nowMs - alarmLastCheck;
  alarmLastCheck = nowMs;

  if (alarmSnoozeAt && nowMs >= alarmSnoozeAt) {
    alarmSnoozeAt = 0;
    ringClockAlarm(appState.lastRungAlarm, true);
    return;
  }

  const justWokeUp = elapsed > 4000;
  const currentH = now.getHours();
  const currentM = now.getMinutes();
  const stamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${currentH}:${currentM}`;

  for (const a of alarms) {
    if (!a.on) continue;
    let shouldFire = false;
    let isMissed = false;

    if (a.h === currentH && a.m === currentM && now.getSeconds() <= 5) {
      shouldFire = true;
    } else if (justWokeUp) {
      const alarmTarget = new Date(now);
      alarmTarget.setHours(a.h, a.m, 0, 0);
      const targetMs = alarmTarget.getTime();
      if (targetMs >= (nowMs - elapsed) && targetMs <= nowMs && (nowMs - targetMs) < 2 * 3600 * 1000) {
        shouldFire = true;
        isMissed = true;
      }
    }

    if (shouldFire) {
      const key = `${a.id}@${stamp}`;
      if (alarmLastFired === key) continue;
      alarmLastFired = key;
      if (!a.daily) { a.on = false; saveAlarms(); if (appState.currentView === 'view-alarm') renderAlarmList(); }
      ringClockAlarm(a, false);
      if (isMissed) {
        const tagEl = document.getElementById('alarm-hud-tag');
        if (tagEl) tagEl.textContent = `Missed Alarm • ${fmtAlarmTime(a.h, a.m)}`;
      }
      break;
    }
  }
}, 1000);

// ==================== 12. CAPS LOCK / NUM LOCK INDICATOR ====================
// Rust (lock_keys) reads the toggle state; the island pops a small HUD when it changes.
// Settings: general.capsToast, general.numToast (System > Startup & Alerts).
const CAPS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 5 12h4v4h6v-4h4z"/><line x1="9" y1="20" x2="15" y2="20"/></svg>';
const NUM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 8v4M9 8l-1 1M14.5 8h1.5v8"/><path d="M8 16h2"/></svg>';
let lockKeysPrev = null;
async function pollLockKeys() {
  const g = SET.general || {};
  if (!g.capsToast && !g.numToast) { lockKeysPrev = null; return; }
  const r = await tryInvoke('lock_keys', {});
  if (!Array.isArray(r) || r.length < 2) return;
  const [caps, num] = r;
  if (lockKeysPrev) {
    if (g.capsToast && caps !== lockKeysPrev[0]) {
      showDeviceHud({ iconHTML: CAPS_SVG, plain: !caps, accent: caps ? 'blue' : '', name: 'Caps Lock', tag: caps ? 'On' : 'Off', ms: 1500 });
    } else if (g.numToast && num !== lockKeysPrev[1]) {
      showDeviceHud({ iconHTML: NUM_SVG, plain: !num, accent: num ? 'blue' : '', name: 'Num Lock', tag: num ? 'On' : 'Off', ms: 1500 });
    }
  }
  lockKeysPrev = [caps, num];
}
setInterval(pollLockKeys, 250);

// ==================== 13. DOWNLOAD PROGRESS / COMPLETE HUD ====================
// Rust (downloads_scan) lists unfinished browser downloads and freshly finished files in the Downloads folder.
// Browsers do not publish the total size, so: HUD when a download starts, a thin blue sweep on the pill while
// bytes keep arriving, and a "Download Complete" HUD (click = show in Explorer) when it is done.
// Setting: general.downloadHud
const DL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';
const DL_DONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline class="clip-tick" points="5 12.5 10 17.5 19 7"/></svg>';
const dlTrack = new Map();       // partial file name -> { size, changedAt, firstAt }
const dlSeenRecent = new Set();
let dlSeeded = false;
let dlOpenName = null;           // finished file the HUD would open on click

function dlSize(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
function dlClean(name) {
  const n = name.replace(/\.(crdownload|part|opdownload|download|partial)$/i, '');
  return /^unconfirmed \d+/i.test(n) ? 'New download' : n;
}
async function pollDownloads() {
  if (!(SET.general && SET.general.downloadHud)) {
    island.classList.remove('dl-active'); dlTrack.clear(); dlSeeded = false; return;
  }
  const r = await tryInvoke('downloads_scan', {});
  if (!r || !Array.isArray(r.partials)) return;
  const now = Date.now();
  const cur = new Set();
  let started = null;
  for (const f of r.partials) {
    cur.add(f.name);
    const t = dlTrack.get(f.name);
    if (!t) {
      dlTrack.set(f.name, { size: f.size, changedAt: now, firstAt: now });
      if (dlSeeded && f.age_secs <= 15 && !started) started = f;
    } else if (f.size !== t.size) { t.size = f.size; t.changedAt = now; }
  }
  // vanished partial = finished (or cancelled): finished only if a fresh file appeared
  let finished = null;
  for (const [name, t] of [...dlTrack]) {
    if (cur.has(name)) continue;
    dlTrack.delete(name);
    if (!dlSeeded || now - t.firstAt < 1000) continue;
    const base = dlClean(name).toLowerCase();
    const fresh = (r.recent || []).filter((f) => f.age_secs <= 20 && !dlSeenRecent.has(f.name));
    finished = fresh.find((f) => f.name.toLowerCase() === base) || fresh[0] || null;
  }
  (r.recent || []).forEach((f) => dlSeenRecent.add(f.name));
  if (dlSeenRecent.size > 400) dlSeenRecent.clear();
  dlSeeded = true;

  const active = [...dlTrack.values()].some((t) => now - t.changedAt < 4000);
  island.classList.toggle('dl-active', active && appState.currentView === 'view-compact');

  if (finished) {
    dlOpenName = finished.name;
    showDeviceHud({ iconHTML: DL_DONE_SVG, plain: true, accent: 'ok', name: finished.name, tag: `Download Complete • ${dlSize(finished.size)}`, ms: 4200 });
  } else if (started) {
    showDeviceHud({ iconHTML: DL_SVG, plain: true, accent: 'blue', name: dlClean(started.name), tag: `Downloading • ${dlSize(started.size)}`, ms: 2200 });
  }
}
setInterval(pollDownloads, 1000);
document.getElementById('c-bt-hud')?.addEventListener('click', (e) => {
  if (!dlOpenName || !island.classList.contains('bt-hud-active')) return;
  if (!document.getElementById('bt-hud-name') || document.getElementById('bt-hud-name').textContent !== dlOpenName) return;
  e.stopPropagation();
  invokeTauri('open_download', { name: dlOpenName });
});
