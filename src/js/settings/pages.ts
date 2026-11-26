import { parseCoords, reverseGeoName } from '../../shared.js';
import { S, UI, esc, getPath, setPath, commit } from './state.js';
import {
  FONT_OPTS,
  WIDGET_OPTS,
  MARKET_PRESETS,
  SKINS,
  TRAY_ANIM_OPTS,
  RECEIVE_ANIM_OPTS,
  SEND_ANIM_OPTS,
  MEDIA_CARD_OPTS,
  EQ_STYLE_OPTS,
  type ChoiceOption,
  type OptionTuple
} from './constants.js';
import { sw, seg, pop, sl, tx, btn, row, card } from './ui.js';
import { pv, menuBlueprint } from './previews.js';
import { alarmBoxHtml } from './alarms.js';
import { getSavedLocation, getCalculatedPrayerTimes } from './prayer.js';
import { tilePickerHtml } from './tiles.js';

export async function commitWeatherCity(input: HTMLInputElement, text: string): Promise<void> {
  const c = parseCoords(text);
  if (!c) {
    setPath(S, 'weather.lat', null);
    setPath(S, 'weather.lon', null);
    commit('weather.city', text);
    return;
  }
  const idle = input.placeholder;
  input.placeholder = 'Finding place…';
  const hit = await reverseGeoName(c.lat, c.lon);
  input.placeholder = idle;
  const name = hit ? hit.name : `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`;
  input.value = name;
  setPath(S, 'weather.lat', c.lat);
  setPath(S, 'weather.lon', c.lon);
  commit('weather.city', name);
}

export function skinName(): string {
  const k = getPath(S, 'companion.skin', 'eyes');
  return (SKINS.find((x) => x[0] === k) || SKINS[0])[1];
}

function skinGridHtml(): string {
  const cur = getPath(S, 'companion.skin', 'eyes');
  return `<div class="skg" data-path="companion.skin">${SKINS.map(([v, l, g, c]) =>
    `<div class="sk${v === cur ? ' on' : ''}" data-val="${v}"><div class="sg2" style="color:${c}">${g}</div><span>${l}</span></div>`).join('')}</div>`;
}

function marketRow(label: string, path: string): string {
  const def = path.endsWith('market2') ? '^NSEI' : 'BTC-USD';
  const cur = String(getPath(S, path, def) || def);
  const isPreset = MARKET_PRESETS.some(([sym]) => sym === cur);
  const custom = path in UI.mkCustom ? UI.mkCustom[path] : !isPreset;
  const opts: OptionTuple[] = MARKET_PRESETS.concat([['__custom', 'Custom\u2026']]);
  const shown = custom ? '__custom' : cur;
  const found = opts.find(([v]) => v === shown) || opts[0];
  const dd = `<div class="pw mk" data-path="${path}">
    <button class="pop" type="button">${found[1]} <i class="ti ti-selector" aria-hidden="true"></i></button>
    <div class="mn">${opts.map(([v, l]) => `<div class="mi${v === shown ? ' on' : ''}" data-val="${esc(v)}"><i class="ti ti-check" aria-hidden="true"></i>${l}</div>`).join('')}</div>
  </div>`;
  const input = custom ? tx(path, 'e.g. BTC-USD', 120) : '';
  return row(label, '', `<div style="display:flex;gap:8px;align-items:center">${input}${dd}</div>`);
}

