// On-demand animated Settings Preview playback inside Animations and Notifications Preview sections
import { S, getPath } from './state.js';
import { SKINS, type SkinTuple } from './constants.js';
import { ic } from './ui.js';
import { clockText, pillStyle, pill, stage, hud, lockCard, refreshPreviews } from './previews.js';

let _activeTimer: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
let _playToken = 0;

function clearPlayback(): void {
  _playToken++;
  while (_activeTimer.length) {
    const id = _activeTimer.pop();
    if (id !== undefined) {
      clearTimeout(id as ReturnType<typeof setTimeout>);
      clearInterval(id as ReturnType<typeof setInterval>);
    }
  }
  document.querySelectorAll<HTMLElement>('[data-pv-busy="1"]').forEach((host) => {
    delete host.dataset.pvBusy;
  });
}

export function stopStagePreviews(): void {
  clearPlayback();
  refreshPreviews();
}

function activeSkin(): SkinTuple {
  const k = getPath(S, 'companion.skin', 'eyes');
  return SKINS.find((x) => x[0] === k) || SKINS[0];
}

function previewTraceHtml(st: string): string {
  const isFloat = st === 'floating';
  const w = 220;
  const h = isFloat ? 37 : 40;
  const r = isFloat ? 18.5 : 13;
  const vbW = w + 6;
  const vbH = h + 6;
  const d = isFloat
    ? `M ${3 + w / 2},3 H ${3 + w - r} A ${r} ${r} 0 0 1 ${3 + w},${3 + r} V ${3 + h - r} A ${r} ${r} 0 0 1 ${3 + w - r},${3 + h} H ${3 + r} A ${r} ${r} 0 0 1 3,${3 + h - r} V ${3 + r} A ${r} ${r} 0 0 1 ${3 + r},3 Z`
    : `M 3,1 V ${3 + h - r} Q 3,${3 + h} ${3 + r},${3 + h} H ${3 + w - r} Q ${3 + w},${3 + h} ${3 + w},${3 + h - r} V 1`;
  return `<svg class="pv-trace-svg" width="${vbW}" height="${vbH}" viewBox="0 0 ${vbW} ${vbH}" aria-hidden="true">` +
    `<defs><linearGradient id="pv-tg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff9f0a"/><stop offset="0.5" stop-color="#ff375f"/><stop offset="1" stop-color="#bf5af2"/></linearGradient></defs>` +
    `<path d="${d}" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2" pathLength="100"/>` +
    `<path class="pv-trace-fg" d="${d}" fill="none" stroke="url(#pv-tg)" stroke-width="2.5" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>` +
  `</svg>`;
}

