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