function notchPage(): string {
  const notchStyle = S.notch?.style || 'curved';
  const compOn = !!(getPath(S, 'animations.enabled', false) && getPath(S, 'companion.enabled', false));
  const compactOpts: OptionTuple[] = [
    ['clock', 'Time'],
    ['weather', 'Weather'],
    ['cpu', 'CPU %'],
    ['ram', 'RAM %'],
    ['battery', 'Battery %'],
    ...(compOn ? [['pet', 'Companion Pet'] as OptionTuple] : []),
    ['cycle', 'Auto cycle']
  ];
  return `
    ${pv('notch')}
    ${card([
      `<div class="rw"><div class="t">Notch style</div></div>
       <div class="tg" data-path="notch.style">
         <div class="tl ${notchStyle === 'attached' ? 'on' : ''}" data-val="attached"><div class="s"><i style="border-radius:0 0 3px 3px"></i></div>Bezel</div>
         <div class="tl ${notchStyle === 'curved' ? 'on' : ''}" data-val="curved"><div class="s"><i style="border-radius:0 0 8px 8px"></i></div>Curved</div>
         <div class="tl ${notchStyle === 'floating' ? 'on' : ''}" data-val="floating"><div class="s"><i style="border-radius:7px;margin-top:4px"></i></div>Floating</div>
       </div>`,
      row('Behavior', '', seg('notch.mode', [['smart', 'Smart'], ['fixed', 'Fixed'], ['ghost', 'Ghost']], 'smart')),
      row('Resting pill', '', pop('notch.compactContent', compactOpts, 'clock'))
    ])}
    <div class="lb">Appearance</div>
    ${card([
      row('Font', '', pop('appearance.fontStyle', FONT_OPTS, 'mono')),
      row('Notch UI scale', '', sl('appearance.scale', 100, 140, '%', 125))
    ])}
    <div class="lb">Island colour</div>
    ${card([
      row('Colour', '', `<input type="color" id="notchColorPicker" value="${S.appearance?.notchColor || '#030305'}" style="cursor:pointer;border:0;background:none;width:30px;height:24px;">`),
      row('Opacity', '', sl('appearance.notchOpacity', 20, 100, '%', 100))
    ])}
  `;
}

function menuPage(): string {
  const menuLayout = S.appearance?.menuLayout || 'deck';
  return `
    <div class="og" data-path="appearance.menuLayout">
      <div class="opt ${menuLayout === 'classic' ? 'on' : ''}" data-val="classic">
        <div class="m mp">${menuBlueprint('classic')}</div>
        <b>Classic</b>
      </div>
      <div class="opt ${menuLayout === 'deck' ? 'on' : ''}" data-val="deck">
        <div class="m mp">${menuBlueprint('deck')}</div>
        <b>Control Deck</b>
      </div>
    </div>
    ${pv('glass')}
    ${card([
      row('Glass style', '', seg('appearance.menuStyle', [['color', 'Solid'], ['transparent', 'Glass']], 'color')),
      row('Micro-interactions', '', sw('appearance.animations', true))
    ])}
    <div class="only-deck">
      <div class="lb">Control Deck</div>
      ${card([
        row('Widgets tab', '', sw('deckMenu.widgetsEnabled', true)),
        row('Stat card', '', pop('deckMenu.statsMode', [['sys', 'CPU & RAM'], ['bt', 'Bluetooth device'], ['none', 'None']], 'sys')),
        row('Weather chip', '', sw('deckMenu.showWeather', true)),
        row('Battery chip', '', sw('deckMenu.showBattery', true)),
        marketRow('Market ticker 1', 'deckMenu.market1'),
        marketRow('Market ticker 2', 'deckMenu.market2')
      ])}
    </div>
    <div class="only-classic">
      ${tilePickerHtml()}
    </div>
  `;
}

function choiceChipsHtml(opts: ChoiceOption[], curId: string, dataAttr: string, dataVal: string): string {
  return opts.map((opt) => {
    const active = opt.id === curId;
    return `<button class="anim-chip${active ? ' on' : ''}" type="button" ${dataAttr}="${dataVal}" data-choice-id="${opt.id}">` +
      `<span class="anim-chip-title">${esc(opt.label)}</span>` +
      `<span class="anim-chip-desc">${esc(opt.desc)}</span>` +
    `</button>`;
  }).join('');
}

function musicPage(): string {
  const cardId = getPath(S, 'notch.mediaCard', 'glass');
  const curCard = MEDIA_CARD_OPTS.find((o) => o.id === cardId) || MEDIA_CARD_OPTS[0];
  const eqId = getPath(S, 'notch.eqStyle', 'bottom');
  const curEq = EQ_STYLE_OPTS.find((o) => o.id === eqId) || EQ_STYLE_OPTS[0];
  return `
    ${pv('music')}
    ${card([
      row('Music mode', '', sw('notch.musicMode', true)),
      row('Media card', '', `<span class="val" id="mc-cur-style">${esc(curCard.label)}</span>${btn('mc-choose', UI.mcOpen ? 'Close' : 'Choose')}`, 'g-music'),
      `<div class="g-music g-mcopen" style="padding:0 14px 12px"><div class="anim-opts">${choiceChipsHtml(MEDIA_CARD_OPTS, curCard.id, 'data-media-card', '1')}</div></div>`,
      row('Compact wave', '', sw('notch.compactMode', true), 'g-music'),
      row('Wave style', '', `<span class="val" id="eq-cur-style">${esc(curEq.label)}</span>${btn('eq-choose', UI.eqOpen ? 'Close' : 'Choose')}`, 'g-music'),
      `<div class="g-music g-eqopen" style="padding:0 14px 12px"><div class="anim-opts">${choiceChipsHtml(EQ_STYLE_OPTS, curEq.id, 'data-eq-style', '1')}</div></div>`,
      row('Artwork glow', '', sw('notch.compactGlow', true), 'g-music'),
      row('Ambient glow', '', sw('notch.ambientGlow', true), 'g-music'),
      row('Sync with sound', '', sw('notch.eqSync', true), 'g-music'),
      row('Sound sensitivity', '', sl('notch.eqSensitivity', 50, 200, '%', 100), 'g-music')
    ])}
  `;
}

