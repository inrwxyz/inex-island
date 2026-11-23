// Focus Timer, Crystal Alarm, Calendar Grid, and Quick Notes Feature
import { $, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { invokeTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';
import { reportIslandSize, cancelCloseEase, goCompact, ISLAND_WIN_W } from '../../core/views.js';
import { hudIsFloating, hudCanShow, hudRestoreSize, showDeviceHud } from '../bluetooth/index.js';
import { updateClocks } from '../clock/index.js';
import { refreshMedia } from '../media/index.js';

let alarmChimeInterval = null;
let alarmAutoDismissTimeout = null;
let alarmStartT = null;
let alarmBackT = null;
let alarmCleanT = null;

export function playAlarmChime() {
  invokeTauri('play_alarm_sound').catch((err) => console.warn('Tauri invoke error:', err));
}

export function alarmClearOtherHuds() {
  island?.classList.remove('bt-hud-active', 'biometric-active', 'bio-hud', 'hud-pre', 'hud-back', 'hud-out');
  const btHud = $('c-bt-hud');
  if (btHud) btHud.classList.add('hidden');
  const bioBox = $('c-biometric-box');
  if (bioBox) bioBox.classList.add('hidden');
}

export function alarmLabel() {
  const secs = Math.round((appState.timerPresetMins || 0) * 60);
  if (secs >= 60 && secs % 60 === 0) return `Timer \u2022 ${secs / 60} min`;
  if (secs >= 60) return `Timer \u2022 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return `Timer \u2022 ${secs} sec`;
}

export function triggerTimerAlarm(opts) {
  opts = opts || {};
  if (appState.currentView !== 'view-compact') {
    goCompact();
  }

  const alarmBox = $('c-alarm-box');
  if (!alarmBox) return;

  clearInterval(alarmChimeInterval);
  clearTimeout(alarmAutoDismissTimeout);
  clearTimeout(alarmStartT);
  clearTimeout(alarmBackT);
  clearTimeout(alarmCleanT);
  appState.alarmClosing = false;

  const idle = !(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast || appState.mediaPlaying);

  alarmClearOtherHuds();
  appState.alarmActive = true;
  updateTimerChip();

  const sub = $('alarm-sub');
  if (sub) sub.textContent = opts.sub || alarmLabel();
  const ttl = $('alarm-title');
  if (ttl) ttl.textContent = opts.title || "Time's Up";
  const snz = $('btn-alarm-snooze');
  if (snz) {
    snz.classList.toggle('hidden', !opts.snooze);
    snz.textContent = opts.snoozeLabel || 'Snooze';
    snz.title = opts.snoozeTitle || 'Snooze 9 minutes';
  }
  const stopBtn = $('btn-alarm-dismiss');
  if (stopBtn) stopBtn.textContent = opts.dismissLabel || 'Stop';
  alarmBox.classList.toggle('pr-alert', opts.kind === 'prayer');
  alarmBox.classList.remove('pr-quiet');
  island?.classList.toggle('alarm-prayer', opts.kind === 'prayer');
  appState.alarmSnoozable = !!opts.snooze;
  appState.alarmOpts = opts;
  alarmBox.classList.remove('hidden');
  island?.classList.remove('alarm-active', 'hud-out');
  island?.classList.toggle('alarm-full', idle);

  cancelCloseEase();
  reportIslandSize({ width: ISLAND_WIN_W, height: hudIsFloating() ? 64 : 56 });
  island?.classList.add('hud-pre');
  alarmStartT = setTimeout(() => {
    island?.classList.remove('hud-pre');
    island?.classList.add('alarm-active');
  }, 110);

  const SET = loadSettings();
  if (!opts.silent && SET.notch?.timerSound !== false) {
    playAlarmChime();
    alarmChimeInterval = setInterval(() => {
      if (appState.alarmActive && !appState.alarmClosing) {
        playAlarmChime();
      } else {
        clearInterval(alarmChimeInterval);
      }
    }, 2400);
  }

  alarmAutoDismissTimeout = setTimeout(() => {
    dismissTimerAlarm();
  }, opts.ms || 14000);
}

export function dismissTimerAlarm() {
  clearInterval(alarmChimeInterval);
  clearTimeout(alarmAutoDismissTimeout);
  clearTimeout(alarmStartT);

  const alarmBox = $('c-alarm-box');
  if (!alarmBox || !appState.alarmActive || appState.alarmClosing) return;
  appState.alarmClosing = true;
  try {
    if (appState.alarmOpts?.onDismiss) appState.alarmOpts.onDismiss();
  } catch (err) {
    console.warn('Timer dismiss error:', err);
  }

  island?.classList.remove('hud-pre');
  island?.classList.add('alarm-active', 'hud-out');
  alarmBackT = setTimeout(() => {
    island?.classList.remove('alarm-active', 'alarm-full', 'hud-out', 'alarm-prayer');
    island?.classList.add('hud-back');
    alarmCleanT = setTimeout(() => {
      alarmBox.classList.add('hidden');
      const stopBtn = $('btn-alarm-dismiss');
      if (stopBtn) stopBtn.classList.remove('hidden');
      island?.classList.remove('hud-back');
      appState.alarmActive = false;
      appState.alarmClosing = false;
      hudRestoreSize();
      bus.emit('center:render');
      updateClocks();
      refreshMedia();
      updateTimerChip();
    }, 600);
  }, 170);
}

const TIMER_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2"/><path d="M9.5 2.5h5"/></svg>';
export function showTimerStartHud() {
  const secs = Math.round((appState.timerPresetMins || 0) * 60);
  const total = secs >= 60 && secs % 60 === 0 ? `${secs / 60} min` : secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs} sec`;
  showDeviceHud({ iconHTML: TIMER_HUD_SVG, plain: true, accent: 'amber', name: 'Timer', tag: `Started \u2022 ${total}`, ms: 2000 });
}

export function announceTimerStart() {
  if (appState.currentView === 'view-compact' && hudCanShow()) showTimerStartHud();
  appState.timerStartPending = false;
}

export function updateTimerChip() {
  const busy = !!(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast);
  const on = !!appState.timerRunning && busy && !appState.alarmActive && appState.currentView === 'view-compact';
  island?.classList.toggle('timer-chip-on', on);
  island?.classList.toggle('timer-live', !!appState.timerRunning && !busy && !appState.alarmActive);
  if (on) {
    const t = $('c-timer-chip-text');
    if (t) {
      const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
      const sec = String(appState.timerSeconds % 60).padStart(2, '0');
      t.textContent = `${m}:${sec}`;
    }
  }
}

export function timerGlassSvg() {
  return '<svg class="tg-svg" viewBox="0 0 20 28" aria-hidden="true"><g class="tg-rot">'
    + '<path class="tg-sandtop" d="M6.2 4.5h7.6l-3.2 6.5c-.3.5-.9.5-1.2 0z"/>'
    + '<path class="tg-sandbot" d="M6.2 23.5h7.6l-3.2-6.5c-.3-.5-.9-.5-1.2 0z"/>'
    + '<line class="tg-stream" x1="10" y1="13.5" x2="10" y2="21"/>'
    + '<path class="tg-frame" d="M4 3.5h12 M4 24.5h12 M5 4v1.5l4.5 8.5-4.5 8.5V24 M15 4v1.5l-4.5 8.5 4.5 8.5V24"/>'
    + '</g></svg>';
}

export function timerSetGlass(frac) {
  const f = Math.min(1, Math.max(0.001, frac)).toFixed(4);
  const g = Math.min(1, Math.max(0.001, 1 - frac)).toFixed(4);
  document.querySelectorAll('.tg-svg').forEach((sv) => {
    sv.style.setProperty('--f', f);
    sv.style.setProperty('--g', g);
  });
}

export function timerFmtTotal(secs) {
  return secs % 60 === 0 ? `${secs / 60}m` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

export function timerEndsText() {
  const d = new Date(Date.now() + appState.timerSeconds * 1000);
  let h = d.getHours();
  const mi = String(d.getMinutes()).padStart(2, '0');
  const SET = loadSettings();
  if (SET.general?.hour24) return `${String(h).padStart(2, '0')}:${mi}`;
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${mi} ${ap}`;
}

export function timerLiveRefresh(frac, m, s, totalSecs) {
  timerSetGlass(frac);
  const live = $('view-timer-live');
  if (!live) return;
  const t = `${m}:${s}`;
  const set = (id, v) => {
    const el = $(id);
    if (el && el.textContent !== v) el.textContent = v;
  };
  set('tl-time', t);
  set('tl-top-time', t);
  const tot = timerFmtTotal(totalSecs);
  set('tl-sub', appState.timerRunning ? `Focus ${tot} \u00b7 Ends at ${timerEndsText()}` : `Focus ${tot} \u00b7 Paused`);
  set('tl-toggle', appState.timerRunning ? 'Pause' : (appState.timerSeconds >= totalSecs ? 'Start' : 'Resume'));
  live.classList.toggle('tl-run', !!appState.timerRunning);
}

export function syncTimerTiles() {
  const on = !!appState.timerRunning;
  $('act-timer')?.classList.toggle('active', on);
  document.querySelectorAll('#deck-quick-row [data-action="timer"]').forEach((b) => {
    b.classList.toggle('active', on);
  });
}

const TIMER_RING_C = 223.1;
export function formatTimerDisplay() {
  const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
  const s = String(appState.timerSeconds % 60).padStart(2, '0');
  const disp = $('timer-display');
  if (disp && !disp.querySelector('input')) {
    disp.textContent = `${m}:${s}`;
  }
  const totalSecs = Math.max(1, Math.round((appState.timerPresetMins || 0) * 60) + (appState.timerExtra || 0));
  const frac = Math.min(1, Math.max(0, appState.timerSeconds / totalSecs));
  const ringFg = $('timer-ring-fg');
  if (ringFg) ringFg.style.strokeDashoffset = String((TIMER_RING_C * (1 - frac)).toFixed(1));

  const cClock = $('c-clock');
  if (appState.timerRunning && !appState.transferring && !appState.prompting && !appState.lockerPrompting) {
    if (cClock) {
      // Build the glass once and only touch the digits afterwards: replacing the markup every second
      // would recreate the SVG and restart its animation on every tick.
      let timeEl = cClock.querySelector('.tg-time');
      if (!timeEl || !cClock.querySelector('.tg-glass')) {
        cClock.innerHTML = `<span class="tg-glass">${timerGlassSvg()}</span><span class="tg-time"></span>`;
        timeEl = cClock.querySelector('.tg-time');
      }
      const txt = `${m}:${s}`;
      if (timeEl.textContent !== txt) timeEl.textContent = txt;
      cClock.classList.add('c-clock-timer');
    }
  } else {
    island?.classList.remove('timer-live');
    if (cClock) {
      cClock.classList.remove('c-clock-timer');
      if (cClock.querySelector('.tg-glass') || cClock.querySelector('.tg-time')) {
        cClock.innerHTML = '';
      }
    }
  }
  syncTimerTiles();
  timerLiveRefresh(frac, m, s, totalSecs);
  updateTimerChip();
}

export function suspendFocusTimer() {
  if (!appState.timerRunning) return;
  clearInterval(appState.timerInterval);
  appState.timerInterval = null;
  appState.timerRunning = false;
  appState.timerStartPending = false;
  const tgl = $('btn-timer-toggle');
  if (tgl) tgl.textContent = '▶ Start';
  $('act-timer')?.classList.remove('active');
  const cClock = $('c-clock');
  if (cClock) cClock.classList.remove('c-clock-timer');
  formatTimerDisplay();
  updateClocks();
  updateTimerChip();
}

export function parseTimerInput(v) {
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/))) return +m[1] * 60 + Math.min(59, +m[2]);
  if ((m = s.match(/^(\d{1,5})\s*s(ec)?$/))) return +m[1];
  if ((m = s.match(/^(\d{1,3})\s*m?(in)?$/))) return +m[1] * 60;
  return null;
}

export function applyCustomTimer(secs) {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  const tgl = $('btn-timer-toggle');
  if (tgl) tgl.textContent = '▶ Start';
  $('act-timer')?.classList.remove('active');
  appState.timerExtra = 0;
  appState.timerSeconds = secs;
  appState.timerPresetMins = secs / 60;
  document.querySelectorAll('.timer-presets button').forEach((b) => b.classList.remove('active'));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const focusLbl = $('focus-title-label');
  if (focusLbl) focusLbl.textContent = ss ? `FOCUS ${mm}:${String(ss).padStart(2, '0')}` : `FOCUS ${mm}M`;
  formatTimerDisplay();
  updateClocks();
}

export function startTimerWithSecs(secs) {
  if (!secs || secs <= 0) return;
  applyCustomTimer(secs);
  const tgl = $('btn-timer-toggle');
  if (tgl && !appState.timerRunning) {
    tgl.click();
  }
}

export function editTimer() {
  const disp = $('timer-display');
  if (!disp || disp.querySelector('input') || appState.timerRunning) return;
  appState.keepOpen = true;
  invokeTauri('focus_island');
  const inp = document.createElement('input');
  inp.className = 'timer-edit';
  inp.type = 'text';
  inp.maxLength = 6;
  inp.placeholder = 'min';
  inp.autocomplete = 'off';
  disp.textContent = '';
  disp.append(inp);
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    appState.keepOpen = false;
    const secs = apply ? parseTimerInput(inp.value) : null;
    inp.remove();
    if (secs && secs > 0 && secs <= 999 * 60) applyCustomTimer(secs);
    else formatTimerDisplay();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  setTimeout(() => inp.focus(), 80);
}

// ==================== CALENDAR ====================
let calCurrent = new Date();
const CAL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function renderCalendarGrid(dir) {
  const container = $('cal-days-grid');
  const title = $('cal-month-title');
  if (!container || !title) return;

  const year = calCurrent.getFullYear();
  const month = calCurrent.getMonth();
  title.innerHTML = `${CAL_MONTHS[month]}<span class="yr">${year}</span>`;

  const today = new Date();
  const isThisMonth = today.getFullYear() === year && today.getMonth() === month;
  const firstDayIndex = new Date(year, month, 1).getDay();

  const frag = document.createDocumentFragment();
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - firstDayIndex + i);
    const cell = document.createElement('span');
    cell.className = 'cal-day';
    if (d.getMonth() !== month) cell.classList.add('muted');
    else if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add('weekend');
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
      cell.classList.add('today');
    }
    cell.textContent = d.getDate();
    frag.appendChild(cell);
  }
  container.replaceChildren(frag);

  if (dir) {
    container.classList.remove('slide-next', 'slide-prev');
    void container.offsetWidth;
    container.classList.add(dir === 'prev' ? 'slide-prev' : 'slide-next');
  }
  const todayBtn = $('btn-cal-today');
  if (todayBtn) todayBtn.classList.toggle('ghost', isThisMonth);

  if (appState.currentView === 'view-calendar') {
    reportIslandSize({ width: ISLAND_WIN_W, height: 268 + (hudIsFloating() ? 12 : 0) });
  }
}

export function calShift(n) {
  calCurrent = new Date(calCurrent.getFullYear(), calCurrent.getMonth() + n, 1);
  renderCalendarGrid(n > 0 ? 'next' : 'prev');
}

// ==================== NOTEPAD ====================
export function updateNoteCount(len) {
  const noteCharCount = $('notepad-char-count');
  if (noteCharCount) noteCharCount.textContent = `${len} character${len === 1 ? '' : 's'}`;
}

export function focusNotepad() {
  const noteArea = $('notepad-textarea');
  if (noteArea) {
    appState.keepOpen = true;
    invokeTauri('focus_island');
    setTimeout(() => {
      noteArea.focus();
      appState.keepOpen = false;
    }, 80);
  }
}

export function initTimer() {
  $('btn-timer-toggle')?.addEventListener('click', function () {
    appState.timerRunning = !appState.timerRunning;
    this.textContent = appState.timerRunning ? '⏸ Pause' : '▶ Start';
    $('act-timer')?.classList.toggle('active', appState.timerRunning);

    if (appState.timerRunning) {
      if (appState.timerSeconds === appState.timerPresetMins * 60) announceTimerStart();
      formatTimerDisplay();
      appState.timerInterval = setInterval(() => {
        if (appState.timerSeconds > 0) {
          appState.timerSeconds--;
          formatTimerDisplay();
        } else {
          clearInterval(appState.timerInterval);
          appState.timerRunning = false;
          const tgl = $('btn-timer-toggle');
          if (tgl) tgl.textContent = '▶ Start';
          $('act-timer')?.classList.remove('active');
          appState.timerExtra = 0;
          appState.timerSeconds = appState.timerPresetMins * 60;
          formatTimerDisplay();
          updateClocks();
          triggerTimerAlarm();
        }
      }, 1000);
    } else {
      clearInterval(appState.timerInterval);
      island?.classList.remove('timer-live', 'timer-chip-on');
      const cClock = $('c-clock');
      if (cClock) {
        cClock.classList.remove('c-clock-timer');
        cClock.innerHTML = '';
      }
      syncTimerTiles();
      formatTimerDisplay();
      updateClocks();
      updateTimerChip();
    }
  });

  $('btn-timer-reset')?.addEventListener('click', () => {
    clearInterval(appState.timerInterval);
    appState.timerInterval = null;
    appState.timerRunning = false;
    appState.timerStartPending = false;
    appState.timerExtra = 0;
    appState.timerSeconds = appState.timerPresetMins * 60;
    island?.classList.remove('timer-live', 'timer-chip-on');
    const tgl = $('btn-timer-toggle');
    if (tgl) tgl.textContent = '▶ Start';
    $('act-timer')?.classList.remove('active');
    const cClock = $('c-clock');
    if (cClock) {
      cClock.classList.remove('c-clock-timer');
      cClock.innerHTML = '';
    }
    formatTimerDisplay();
    updateClocks();
    updateTimerChip();
  });

  $('timer-display')?.addEventListener('click', editTimer);
  $('btn-timer-custom')?.addEventListener('click', editTimer);

  document.querySelectorAll('.timer-presets button[data-min]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.timer-presets button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mins = parseInt(btn.dataset.min, 10);
      appState.timerPresetMins = mins;
      appState.timerExtra = 0;
      appState.timerSeconds = mins * 60;
      const lbl = $('focus-title-label');
      if (lbl) lbl.textContent = `FOCUS ${mins}M`;
      formatTimerDisplay();
    });
  });

  // Calendar
  $('btn-cal-prev')?.addEventListener('click', () => calShift(-1));
  $('btn-cal-next')?.addEventListener('click', () => calShift(1));
  $('btn-cal-today')?.addEventListener('click', () => {
    const now = new Date();
    const dir = (now.getFullYear() * 12 + now.getMonth()) < (calCurrent.getFullYear() * 12 + calCurrent.getMonth()) ? 'prev' : 'next';
    calCurrent = now;
    renderCalendarGrid(dir);
  });

  let calWheelAt = 0;
  document.querySelector('#view-calendar .cal-container')?.addEventListener('wheel', (e) => {
    e.preventDefault();
    const t = performance.now();
    if (t - calWheelAt < 200) return;
    calWheelAt = t;
    calShift(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  // Notepad
  const noteArea = $('notepad-textarea');
  if (noteArea) {
    const saved = localStorage.getItem('inex.island.notes') || '';
    noteArea.value = saved;
    updateNoteCount(saved.length);
    noteArea.addEventListener('input', (e) => {
      const val = e.target.value;
      try {
        localStorage.setItem('inex.island.notes', val);
      } catch (err) {
        console.warn('Storage operation failed in notepad:', err);
      }
      updateNoteCount(val.length);
    });
  }

  $('btn-notepad-clear')?.addEventListener('click', () => {
    if (noteArea) {
      noteArea.value = '';
      try {
        localStorage.setItem('inex.island.notes', '');
      } catch (err) {
        console.warn('Storage operation failed in notepad:', err);
      }
      updateNoteCount(0);
      bus.emit('toast:show', { kind: 'unlock', text: 'Notes cleared', ms: 1200 });
    }
  });

  $('btn-notepad-copy')?.addEventListener('click', async () => {
    if (!noteArea || !noteArea.value) {
      bus.emit('toast:show', { kind: 'snip', text: 'Note is empty', ms: 1200 });
      return;
    }
    try {
      await navigator.clipboard.writeText(noteArea.value);
      bus.emit('toast:show', { kind: 'snip', text: 'Copied to clipboard', ms: 1200 });
    } catch {
      bus.emit('toast:show', { kind: 'snip', text: 'Select all & Ctrl+C', ms: 1500 });
    }
  });

  // Timer live controls
  ['tl-glass', 'tl-mini-glass'].forEach((id) => {
    const el = $(id);
    if (el) el.innerHTML = timerGlassSvg();
  });
  $('tl-close')?.addEventListener('click', () => goCompact());
  $('tl-toggle')?.addEventListener('click', () => $('btn-timer-toggle')?.click());
  $('tl-add')?.addEventListener('click', () => {
    appState.timerSeconds += 300;
    appState.timerExtra = (appState.timerExtra || 0) + 300;
    formatTimerDisplay();
  });
  $('tl-reset')?.addEventListener('click', () => $('btn-timer-reset')?.click());
  $('tl-stop')?.addEventListener('click', () => {
    $('btn-timer-reset')?.click();
    goCompact();
  });

  $('c-clock')?.addEventListener('click', (e) => {
    if (appState.timerRunning && e.target.closest('#c-clock.c-clock-timer')) {
      e.stopPropagation();
      bus.emit('menu:open-control');
      bus.emit('deck:open-sub', { viewId: 'view-timer', title: 'Focus Timer', from: 'bottom' });
    }
  });
}