export function playStagePreview(kind: string | undefined): void {
  if (!kind) return;
  const isAnim = kind.startsWith('anim-');
  const pvKey = isAnim ? 'animStage' : 'notifStage';
  const host = document.querySelector<HTMLElement>(`[data-pv="${pvKey}"]`);
  if (!host) return;

  clearPlayback();
  const tok = _playToken;
  host.dataset.pvBusy = '1';

  const restore = (delayMs: number): void => {
    const t = setTimeout(() => {
      if (_playToken !== tok) return;
      delete host.dataset.pvBusy;
      host.innerHTML = stage(pill(clockText(), '', 156, true));
    }, delayMs);
    _activeTimer.push(t);
  };

  const st = getPath<string>(S, 'notch.style', 'curved');

  if (kind === 'notif-unlock') {
    host.innerHTML = stage(`<div class="pv-anim-play">${lockCard()}</div>`, 'pv-playing');
    restore(2300);
    return;
  }
  if (kind === 'notif-copy') {
    host.innerHTML = stage(`<div class="pv-anim-play">${hud('clipboard', 'tone-n', 'Copied', 'Text copied')}</div>`, 'pv-playing');
    restore(2100);
    return;
  }
  if (kind === 'notif-charge') {
    host.innerHTML = stage(`<div class="pv-anim-play">${hud('bolt', 'tone-g', 'Charging', '82% \u2022 Power', true)}</div>`, 'pv-playing');
    restore(2200);
    return;
  }
  if (kind === 'notif-lowbatt') {
    const lv = getPath(S, 'general.lowBattery', 20);
    host.innerHTML = stage(`<div class="pv-anim-play">${hud('battery-1', 'tone-r', 'Battery Low', `${lv}% Remaining`, true)}</div>`, 'pv-playing');
    restore(2200);
    return;
  }
  if (kind === 'notif-bt') {
    host.innerHTML = stage(`<div class="pv-anim-play">${hud('headphones', 'tone-g', 'Device', 'Connected', true)}</div>`, 'pv-playing');
    restore(2200);
    return;
  }
  if (kind === 'notif-weather') {
    host.innerHTML = stage(`<div class="pv-anim-play">${hud('alert-triangle', 'tone-d', 'Severe Thunderstorm', 'Danger \u2022 Warning Nearby')}</div>`, 'pv-playing');
    restore(2200);
    return;
  }
  if (kind === 'notif-mic') {
    const inner = `<span class="side-l"><span class="dim">28\u00B0C</span><span class="pd pv-dot-pulse"></span></span><span>${clockText()}</span><span class="dim">Mic active</span>`;
    host.innerHTML = stage(`<div class="pv-anim-play">${pill(inner, 'sp', 236, true)}</div>`, 'pv-playing');
    restore(2000);
    return;
  }
  if (kind === 'notif-health') {
    const w = getPath(S, 'wellness.water', true);
    const e = getPath(S, 'wellness.eye', true);
    const cardHtml = w
      ? hud('droplet', 'tone-w', 'Time for a sip!', 'Stay hydrated')
      : e
        ? hud('eye', 'tone-e', 'Rest your eyes', 'Look 20 ft away')
        : hud('stretching', 'tone-s', 'Time to stretch', 'Stand up & move');
    host.innerHTML = stage(`<div class="pv-anim-play">${cardHtml}</div>`, 'pv-playing');
    restore(2200);
    return;
  }

  if (kind === 'anim-companion') {
    const s = activeSkin();
    const glyph = `<span class="pv-pet-peek" style="color:${s[3]};font-size:12px;letter-spacing:1.5px">${s[2]}</span>`;
    host.innerHTML = stage(`<div class="pv-anim-play">${pill(glyph, '', 168, true)}</div>`, 'pv-playing');
    restore(2400);
    return;
  }

  if (kind === 'anim-receive') {
    const recvId = getPath<string>(S, 'animations.receive.id', 'radar');
    if (recvId === 'notch') {
      host.innerHTML = stage(`<div class="pv-anim-play">${hud('file-text', 'tone-w', '2 files', '8.4 MB \u2022 Phone', true)}</div>`, 'pv-playing');
      const tDrop = setTimeout(() => {
        if (_playToken !== tok) return;
        host.innerHTML = stage(
          `<div class="pv-drop-wrap">${pill(clockText(), '', 156, false)}<span class="pv-drop-doc d1">PDF</span><span class="pv-drop-doc d2">PDF</span></div>`,
          'pv-playing pv-drop-stage'
        );
      }, 1250);
      _activeTimer.push(tDrop);
      restore(2700);
      return;
    }
    const ringCls = st === 'floating' ? 'pv-radar-ring is-floating' : 'pv-radar-ring is-bezel';
    host.innerHTML = stage(
      `<div class="pv-recv-wrap">${pill(clockText(), '', 156, false)}<span class="${ringCls} r1"></span><span class="${ringCls} r2"></span></div>`,
      'pv-playing pv-recv-stage'
    );
    const tCard = setTimeout(() => {
      if (_playToken !== tok) return;
      host.innerHTML = stage(
        `<div class="pill ${st} pv-rcard" style="${pillStyle()};width:228px">` +
          `<div class="pv-rcard-top"><i class="ti ti-file-text"></i><div><b>Report_final.pdf</b><small>14.2 MB</small></div></div>` +
          `<div class="pv-rcard-btns"><span class="d">Decline</span><span class="a">Accept</span></div>` +
        `</div>`,
        'pv-playing'
      );
    }, 850);
    const tDrop = setTimeout(() => {
      if (_playToken !== tok) return;
      host.innerHTML = stage(
        `<div class="pv-drop-wrap">${pill(clockText(), '', 156, false)}<span class="pv-drop-doc d1">PDF</span><span class="pv-drop-doc d2">PDF</span></div>`,
        'pv-playing pv-drop-stage'
      );
    }, 1850);
    _activeTimer.push(tCard, tDrop);
    restore(3300);
    return;
  }

  if (kind === 'anim-send') {
    const sendId = getPath<string>(S, 'animations.send.id', 'beam');
    if (sendId === 'trace') {
      const inner = `<span class="hd-l">${ic('arrow-up-right', 'hd-ic tone-w')}<span class="hd-t"><b>Sending files...</b><small class="pv-send-pct">0%</small></span></span>`;
      host.innerHTML = stage(`<div class="pv-trace-wrap">${pill(inner, 'hud', 220)}${previewTraceHtml(st)}</div>`, 'pv-playing');
    } else {
      const inner = `<div class="pv-beam-row"><i class="ti ti-file"></i><span class="pv-beam-track"><b class="pv-beam-fill"></b></span><i class="ti ti-device-desktop"></i><em class="pv-send-pct">0%</em></div>`;
      host.innerHTML = stage(`<div class="pv-anim-play">${pill(inner, 'hud', 220)}</div>`, 'pv-playing');
    }
    let pct = 0;
    const iv = setInterval(() => {
      if (_playToken !== tok) {
        clearInterval(iv);
        return;
      }
      pct = Math.min(100, pct + 14);
      const pctEl = host.querySelector('.pv-send-pct');
      if (pctEl) pctEl.textContent = `${pct}%`;
      const beamEl = host.querySelector<HTMLElement>('.pv-beam-fill');
      if (beamEl) beamEl.style.transform = `scaleX(${(pct / 100).toFixed(3)})`;
      const traceFg = host.querySelector<SVGPathElement>('.pv-trace-fg');
      if (traceFg) {
        traceFg.style.strokeDashoffset = String(Math.max(0, 100 - pct));
        if (pct >= 100) traceFg.setAttribute('stroke', '#30d158');
      }
      if (pct >= 100) {
        clearInterval(iv);
        restore(700);
      }
    }, 150);
    _activeTimer.push(iv);
  }
}