function widgetsPage(): string {
  return `
    <div class="lb">Hover and weather</div>
    ${pv('hover')}
    ${card([
      row('Hover widgets', '', sw('widgets.enabled', true)),
      row('Left widget', '', pop('widgets.left', WIDGET_OPTS, 'weather'), 'g-hov'),
      row('Right widget', '', pop('widgets.right', WIDGET_OPTS, 'ram'), 'g-hov'),
      row('Live weather', '', sw('weather.enabled', true)),
      row('Temperature unit', '', seg('weather.unit', [['C', '°C'], ['F', '°F']], 'C'), 'g-wx'),
      row('City', '', tx('weather.city', 'Auto-detect', 150), 'g-wx')
    ])}
  `;
}

function notificationsPage(): string {
  const wellRow = (label: string, on: string, every: string, min: number, max: number): string[] => [
    row(label, '', sw('wellness.' + on, true), 'g-well g-welledit'),
    row('Remind every', '', sl('wellness.' + every, min, max, ' min', every === 'waterEvery' ? 45 : every === 'eyeEvery' ? 20 : 60), 'g-well g-welledit g-' + on)
  ];
  const pvBtn = (key: string): string => `<button class="btn" type="button" data-pv-play="${key}">Preview</button>`;
  return `
    <div class="lb">Preview</div>
    ${pv('notifStage')}
    <div class="lb">System Popups</div>
    ${card([
      row('Unlock animation', '', `${pvBtn('notif-unlock')}${sw('general.lockToast', true)}`),
      row('Clipboard popup', '', `${pvBtn('notif-copy')}${sw('general.copyToast', false)}`),
      row('Charging', '', `${pvBtn('notif-charge')}${sw('general.chargeToast', false)}`),
      row('Low battery', '', `${pvBtn('notif-lowbatt')}${sw('general.lowBatteryAlert', false)}`),
      row('Low battery level', '', sl('general.lowBattery', 5, 40, '%', 20))
    ])}
    <div class="lb">Status & Alerts</div>
    ${card([
      row('Bluetooth battery overlay', '', `${pvBtn('notif-bt')}${sw('overlays.btBattery', true)}`),
      row('Severe weather alerts', '', `${pvBtn('notif-weather')}${sw('weather.alerts', true)}`),
      row('Mic indicator', '', `${pvBtn('notif-mic')}${sw('overlays.privacyDot', true)}`)
    ])}
    <div class="lb">Health reminders</div>
    ${card([
      row('Enable reminders', '', `<span class="g-well">${pvBtn('notif-health')}${btn('well-edit', UI.wellEdit ? 'Done' : 'Edit')}</span>${sw('wellness.enabled', false)}`),
      ...wellRow('Drink water', 'water', 'waterEvery', 10, 120),
      ...wellRow('Eye rest', 'eye', 'eyeEvery', 10, 60),
      ...wellRow('Stretch', 'stretch', 'stretchEvery', 20, 120),
      row('Pause when away', '', sl('wellness.idleReset', 5, 60, ' min', 30), 'g-well g-welledit')
    ])}
  `;
}

