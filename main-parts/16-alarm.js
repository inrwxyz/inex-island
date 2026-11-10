
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

function saveAlarms() {
  try { localStorage.setItem(ALARM_KEY, JSON.stringify(alarms)); } catch (_) {}
  scheduleNextAlarm();
}
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
  scheduleNextAlarm();
}

let alarmTimer = null;
function scheduleNextAlarm() {
  if (alarmTimer) {
    clearTimeout(alarmTimer);
    alarmTimer = null;
  }
  const now = Date.now();

  if (alarmSnoozeAt && alarmSnoozeAt > now) {
    const diff = Math.max(50, alarmSnoozeAt - now);
    alarmTimer = setTimeout(() => {
      alarmSnoozeAt = 0;
      ringClockAlarm(appState.lastRungAlarm, true);
      scheduleNextAlarm();
    }, diff);
    return;
  }

  const active = alarms.filter((a) => a.on);
  if (!active.length) return; // 0 active alarms = 0 timers, 0% CPU!

  const nowDate = new Date();
  let minDiff = Infinity;
  let target = null;
  for (const a of active) {
    const diff = nextAlarmMs(a, nowDate) - now;
    if (diff > 0 && diff < minDiff) {
      minDiff = diff;
      target = a;
    }
  }

  if (target && minDiff < Infinity) {
    alarmTimer = setTimeout(() => {
      const cur = new Date();
      const currentH = cur.getHours();
      const currentM = cur.getMinutes();
      const stamp = `${cur.getFullYear()}-${cur.getMonth()}-${cur.getDate()} ${currentH}:${currentM}`;
      const key = `${target.id}@${stamp}`;
      if (alarmLastFired !== key) {
        alarmLastFired = key;
        if (!target.daily) {
          target.on = false;
          saveAlarms();
          if (appState.currentView === 'view-alarm') renderAlarmList();
        }
        ringClockAlarm(target, false);
      }
      scheduleNextAlarm();
    }, minDiff);
  }
}
scheduleNextAlarm();

// Catch missed alarms if PC was sleeping/hibernating and wakes up
onTauriEvent('system-resumed', () => {
  const now = new Date();
  const currentH = now.getHours();
  const currentM = now.getMinutes();
  for (const a of alarms) {
    if (!a.on) continue;
    if (a.h === currentH && a.m === currentM) {
      ringClockAlarm(a, false);
      if (!a.daily) {
        a.on = false;
        saveAlarms();
        if (appState.currentView === 'view-alarm') renderAlarmList();
      }
    }
  }
  scheduleNextAlarm();
});
