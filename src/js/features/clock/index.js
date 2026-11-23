// Clock Feature
// Live Clock + Media Progress Tick and date sync across notch, classic, deck, and calendar
import { $ } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { listenTauri } from '../../core/tauri.js';
import { loadSettings } from '../../core/settings.js';
import { formatCompactCenterHtml, syncCompactCycleTimer } from '../menu/index.js';

let _lastCenterRender = '';
let _clockTimeout = null;

export function formatTime(now = new Date(), hour24 = false) {
  let hrs = now.getHours();
  const mins = String(now.getMinutes()).padStart(2, '0');
  if (hour24) {
    return `${String(hrs).padStart(2, '0')}:${mins}`;
  }
  const ampm = hrs >= 12 ? 'pm' : 'am';
  hrs = hrs % 12 || 12;
  return `${String(hrs).padStart(2, '0')}:${mins} ${ampm}`;
}

export function updateClocks() {
  const SET = loadSettings();
  const now = new Date();
  const str = formatTime(now, SET.general?.hour24);

  if (!appState.timerRunning && !appState.transferring && !appState.prompting && !appState.lockerPrompting) {
    const cClock = $('c-clock');
    if (cClock) {
      if (cClock.classList.contains('c-clock-timer') || cClock.querySelector('.tg-glass') || cClock.querySelector('.tg-time')) {
        cClock.classList.remove('c-clock-timer');
        cClock.innerHTML = '';
        _lastCenterRender = '';
      }
      const res = formatCompactCenterHtml(str);
      const sig = `${res.html ? 'H' : 'T'}:${res.val}`;
      if (sig !== _lastCenterRender || !cClock.textContent) {
        _lastCenterRender = sig;
        if (res.html) cClock.innerHTML = res.val;
        else cClock.textContent = res.val;
      }
    }
  }

  const ctrlClock = $('ctrl-clock-tab');
  if (ctrlClock && ctrlClock.textContent !== str) ctrlClock.textContent = str;

  const deckClock = $('deck-clock');
  if (deckClock && deckClock.textContent !== str) deckClock.textContent = str;

  const deckDate = $('deck-date');
  if (deckDate) {
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (deckDate.textContent !== dateStr) deckDate.textContent = dateStr;
  }

  const calClock = $('cal-top-clock');
  if (calClock && calClock.textContent !== str) calClock.textContent = str;

  const timerClock = $('timer-top-clock');
  if (timerClock && timerClock.textContent !== str) timerClock.textContent = str;

  bus.emit('clock:tick', { now, timeStr: str });
}

function tickClock() {
  updateClocks();
  _clockTimeout = setTimeout(tickClock, 60000 - (Date.now() % 60000) + 20);
}

export function initClock() {
  if (!_clockTimeout) {
    tickClock();
  } else {
    updateClocks();
  }

  listenTauri('system-resumed', () => {
    updateClocks();
  });

  bus.on('settings:change', () => {
    updateClocks();
    syncCompactCycleTimer();
  });
}