function soundsPage(): string {
  const pLoc = getSavedLocation();
  const calcTimes = pLoc ? getCalculatedPrayerTimes(pLoc, S.prayer?.asrMethod === 'hanafi') : null;
  const detectedCityName = (pLoc && pLoc.city) ? pLoc.city : '';
  const sndTestRow = (label: string, key: string): string =>
    row(label, '', `<button class="btn" type="button" data-snd-test="${key}">Test</button>${sw('sounds.' + key, true)}`, 'g-snd g-sndedit');
  return `
    ${card([
      row('Status sound effects', '', `<span class="g-snd">${btn('snd-edit', UI.sndEdit ? 'Done' : 'Edit')}</span>${sw('sounds.enabled', true)}`),
      sndTestRow('Power connect', 'power'),
      sndTestRow('Bluetooth', 'bluetooth'),
      sndTestRow('File transfer', 'transfer'),
      sndTestRow('Lock and unlock', 'lock')
    ])}
    <div class="lb">Prayer times</div>
    ${card([
      row('Show on island', '', `<span class="g-prayer">${btn('prayer-edit', UI.prayerEdit ? 'Done' : 'Edit')}</span>${sw('prayer.enabled', false)}`),
      row('City', '', `<div style="display:flex;gap:6px;align-items:center">${tx('prayer.city', detectedCityName || 'Auto-detect', 120)}<button class="btn" type="button" data-act="prayer-detect" title="Reset to auto-detected location">Auto</button><button class="btn" type="button" data-act="prayer-refresh" title="Refresh prayer times"><i class="ti ti-refresh" aria-hidden="true"></i></button></div>`, 'g-prayer g-prayeredit'),
      row('Asr method', '', seg('prayer.asrMethod', [['standard', 'Standard'], ['hanafi', 'Hanafi']], 'standard'), 'g-prayer g-prayeredit'),
      row('Prayer alert chime', '', pop('prayer.adhanSound', [['chime', 'Peaceful Chime'], ['mute', 'Off']], 'chime'), 'g-prayer g-prayeredit'),
      row('Heads-up (before)', '', pop('prayer.alertLead', [['0', 'Exact time only'], ['5', '5 min before'], ['10', '10 min before'], ['15', '15 min before']], '0'), 'g-prayer g-prayeredit'),
      row('Follow-up (after)', '', pop('prayer.alertRepeat', [['0', 'Off'], ['10', '10 min after'], ['15', '15 min after'], ['20', '20 min after']], '0'), 'g-prayer g-prayeredit'),
      row('Custom masjid timings', '', `<div style="display:flex;gap:8px;align-items:center"><button class="btn only-msj" type="button" data-act="prayer-reset-masjid" title="Reset all 5 waqt times to calculated">Reset</button>${sw('prayer.masjidOverride', false)}</div>`, 'g-prayer g-prayeredit'),
      ...['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => {
        const cVal = (calcTimes && calcTimes[k]) || 'hh:mm';
        return `<div class="rw only-msj g-prayer g-prayeredit"><div class="t">${k[0].toUpperCase() + k.slice(1)}</div>${tx('prayer.masjid.' + k, cVal, 80)}</div>`;
      }),
      row('Preview prayer alert', '', btn('prayer-preview', 'Preview'), 'g-prayer g-prayeredit')
    ])}
    <div class="lb">Focus timer</div>
    ${card([row('Timer chime', '', `${btn('chime-test', 'Test')}${sw('notch.timerSound', true)}`)])}
    <div class="lb">Alarms</div>
    <div id="alarm-box">${alarmBoxHtml()}</div>
  `;
}

function connectPage(): string {
  return `
    <div class="lb">Quick Share & P2P</div>
    ${card([
      row('Device name', '', tx('share.deviceName', 'This PC', 160))
    ])}
  `;
}

