// 10. Focus Timer + Reset Button
function formatTimerDisplay() {
  const m = String(Math.floor(appState.timerSeconds / 60)).padStart(2, '0');
  const s = String(appState.timerSeconds % 60).padStart(2, '0');
  document.getElementById('timer-display').textContent = `${m} : ${s}`;
  if (appState.timerRunning && !appState.transferring) {
    document.getElementById('c-clock').textContent = `${m}:${s}`;
  }
}

document.getElementById('btn-timer-toggle').addEventListener('click', function () {
  appState.timerRunning = !appState.timerRunning;
  this.textContent = appState.timerRunning ? '⏸ Pause' : '▶ Start';
  document.getElementById('act-timer').classList.toggle('active', appState.timerRunning);

  if (appState.timerRunning) {
    appState.timerInterval = setInterval(() => {
      if (appState.timerSeconds > 0) {
        appState.timerSeconds--;
        formatTimerDisplay();
      } else {
        clearInterval(appState.timerInterval);
        appState.timerRunning = false;
        document.getElementById('btn-timer-toggle').textContent = '▶ Start';
        document.getElementById('act-timer').classList.remove('active');
        if (SET.notch.timerSound) chime();
        setTimeout(updateClocks, 2000);
      }
    }, 1000);
  } else {
    clearInterval(appState.timerInterval);
    updateClocks();
  }
});

document.getElementById('btn-timer-reset').addEventListener('click', () => {
  clearInterval(appState.timerInterval);
  appState.timerRunning = false;
  appState.timerSeconds = appState.timerPresetMins * 60;
  document.getElementById('btn-timer-toggle').textContent = '▶ Start';
  document.getElementById('act-timer').classList.remove('active');
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
  document.getElementById('act-timer').classList.remove('active');
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

function renderCalendarGrid() {
  const container = document.getElementById('cal-days-grid');
  const title = document.getElementById('cal-month-title');
  if (!container || !title) return;

  const year = calCurrent.getFullYear();
  const month = calCurrent.getMonth();

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  title.textContent = `${monthNames[month]} ${year}`;

  const firstDayIndex = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const today = new Date();
  const isThisMonth = today.getFullYear() === year && today.getMonth() === month;
  const todayDate = today.getDate();

  container.innerHTML = '';

  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const d = document.createElement('span');
    d.className = 'cal-day muted';
    d.textContent = daysInPrevMonth - i;
    container.appendChild(d);
  }

  for (let i = 1; i <= daysInMonth; i++) {
    const d = document.createElement('span');
    d.className = 'cal-day';
    if (isThisMonth && i === todayDate) {
      d.classList.add('today');
    }
    d.textContent = i;
    container.appendChild(d);
  }

  const totalCells = firstDayIndex + daysInMonth;
  const nextDays = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= nextDays; i++) {
    const d = document.createElement('span');
    d.className = 'cal-day muted';
    d.textContent = i;
    container.appendChild(d);
  }
}

document.getElementById('btn-cal-prev')?.addEventListener('click', () => {
  calCurrent.setMonth(calCurrent.getMonth() - 1);
  renderCalendarGrid();
});
document.getElementById('btn-cal-next')?.addEventListener('click', () => {
  calCurrent.setMonth(calCurrent.getMonth() + 1);
  renderCalendarGrid();
});
document.getElementById('btn-cal-today')?.addEventListener('click', () => {
  calCurrent = new Date();
  renderCalendarGrid();
});

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

