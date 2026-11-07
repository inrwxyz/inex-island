// 10. Focus Timer + Apple Crystal Alarm
let alarmChimeInterval = null;
let alarmAutoDismissTimeout = null;

function playAlarmChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const chord = [
      { f: 523.25, d: 0.00, v: 0.28 }, // C5
      { f: 659.25, d: 0.08, v: 0.26 }, // E5
      { f: 783.99, d: 0.16, v: 0.24 }, // G5
      { f: 1046.50, d: 0.24, v: 0.22 } // C6
    ];
    chord.forEach((n) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, ctx.currentTime);
      const t0 = ctx.currentTime + n.d;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(n.v, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.75);
    });
  } catch (_) {}
}

let alarmStartT = null;
let alarmBackT = null;
let alarmCleanT = null;

// Closes any other island popup (device HUD, Face ID) at once: the timer-end card has priority.
function alarmClearOtherHuds() {
  clearTimeout(btHudTimer); clearTimeout(btHudStartT); clearTimeout(btHudBackT);
  clearTimeout(bioTimer); clearTimeout(bioAnimPhaseTimer); clearTimeout(bioStartTimer); clearTimeout(bioEndTimer);
  island.classList.remove('bt-hud-active', 'biometric-active', 'bio-hud', 'hud-pre', 'hud-back', 'hud-out');
  const btHud = document.getElementById('c-bt-hud');
  if (btHud) btHud.classList.add('hidden');
  const bioBox = document.getElementById('c-biometric-box');
  if (bioBox) bioBox.classList.add('hidden');
}

function alarmLabel() {
  const secs = Math.round((appState.timerPresetMins || 0) * 60);
  if (secs >= 60 && secs % 60 === 0) return `Timer \u2022 ${secs / 60} min`;
  if (secs >= 60) return `Timer \u2022 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return `Timer \u2022 ${secs} sec`;
}

// opts (clock alarm): { title, sub, snooze: true, ms }.  No opts = the focus-timer card.
function triggerTimerAlarm(opts) {
  opts = opts || {};
  if (appState.currentView !== 'view-compact') {
    goCompact();
  }

  const alarmBox = document.getElementById('c-alarm-box');
  if (!alarmBox) return;

  clearInterval(alarmChimeInterval);
  clearTimeout(alarmAutoDismissTimeout);
  clearTimeout(alarmStartT); clearTimeout(alarmBackT); clearTimeout(alarmCleanT);
  appState.alarmClosing = false;

  // nothing else running -> the full Mac-style show; with a transfer / media / popup running the card still comes on top
  const idle = !(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast || appState.mediaPlaying);

  alarmClearOtherHuds();
  appState.alarmActive = true;
  updateTimerChip();

  const sub = document.getElementById('alarm-sub');
  if (sub) sub.textContent = opts.sub || alarmLabel();
  const ttl = document.getElementById('alarm-title');
  if (ttl) ttl.textContent = opts.title || "Time's Up";
  const snz = document.getElementById('btn-alarm-snooze');
  if (snz) snz.classList.toggle('hidden', !opts.snooze);
  appState.alarmSnoozable = !!opts.snooze;
  appState.alarmOpts = opts;
  alarmBox.classList.remove('hidden');
  island.classList.remove('alarm-active', 'hud-out');
  island.classList.toggle('alarm-full', idle);

  // 1) window big enough, 2) old content blurs away, 3) island springs open
  tryInvoke('resize_island', { width: 256, height: 56 });  // same window as the device HUD
  island.classList.add('hud-pre');
  alarmStartT = setTimeout(() => {
    island.classList.remove('hud-pre');
    island.classList.add('alarm-active');
  }, 110);

  if (SET.notch && SET.notch.timerSound !== false) {
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

function dismissTimerAlarm() {
  clearInterval(alarmChimeInterval);
  clearTimeout(alarmAutoDismissTimeout);
  clearTimeout(alarmStartT);

  const alarmBox = document.getElementById('c-alarm-box');
  if (!alarmBox || !appState.alarmActive || appState.alarmClosing) return;
  appState.alarmClosing = true;

  // content fades, island shrinks back to the pill (no bounce), the old status comes back
  island.classList.remove('hud-pre');
  island.classList.add('alarm-active', 'hud-out');
  alarmBackT = setTimeout(() => {
    island.classList.remove('alarm-active', 'alarm-full', 'hud-out');
    island.classList.add('hud-back');
    alarmCleanT = setTimeout(() => {
      alarmBox.classList.add('hidden');
      island.classList.remove('hud-back');
      appState.alarmActive = false;
      appState.alarmClosing = false;
      hudRestoreWindow();
      renderCenter();
      updateClocks();
      refreshMedia();
    }, 560);
  }, 170);
}

// Timer started: the island pops open for a moment (Mac / iPhone style), then settles into icon + countdown.
const TIMER_HUD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2"/><path d="M9.5 2.5h5"/></svg>';
function showTimerStartHud() {
  const secs = Math.round((appState.timerPresetMins || 0) * 60);
  const total = secs >= 60 && secs % 60 === 0 ? `${secs / 60} min` : secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs} sec`;
  showDeviceHud({ iconHTML: TIMER_HUD_SVG, plain: true, accent: 'amber', name: 'Timer', tag: `Started \u2022 ${total}`, ms: 2000 });
}
function announceTimerStart() {
  if (hudCanShow()) showTimerStartHud();
  else appState.timerStartPending = true;   // timer menu is open: play it when the island goes back to the pill (see switchView)
}