function screentimePage(): string {
  const isStEnabled = getPath(S, 'general.screenTimeEnabled', true);
  return `
    <div class="lb">Tracking</div>
    ${card([
      row('Track screen time', '', sw('general.screenTimeEnabled', true))
    ])}
    <div class="lb" style="display:flex;justify-content:space-between;align-items:center;">
      <span>Last 30 days</span>
      <span id="st-tracking-state" style="font-size:11px;font-weight:600;color:${isStEnabled ? 'var(--mint, #20c997)' : 'var(--faint, #8e8e93)'};">${isStEnabled ? 'Tracking' : 'Off'}</span>
    </div>
    <div class="gp st-chart-card">
      <div class="st-chart-top">
        <div class="st-mode-seg" role="tablist" aria-label="View mode">
          <button type="button" class="st-mode-btn on" data-st-mode="apps">Apps</button>
          <button type="button" class="st-mode-btn" data-st-mode="sessions">Screen Time</button>
        </div>
      </div>
      <div class="st-bars-wrap" id="st-bars-container">
        <div style="margin:auto;font-size:12px;color:var(--faint)">Loading history...</div>
      </div>
      <div class="st-chart-footer">
        <span id="st-chart-start-date">--</span>
        <span>Today</span>
      </div>
    </div>
    <div class="lb" id="st-day-header">${isStEnabled ? 'Today' : 'Today (Tracking Off)'}</div>
    <div class="gp" id="st-day-card">
      <div class="rw st-total-row">
        <div class="t" id="st-total-label">Total</div>
        <b class="st-total-time" id="st-total-val">--</b>
      </div>
      <div id="st-app-list">
        <div class="st-app-row"><div class="st-app-name" style="color:var(--faint)">No data yet</div></div>
      </div>
    </div>
    <div class="lb">History</div>
    <div class="gp">
      <div class="rw st-hist-row">
        <div class="st-hist-info">
          <div class="st-hist-title">Older than 30 days is removed automatically</div>
          <div class="st-hist-sub">Only tracked apps are counted</div>
        </div>
        <div id="st-hist-actions">
          <button class="btn" id="btn-st-clear" type="button" style="color:#ff453a">Clear history</button>
        </div>
      </div>
    </div>
  `;
}

function systemPage(): string {
  return `
    ${card([row('Theme', '', seg('general.settingsTheme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], 'system'))])}
    <div class="lb">Startup</div>
    ${card([
      row('Launch at login', '', sw('general.launchAtLogin', true)),
      row('Auto update', '', sw('general.autoUpdate', false)),
      row('24-hour time', '', sw('general.hour24', false))
    ])}
    <div class="lb">Backup</div>
    ${card([
      row('Export settings', '', `<button class="btn" id="btn-export" type="button">Export</button>`),
      row('Import settings', '', `<button class="btn" id="btn-import" type="button">Import</button>`),
      row('Reset all settings', '', `<button class="btn" id="btn-reset" type="button" style="color:#ff453a">Reset</button>`)
    ])}
  `;
}

function aboutPage(): string {
  return `
    <div class="ab-hero">
      <div class="ab-logo"><img src="logo.png" alt="" /></div>
      <div class="ab-meta">
        <div class="ab-name">Inex Island</div>
        <div class="ab-tag">A Dynamic Island and control center for Windows</div>
        <div class="ab-chips">
          <span class="ab-chip v" id="about-ver-text">Version 1.1.0</span>
          <span class="ab-chip">Tauri 2</span>
          <span class="ab-chip">Rust</span>
          <span class="ab-chip">GPLv3</span>
        </div>
      </div>
      <button class="btn" id="btn-check-update" type="button">Check for updates</button>
    </div>
    <div class="gp">
      <div class="rw lk" data-url="https://github.com/inrwxyz"><span class="ic" style="background:#24292f"><i class="ti ti-brand-github" aria-hidden="true"></i></span><div class="t">Developer</div><span class="val">Inexorion</span><i class="ti ti-arrow-up-right go" aria-hidden="true"></i></div>
      <div class="rw lk" data-url="https://github.com/inrwxyz/inex-island/issues"><span class="ic" style="background:#ff9f0a"><i class="ti ti-bug" aria-hidden="true"></i></span><div class="t">Report a bug or suggest a feature</div><i class="ti ti-arrow-up-right go" aria-hidden="true"></i></div>
      <div class="rw lk" data-url="https://github.com/inrwxyz/inex-island/releases"><span class="ic" style="background:#30b0c7"><i class="ti ti-download" aria-hidden="true"></i></span><div class="t">Releases and changelog</div><i class="ti ti-arrow-up-right go" aria-hidden="true"></i></div>
      <div class="rw lk" data-url="https://www.gnu.org/licenses/gpl-3.0.html"><span class="ic" style="background:#8e8e93"><i class="ti ti-scale" aria-hidden="true"></i></span><div class="t">License</div><span class="val">GPL-3.0</span></div>
    </div>
    <div class="ab-spacer"></div>
    <div class="ab-note">
      <p>Inex Island started as a small idea: give Windows the same life that the notch gives a phone. Thank you for trying it. If something breaks or you want a feature, open an issue and I will read it.</p>
      <div class="sg">Inexorion <i class="ti ti-heart" aria-hidden="true"></i></div>
    </div>
  `;
}

