import { MAX_ALARMS, loadAlarms, storeAlarms } from '../../shared.js';
import { esc } from './state.js';
import { btn } from './ui.js';

const AP = { h: 7, m: 30, daily: false };

function fmtAlarm(h: number, m: number): string {
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function alarmBoxHtml(): string {
  const list = loadAlarms();
  const h12 = AP.h % 12 || 12;
  const rows = list.length
    ? list.map((a) => `<div class="rw"><div class="t">${fmtAlarm(a.h, a.m)} · ${a.daily ? 'Daily' : 'Once'}</div>
        <div class="sw${a.on ? ' on' : ''}" data-al="toggle" data-id="${esc(a.id)}"></div>
        <div class="xb" data-al="del" data-id="${esc(a.id)}" title="Delete"><i class="ti ti-x" aria-hidden="true"></i></div></div>`).join('')
    : `<div class="rw"><div class="t" style="color:var(--faint)">No alarms yet</div></div>`;
  return `<div class="gp">${rows}</div>
    <div class="gp"><div class="rw"><div class="t">New alarm</div>
      <div class="st"><b data-al="h-">−</b><span style="min-width:30px">${String(h12).padStart(2, '0')}</span><b data-al="h+">+</b></div>
      <div class="st"><b data-al="m-">−</b><span style="min-width:30px">${String(AP.m).padStart(2, '0')}</span><b data-al="m+">+</b></div>
      <div class="seg"><b class="${AP.h < 12 ? 'on' : ''}" data-al="am">AM</b><b class="${AP.h >= 12 ? 'on' : ''}" data-al="pm">PM</b></div>
    </div>
    <div class="rw"><div class="t">Repeat daily</div><div class="sw${AP.daily ? ' on' : ''}" data-al="daily"></div>${btn('', 'Add alarm', 'data-al="add"')}</div></div>`;
}

export function renderAlarmBox(): void {
  const el = document.getElementById('alarm-box');
  if (el) el.innerHTML = alarmBoxHtml();
}

export function alarmAction(act: string | undefined, id?: string): void {
  let list = loadAlarms();
  if (act === 'toggle') list = list.map((a) => (a.id === id ? { ...a, on: !a.on } : a));
  else if (act === 'del') list = list.filter((a) => a.id !== id);
  else if (act === 'h+' || act === 'h-') {
    const h12 = AP.h % 12 || 12;
    const n = act === 'h+' ? (h12 % 12) + 1 : ((h12 + 10) % 12) + 1;
    AP.h = (n % 12) + (AP.h >= 12 ? 12 : 0);
    renderAlarmBox();
    return;
  } else if (act === 'm+') { AP.m = (AP.m + 1) % 60; renderAlarmBox(); return; }
  else if (act === 'm-') { AP.m = (AP.m + 59) % 60; renderAlarmBox(); return; }
  else if (act === 'am') { AP.h = AP.h % 12; renderAlarmBox(); return; }
  else if (act === 'pm') { AP.h = (AP.h % 12) + 12; renderAlarmBox(); return; }
  else if (act === 'daily') { AP.daily = !AP.daily; renderAlarmBox(); return; }
  else if (act === 'add') {
    if (list.length >= MAX_ALARMS) return;
    const dup = list.find((a) => a.h === AP.h && a.m === AP.m && !!a.daily === AP.daily);
    if (dup) dup.on = true;
    else list.push({ id: Date.now().toString(36), h: AP.h, m: AP.m, on: true, daily: AP.daily });
  }
  storeAlarms(list);
  renderAlarmBox();
}