// The running timer is shown as a small chip while a transfer / popup owns the middle of the pill
// (when nothing else is busy the timer simply replaces the clock, also while media plays).
function updateTimerChip() {
  const busy = !!(appState.transferring || appState.prompting || appState.lockerPrompting || appState.toast);
  const on = !!appState.timerRunning && busy && !appState.alarmActive && appState.currentView === 'view-compact';
  island.classList.toggle('timer-chip-on', on);
  island.classList.toggle('timer-live', !!appState.timerRunning && !busy && !appState.alarmActive);
  if (on) {
    const t = document.getElementById('c-timer-chip-text');
    if (t) {
      const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
      const sec = String(appState.timerSeconds % 60).padStart(2, '0');
      t.textContent = `${m}:${sec}`;
    }
  }
}

function formatTimerDisplay() {
  const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
  const s = String(appState.timerSeconds % 60).padStart(2, '0');
  const disp = document.getElementById('timer-display');
  if (disp && !disp.querySelector('input')) {
    disp.textContent = `${m} : ${s}`;
  }

  const cClock = document.getElementById('c-clock');
  if (appState.timerRunning && !appState.transferring && !appState.prompting && !appState.lockerPrompting) {
    if (cClock) {
      cClock.textContent = `${m}:${s}`;
      cClock.classList.add('c-clock-timer');
    }
  } else {
    if (cClock) cClock.classList.remove('c-clock-timer');
  }
  updateTimerChip();
}

document.getElementById('btn-timer-toggle').addEventListener('click', function () {
  appState.timerRunning = !appState.timerRunning;
  this.textContent = appState.timerRunning ? '⏸ Pause' : '▶ Start';
  document.getElementById('act-timer')?.classList.toggle('active', appState.timerRunning);

  if (appState.timerRunning) {
    if (appState.timerSeconds === appState.timerPresetMins * 60) announceTimerStart();   // fresh start only, not resume after pause
    formatTimerDisplay();
    appState.timerInterval = setInterval(() => {
      if (appState.timerSeconds > 0) {
        appState.timerSeconds--;
        formatTimerDisplay();
      } else {
        clearInterval(appState.timerInterval);
        appState.timerRunning = false;
        document.getElementById('btn-timer-toggle').textContent = '▶ Start';
        document.getElementById('act-timer')?.classList.remove('active');
        appState.timerSeconds = appState.timerPresetMins * 60;
        formatTimerDisplay();
        updateClocks();
        triggerTimerAlarm();
      }
    }, 1000);
  } else {
    clearInterval(appState.timerInterval);
    const cClock = document.getElementById('c-clock');
    if (cClock) cClock.classList.remove('c-clock-timer');
    updateClocks();
    updateTimerChip();
  }
});

document.getElementById('btn-timer-reset').addEventListener('click', () => {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  appState.timerSeconds = appState.timerPresetMins * 60;
  document.getElementById('btn-timer-toggle').textContent = '▶ Start';
  document.getElementById('act-timer')?.classList.remove('active');
  const cClock = document.getElementById('c-clock');
  if (cClock) cClock.classList.remove('c-clock-timer');
  formatTimerDisplay();
  updateClocks();
});

// Type your own time: "12" = 12 minutes, "1:30" = 1 min 30 s, "90s" = 90 seconds
function parseTimerInput(v) {
  v = String(v).trim().toLowerCase();
  let m;
  if ((m = v.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/))) return +m[1] * 60 + Math.min(59, +m[2]);
  if ((m = v.match(/^(\d{1,5})\s*s(ec)?$/))) return +m[1];
  if ((m = v.match(/^(\d{1,3})\s*m?(in)?$/))) return +m[1] * 60;
  return null;
}
function applyCustomTimer(secs) {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  document.getElementById('btn-timer-toggle').textContent = '▶ Start';
  document.getElementById('act-timer')?.classList.remove('active');
  appState.timerSeconds = secs;
  appState.timerPresetMins = secs / 60;
  document.querySelectorAll('.timer-presets button').forEach((b) => b.classList.remove('active'));
  const mm = Math.floor(secs / 60), ss = secs % 60;
  document.getElementById('focus-title-label').textContent = ss ? `FOCUS ${mm}:${String(ss).padStart(2, '0')}` : `FOCUS ${mm}M`;
  formatTimerDisplay();
  updateClocks();
}
function editTimer() {
  const disp = document.getElementById('timer-display');
  if (disp.querySelector('input') || appState.timerRunning) return;
  appState.keepOpen = true;                 // do not collapse while typing
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
document.getElementById('timer-display').addEventListener('click', editTimer);
document.getElementById('btn-timer-custom').addEventListener('click', editTimer);

document.querySelectorAll('.timer-presets button[data-min]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.timer-presets button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mins = parseInt(btn.dataset.min, 10);
    appState.timerPresetMins = mins;
    appState.timerSeconds = mins * 60;
    document.getElementById('focus-title-label').textContent = `FOCUS ${mins}M`;
    formatTimerDisplay();
  });
});