function animationsPage(): string {
  const trayId = getPath(S, 'animations.tray.id', 'bounce');
  const curTray = TRAY_ANIM_OPTS.find((o) => o.id === trayId) || TRAY_ANIM_OPTS[0];
  const recvId = getPath(S, 'animations.receive.id', 'radar');
  const curRecv = RECEIVE_ANIM_OPTS.find((o) => o.id === recvId) || RECEIVE_ANIM_OPTS[0];
  const sendId = getPath(S, 'animations.send.id', 'beam');
  const curSend = SEND_ANIM_OPTS.find((o) => o.id === sendId) || SEND_ANIM_OPTS[0];

  return `
    <div class="lb">Preview</div>
    ${pv('animStage')}
    ${card([
      row('Enable animations', '', sw('animations.enabled', false))
    ])}
    <div class="lb g-anims">Companion</div>
    ${card([
      row('Enable companion', '', `<span class="g-pet"><button class="btn" type="button" data-pv-play="anim-companion">Preview</button>${btn('comp-edit', UI.compEdit ? 'Done' : 'Edit')}</span>${sw('companion.enabled', false)}`),
      row('Eye style', '', `<span class="val" id="skin-name">${skinName()}</span>${btn('skin-toggle', UI.skinOpen ? 'Close' : 'Choose')}`, 'g-pet g-compedit'),
      `<div class="g-pet g-compedit g-skin" style="padding:0 14px 12px">${skinGridHtml()}</div>`,
      row('Dots monogram', '', sw('companion.monogram', false), 'g-pet g-compedit'),
      row('Follow the mouse', '', sw('companion.tracking', true), 'g-pet g-compedit'),
      row('Peek no sooner than', '', sl('companion.peekMinMin', 5, 120, ' min', 25), 'g-pet g-compedit'),
      row('Peek no later than', '', sl('companion.peekMaxMin', 10, 240, ' min', 60), 'g-pet g-compedit')
    ], 'g-anims')}
    <div class="lb g-anims">Tray Drop</div>
    ${card([
      row('Tray drop animation', '', `<span class="g-animtray"><span class="val" id="anim-cur-tray">${esc(curTray.label)}</span>${btn('tray-choose', UI.trayOpen ? 'Close' : 'Choose')}</span>${sw('animations.tray.enabled', false)}`),
      `<div class="g-animtray g-trayopen" style="padding:0 14px 12px"><div class="anim-opts" data-anim-cat="tray">${choiceChipsHtml(TRAY_ANIM_OPTS, curTray.id, 'data-anim-cat', 'tray')}</div></div>`
    ], 'g-anims')}
    <div class="lb g-anims">File Receive</div>
    ${card([
      row('File receive animation', '', `<span class="g-animrecv"><button class="btn" type="button" data-pv-play="anim-receive">Preview</button><span class="val" id="anim-cur-receive">${esc(curRecv.label)}</span>${btn('recv-choose', UI.recvOpen ? 'Close' : 'Choose')}</span>${sw('animations.receive.enabled', false)}`),
      `<div class="g-animrecv g-recvopen" style="padding:0 14px 12px"><div class="anim-opts" data-anim-cat="receive">${choiceChipsHtml(RECEIVE_ANIM_OPTS, curRecv.id, 'data-anim-cat', 'receive')}</div></div>`
    ], 'g-anims')}
    <div class="lb g-anims">File Send / Share</div>
    ${card([
      row('Send & share animation', '', `<span class="g-animsend"><button class="btn" type="button" data-pv-play="anim-send">Preview</button><span class="val" id="anim-cur-send">${esc(curSend.label)}</span>${btn('send-choose', UI.sendOpen ? 'Close' : 'Choose')}</span>${sw('animations.send.enabled', false)}`),
      `<div class="g-animsend g-sendopen" style="padding:0 14px 12px"><div class="anim-opts" data-anim-cat="send">${choiceChipsHtml(SEND_ANIM_OPTS, curSend.id, 'data-anim-cat', 'send')}</div></div>`
    ], 'g-anims')}
  `;
}

export function buildPages(): Record<string, string> {
  return {
    notch: notchPage(),
    menu: menuPage(),
    music: musicPage(),
    widgets: widgetsPage(),
    animations: animationsPage(),
    notifications: notificationsPage(),
    sounds: soundsPage(),
    connect: connectPage(),
    screentime: screentimePage(),
    system: systemPage(),
    about: aboutPage()
  };
}
