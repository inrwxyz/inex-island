// Clock Alarm Feature: handles user-defined alarms, snoozing, and periodic scheduling
import { $ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';
import { ALARM_KEY, loadAlarms, subscribeAlarms } from '../../../shared.js';
import { triggerTimerAlarm } from '../timer/index.js';

const ALARM_SNOOZE_MS = 9 * 60 * 1000;
let alarms = loadAlarms();
let alarmPick = { h: 7, m: 30, daily: false };
let alarmSnoozeAt = 0;
let alarmLastFired = '';
let alarmTimer = null;

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function saveAlarms() {
  try {
    localStorage.setItem(ALARM_KEY, JSON.stringify(alarms));
  } catch (err) {
    console.warn('Storage operation failed in alarm:', err);
  }
  scheduleNextAlarm();
}

export function fmtAlarmTime(h, m) {
  const SET = loadSettings();
  if (SET.general?.hour24) return `${pad2(h)}:${pad2(m)}`;
  return `${((h + 11) % 12) + 1}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function nextAlarmMs(a, from) {
  const d = new Date(from);
  d.setHours(a.h, a.m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function renderAlarmPicker() {
  const SET = loadSettings();
  const h24 = !!(SET.general?.hour24);
  const hh = h24 ? alarmPick.h : ((alarmPick.h + 11) % 12) + 1;
  const pickH = $('alarm-pick-h');
  if (pickH) pickH.textContent = pad2(hh);
  const pickM = $('alarm-pick-m');
  if (pickM) pickM.textContent = pad2(alarmPick.m);
  const ap = $('alarm-pick-ampm');
  if (ap) {
    ap.classList.toggle('hidden', h24);
    ap.textContent = alarmPick.h >= 12 ? 'PM' : 'AM';
  }
  $('alarm-pick-daily')?.classList.toggle('on', alarmPick.daily);
}

export function renderAlarmList() {
  const list = $('alarm-list');
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
    cb.addEventListener('change', () => {
      a.on = cb.checked;
      saveAlarms();
      renderAlarmList();
    });
    const del = document.createElement('button');
    del.className = 'alarm-del';
    del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    del.addEventListener('click', () => {
      alarms = alarms.filter((x) => x !== a);
      saveAlarms();
      renderAlarmList();
    });
    row.append(t, sw, del);
    list.appendChild(row);
  });
  const lbl = $('alarm-next-label');
  if (lbl) {
    const now = Date.now();
    const next = alarms.filter((a) => a.on).map((a) => nextAlarmMs(a, now)).sort((a, b) => a - b)[0];
    if (next) {
      const mins = Math.max(1, Math.round((next - now) / 60000));
      lbl.textContent = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${mins}m`;
    } else {
      lbl.textContent = '';
    }
  }
}

export function openAlarmView() {
  renderAlarmPicker();
  renderAlarmList();
}

export function alarmStep(kind) {
  if (kind === 'h+') alarmPick.h = (alarmPick.h + 1) % 24;
  else if (kind === 'h-') alarmPick.h = (alarmPick.h + 23) % 24;
  else if (kind === 'm+') alarmPick.m = (alarmPick.m + 1) % 60;
  else if (kind === 'm-') alarmPick.m = (alarmPick.m + 59) % 60;
  renderAlarmPicker();
}

export function ringClockAlarm(a, snoozed) {
  triggerTimerAlarm({
    title: snoozed ? 'Snoozed alarm' : 'Alarm',
    sub: a ? fmtAlarmTime(a.h, a.m) : 'Wake up',
    snooze: true,
    ms: 60000
  });
  appState.lastRungAlarm = a || null;
}

export function snoozeClockAlarm() {
  alarmSnoozeAt = Date.now() + ALARM_SNOOZE_MS;
  scheduleNextAlarm();
}

export function scheduleNextAlarm() {
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
  if (!active.length) return;

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

export function initAlarm() {
  document.querySelectorAll('#view-alarm .alarm-step').forEach((b) => {
    let rep = null;
    let hold = null;
    const stop = () => {
      clearTimeout(hold);
      clearInterval(rep);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      alarmStep(b.dataset.step);
      hold = setTimeout(() => {
        rep = setInterval(() => alarmStep(b.dataset.step), 70);
      }, 380);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
  });

  $('alarm-pick-ampm')?.addEventListener('click', () => {
    alarmPick.h = (alarmPick.h + 12) % 24;
    renderAlarmPicker();
  });
  $('alarm-pick-daily')?.addEventListener('click', () => {
    alarmPick.daily = !alarmPick.daily;
    renderAlarmPicker();
  });
  $('alarm-add')?.addEventListener('click', () => {
    if (alarms.length >= 12) {
      bus.emit('toast:show', { kind: 'done', text: 'Max 12 alarms', ms: 1400 });
      return;
    }
    const dup = alarms.find((a) => a.h === alarmPick.h && a.m === alarmPick.m && !!a.daily === alarmPick.daily);
    if (dup) dup.on = true;
    else alarms.push({ id: Date.now().toString(36), h: alarmPick.h, m: alarmPick.m, on: true, daily: alarmPick.daily });
    saveAlarms();
    renderAlarmList();
  });

  scheduleNextAlarm();

  subscribeAlarms((list) => {
    alarms = list;
    scheduleNextAlarm();
    if (appState.currentView === 'view-alarm') renderAlarmList();
  });

  listenTauri('system-resumed', () => {
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
}