// ==================== 10b. CALENDAR GRID ====================
let calCurrent = new Date();
const CAL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function renderCalendarGrid(dir) {
  const container = document.getElementById('cal-days-grid');
  const title = document.getElementById('cal-month-title');
  if (!container || !title) return;

  const year = calCurrent.getFullYear();
  const month = calCurrent.getMonth();
  title.innerHTML = `${CAL_MONTHS[month]}<span class="yr">${year}</span>`;

  const today = new Date();
  const isThisMonth = today.getFullYear() === year && today.getMonth() === month;
  const firstDayIndex = new Date(year, month, 1).getDay();

  // always 6 week rows (42 cells), so the menu never changes height between months
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
  const todayBtn = document.getElementById('btn-cal-today');
  if (todayBtn) todayBtn.classList.toggle('ghost', isThisMonth);

  // 6 rows need a bit more room than the other sub menus
  if (appState.currentView === 'view-calendar') {
    invokeTauri('resize_island', { width: 316, height: 268 + (hudIsFloating() ? 12 : 0) });
  }
}

function calShift(n) {
  calCurrent = new Date(calCurrent.getFullYear(), calCurrent.getMonth() + n, 1);   // day 1: Jan 31 + 1 month must not jump to March
  renderCalendarGrid(n > 0 ? 'next' : 'prev');
}

document.getElementById('btn-cal-prev')?.addEventListener('click', () => calShift(-1));
document.getElementById('btn-cal-next')?.addEventListener('click', () => calShift(1));
document.getElementById('btn-cal-today')?.addEventListener('click', () => {
  const now = new Date();
  const dir = (now.getFullYear() * 12 + now.getMonth()) < (calCurrent.getFullYear() * 12 + calCurrent.getMonth()) ? 'prev' : 'next';
  calCurrent = now;
  renderCalendarGrid(dir);
});
// mouse wheel flips months
let calWheelAt = 0;
document.querySelector('#view-calendar .cal-container')?.addEventListener('wheel', (e) => {
  e.preventDefault();
  const t = performance.now();
  if (t - calWheelAt < 200) return;
  calWheelAt = t;
  calShift(e.deltaY > 0 ? 1 : -1);
}, { passive: false });

// ==================== 10c. QUICK NOTES (BUILT-IN SCRATCHPAD) ====================
const noteArea = document.getElementById('notepad-textarea');
const noteCharCount = document.getElementById('notepad-char-count');

function updateNoteCount(len) {
  if (noteCharCount) noteCharCount.textContent = `${len} character${len === 1 ? '' : 's'}`;
}

if (noteArea) {
  const saved = localStorage.getItem('inex.island.notes') || '';
  noteArea.value = saved;
  updateNoteCount(saved.length);

  noteArea.addEventListener('input', (e) => {
    const val = e.target.value;
    try { localStorage.setItem('inex.island.notes', val); } catch (_) {}
    updateNoteCount(val.length);
  });
}

function focusNotepad() {
  if (noteArea) {
    appState.keepOpen = true;
    invokeTauri('focus_island');
    setTimeout(() => { noteArea.focus(); appState.keepOpen = false; }, 80);
  }
}

document.getElementById('btn-notepad-clear')?.addEventListener('click', () => {
  if (noteArea) {
    noteArea.value = '';
    try { localStorage.setItem('inex.island.notes', ''); } catch (_) {}
    updateNoteCount(0);
    showToast('unlock', 'Notes cleared', 1200);
  }
});

document.getElementById('btn-notepad-copy')?.addEventListener('click', async () => {
  if (!noteArea || !noteArea.value) {
    showToast('snip', 'Note is empty', 1200);
    return;
  }
  try {
    await navigator.clipboard.writeText(noteArea.value);
    showToast('snip', 'Copied to clipboard', 1200);
  } catch (_) {
    showToast('snip', 'Select all & Ctrl+C', 1500);
  }
});

