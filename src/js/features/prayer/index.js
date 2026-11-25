// Prayer & Solar Deck Feature: offline solar calculations, timetable, adhan alerts, and Control Deck prayer panel
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { loadSettings } from '../../core/settings.js';
import { invokeTauri, listenTauri } from '../../core/tauri.js';
import { triggerTimerAlarm, dismissTimerAlarm } from '../timer/index.js';
import { wxdCloseDeck } from '../weather/index.js';

export const prayer = {
  open: false,
  ui: 0,
  evTimer: 0,
  loc: null,
  locBusy: false,
  locFailAt: 0,
  locErr: '',
  sig: '',
  dayKey: '',
  days: null,
  audio: null,
  stopTimer: 0,
  cardTok: 0,
  fired: ''
};

export const PR_ANGLE = { fajr: 18, isha: 18 };
export const PR_ADJ_MIN = { dhuhr: 1, maghrib: 0 };
export const PR_NAMES = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
export const PR_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
export const PR_FIVE = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
export const PR_FIRED_KEY = 'inex.prayer.fired';
export const PR_LOC_KEY = 'inex.prayer.loc';

function prEl(id) {
  return document.getElementById(id);
}

export function prCfg() {
  const SET = loadSettings();
  return (SET && SET.prayer) || {};
}

export function prOn() {
  return !!prCfg().enabled;
}

export function prSun(jd) {
  const R = Math.PI / 180;
  const n = jd - 2451545.0;
  const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R;
  const eps = (23.439 - 0.0000004 * n) * R;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / R;
  let eq = L - ra;
  eq = (((eq + 180) % 360) + 360) % 360 - 180;
  return { dec, eqMin: eq * 4 };
}

export function prHourAngle(alt, lat, dec) {
  const R = Math.PI / 180;
  const c = (Math.sin(alt * R) - Math.sin(lat * R) * Math.sin(dec)) / (Math.cos(lat * R) * Math.cos(dec));
  if (c < -1 || c > 1 || !isFinite(c)) return NaN;
  return Math.acos(c) / R / 15;
}

export function prTzOffset(tz, ms) {
  try {
    const f = new window.Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return (asUtc - Math.floor(ms / 1000) * 1000) / 3600000;
  } catch {
    return -new Date(ms).getTimezoneOffset() / 60;
  }
}

export function prYMD(tz, ms) {
  try {
    const f = new window.Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric' });
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month - 1, d: +p.day };
  } catch {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  }
}

export function prCalc(loc, y, m, d, hanafi) {
  const base = Date.UTC(y, m, d);
  const tzH = prTzOffset(loc.tz, base + 12 * 3600000);
  const jdAt = (localH) => (base + (localH - tzH) * 3600000) / 86400000 + 2440587.5;
  const transit = (sp) => 12 + tzH - loc.lon / 15 - sp.eqMin / 60;
  const R = Math.PI / 180;
  let T = transit(prSun(jdAt(12)));
  T = transit(prSun(jdAt(T)));

  const ev = (alt, sign) => {
    let g = T;
    for (let k = 0; k < 3; k++) {
      const sp = prSun(jdAt(g));
      const a = alt === 'asr'
        ? Math.atan(1 / ((hanafi ? 2 : 1) + Math.tan(Math.abs(loc.lat - sp.dec / R) * R))) / R
        : alt;
      const H = prHourAngle(a, loc.lat, sp.dec);
      if (isNaN(H)) return NaN;
      g = transit(sp) + sign * H;
    }
    return g;
  };

  const h = {
    fajr: ev(-PR_ANGLE.fajr, -1),
    sunrise: ev(-0.833, -1),
    dhuhr: T + PR_ADJ_MIN.dhuhr / 60,
    asr: ev('asr', 1),
    maghrib: ev(-0.833, 1) + PR_ADJ_MIN.maghrib / 60,
    isha: ev(-PR_ANGLE.isha, 1)
  };
  if (isNaN(h.sunrise) || isNaN(h.maghrib)) return null;
  const night = h.sunrise + 24 - h.maghrib;
  if (isNaN(h.fajr)) h.fajr = h.sunrise - night / 7;
  if (isNaN(h.isha)) h.isha = h.maghrib + night / 7;
  const out = { base, tzH };
  PR_ORDER.forEach((k) => { out[k] = base + (Math.round(h[k] * 60) / 60 - tzH) * 3600000; });
  return out;
}

export function prParseClock(str, key) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)?\s*$/i.exec(String(str || ''));
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  if (mi > 59 || h > 23) return null;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  else if (!ap && h <= 12) {
    if (key === 'fajr') { if (h === 12) h = 0; }
    else if (key === 'dhuhr') { if (h < 11) h += 12; }
    else if (h < 12) h += 12;
  }
  return h * 60 + mi;
}

export function prApplyMasjid(t) {
  const c = prCfg();
  if (!c.masjidOverride || !c.masjid || !t) return t;
  const o = Object.assign({}, t);
  PR_FIVE.forEach((k) => {
    const mins = prParseClock(c.masjid[k], k);
    if (mins != null) o[k] = t.base + (mins / 60 - t.tzH) * 3600000;
  });
  return o;
}

export function prFetch(url, ms) {
  const ctl = new window.AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

export async function prGeocode(query) {
  const parts = String(query).split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts[0] || query;
  const rest = parts.slice(1).join(' ').toLowerCase();
  const res = await prFetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) + '&count=10&language=en&format=json');
  if (!res.ok) return null;
  const d = await res.json();
  const list = (d && d.results) || [];
  if (!list.length) return null;
  let r = list[0];
  if (rest) {
    const hit = list.find((x) => [x.country, x.country_code, x.admin1, x.admin2].filter(Boolean).join(' ').toLowerCase().includes(rest));
    if (hit) r = hit;
  }
  if (!isFinite(+r.latitude) || !isFinite(+r.longitude)) return null;
  return { lat: +r.latitude, lon: +r.longitude, city: r.name || name, tz: r.timezone || '' };
}

export async function prIpLocation(forceFresh = false) {
  if (!forceFresh) {
    try {
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (sv && sv.loc && isFinite(sv.loc.lat) && isFinite(sv.loc.lon) && (Date.now() - (sv.at || 0) < 60 * 60 * 1000)) {
        return { lat: +sv.loc.lat, lon: +sv.loc.lon, city: sv.loc.city || '', tz: '' };
      }
    } catch (err) {
      console.warn('Location storage read error:', err);
    }
  }
  const tries = [
    async () => { const r = await prFetch('https://ipwho.is/'); if (!r.ok) return null; const d = await r.json(); return d && d.success !== false && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '', tz: '' } : null; },
    async () => { const r = await prFetch('https://ipapi.co/json/'); if (!r.ok) return null; const d = await r.json(); return d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '', tz: '' } : null; },
    async () => { const r = await prFetch('https://freeipapi.com/api/json'); if (!r.ok) return null; const d = await r.json(); return d && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '', tz: '' } : null; }
  ];
  for (const t of tries) {
    try {
      const l = await t();
      if (l && isFinite(l.lat) && isFinite(l.lon)) return l;
    } catch (err) {
      console.warn('IP location try failed:', err);
    }
  }
  return null;
}

export async function prEnsureLoc(forceFresh = false) {
  const c = prCfg();
  const cityStr = String(c.city || '').trim();
  const manual = !!cityStr;
  const q = cityStr.toLowerCase();
  let cached = null;
  if (!forceFresh) {
    try {
      cached = JSON.parse(localStorage.getItem(PR_LOC_KEY) || 'null');
    } catch (err) {
      console.warn('Prayer location cache read error:', err);
    }
    if (cached && cached.loc && (manual ? (cached.mode === 'manual' && cached.q === q) : cached.mode === 'auto')) {
      prayer.loc = cached.loc;
      prayer.locErr = '';
      return true;
    }
  }
  if (prayer.locBusy) return !!prayer.loc;
  if (!forceFresh && prayer.locFailAt && Date.now() - prayer.locFailAt < 5 * 60000) return !!prayer.loc;
  prayer.locBusy = true;
  let loc = null;
  try {
    loc = manual ? await prGeocode(cityStr) : await prIpLocation(forceFresh);
  } catch (err) {
    console.warn('Prayer location lookup error:', err);
  }
  prayer.locBusy = false;
  if (loc) {
    prayer.loc = loc;
    prayer.locErr = '';
    prayer.locFailAt = 0;
    try { localStorage.setItem(PR_LOC_KEY, JSON.stringify({ mode: manual ? 'manual' : 'auto', q, loc })); } catch (err) { console.warn('Cache write failed:', err); }
    try { localStorage.setItem('inex.loc', JSON.stringify({ loc, at: Date.now() })); } catch (err) { console.warn('Location write failed:', err); }
    return true;
  }
  prayer.locFailAt = Date.now();
  prayer.locErr = manual ? 'City not found' : 'Location unavailable';
  if (manual && !prayer.loc) {
    try {
      const a = await prIpLocation(forceFresh);
      if (a) prayer.loc = a;
    } catch (err) {
      console.warn('Fallback location failed:', err);
    }
  }
  return !!prayer.loc;
}

export function prEnsureDays() {
  if (!prayer.loc) return null;
  const now = Date.now();
  const ymd = prYMD(prayer.loc.tz, now);
  const key = ymd.y + '-' + ymd.m + '-' + ymd.d + '|' + prayer.sig;
  if (prayer.days && prayer.dayKey === key) return prayer.days;
  const hanafi = prCfg().asrMethod === 'hanafi';
  const t0 = prApplyMasjid(prCalc(prayer.loc, ymd.y, ymd.m, ymd.d, hanafi));
  const t1 = prApplyMasjid(prCalc(prayer.loc, ymd.y, ymd.m, ymd.d + 1, hanafi));
  prayer.dayKey = key;
  prayer.days = (t0 && t1) ? { today: t0, tomorrow: t1 } : null;
  return prayer.days;
}

export function prState(now) {
  const days = prEnsureDays();
  if (!days) return null;
  let view = days.today;
  let next = PR_FIVE.find((k) => days.today[k] > now);
  if (!next) {
    view = days.tomorrow;
    next = 'fajr';
  }
  const rise = view.sunrise;
  const set = view.maghrib;
  const f = (now - rise) / (set - rise);
  return { view, next, nextAt: view[next], f, day: f >= 0 && f <= 1 };
}

export function prFmt(ms) {
  const SET = loadSettings();
  const off = prTzOffset(prayer.loc && prayer.loc.tz, ms);
  const d = new Date(ms + off * 3600000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const mm = String(m).padStart(2, '0');
  if (SET.general && SET.general.hour24) return String(h).padStart(2, '0') + ':' + mm;
  return String(((h + 11) % 12) + 1).padStart(2, '0') + ':' + mm + ' ' + (h >= 12 ? 'PM' : 'AM');
}

export function prIn(ms) {
  const mins = Math.ceil((ms - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins >= 60) return 'in ' + Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  return 'in ' + mins + 'm';
}

const PR_ARC = { x0: 22, x1: 195, y0: 54, h: 46 };
function prArcPt(t) {
  return { x: PR_ARC.x0 + (PR_ARC.x1 - PR_ARC.x0) * t, y: PR_ARC.y0 - 4 * PR_ARC.h * t * (1 - t) };
}
function prSet(id, attrs) {
  const e = prEl(id);
  if (e) {
    for (const k in attrs) e.setAttribute(k, attrs[k]);
  }
  return e;
}

export function prRender() {
  if (!prEl('mx-prayer-body')) return;
  const loc = prEl('pr-loc');
  if (loc) loc.textContent = prayer.loc ? (prayer.loc.city || 'Your location') : (prayer.locErr || 'Locating…');
  const st = prRenderState();
  if (!st) {
    const n = prEl('pr-next-name'); if (n) n.textContent = prayer.locErr || '--';
    const ni = prEl('pr-next-in'); if (ni) ni.textContent = '';
    const ns = prEl('pr-next-sub'); if (ns) ns.textContent = prayer.loc ? 'No times at this latitude' : 'Finding your location';
    const l = prEl('pr-list'); if (l) l.innerHTML = '';
  }
}

export function prRenderState() {
  const now = Date.now();
  const st = prState(now);
  if (!st) return null;
  const v = st.view;

  const n = prEl('pr-next-name'); if (n) n.textContent = PR_NAMES[st.next];
  const ni = prEl('pr-next-in'); if (ni) ni.textContent = prIn(st.nextAt);
  const ns = prEl('pr-next-sub'); if (ns) ns.textContent = prFmt(st.nextAt) + (v !== prayer.days?.today ? ' \u2022 tomorrow' : '');

  let html = '';
  PR_ORDER.forEach((k) => {
    const cls = k === st.next ? 'next' : (v[k] <= now && v === prayer.days?.today ? 'past' : '');
    html += '<div class="pr-row ' + cls + (k === 'sunrise' ? ' minor' : '') + '"><span class="pr-n">' + PR_NAMES[k] +
      '</span>' + (k === st.next ? '<span class="pr-badge">NEXT</span>' : '') + '<span class="pr-t">' + prFmt(v[k]) + '</span></div>';
  });
  const pl = prEl('pr-list');
  if (pl) pl.innerHTML = html;

  const span = v.maghrib - v.sunrise;
  const frac = (ms) => (ms - v.sunrise) / span;
  const t = Math.max(0, Math.min(1, st.f));
  const p = prArcPt(t);
  prSet('pr-prog', { 'stroke-dasharray': (st.day ? t * 100 : (st.f > 1 ? 100 : 0)) + ' 100' });
  prSet('pr-halo', { cx: p.x, cy: p.y, display: st.day ? '' : 'none' });
  const dot = prSet('pr-dot', { cx: p.x, cy: p.y });
  if (dot) dot.setAttribute('class', st.day ? 'pr-sun-dot' : 'pr-sun-dot night');
  const mk = [['fajr', -0.075], ['sunrise', 0], ['dhuhr', frac(v.dhuhr)], ['asr', frac(v.asr)], ['maghrib', 1], ['isha', 1.075]];
  let g = '';
  mk.forEach((m) => {
    const q = prArcPt(m[1]);
    const y = (m[1] < 0 || m[1] > 1) ? PR_ARC.y0 : q.y;
    const c = m[0] === st.next ? 'pr-mk next' : (v[m[0]] <= now && v === prayer.days?.today ? 'pr-mk past' : 'pr-mk');
    g += '<circle class="' + c + '" cx="' + q.x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (m[0] === st.next ? 3 : 2.2) + '"/>';
  });
  const gm = prEl('pr-marks'); if (gm) gm.innerHTML = g;
  const tl = prEl('pr-t-rise'); if (tl) tl.textContent = prFmt(v.sunrise);
  const tr = prEl('pr-t-set'); if (tr) tr.textContent = prFmt(v.maghrib);
  return st;
}

export function prStopAudio() {
  clearTimeout(prayer.stopTimer);
  prayer.stopTimer = 0;
  prayer.audio = null;
  invokeTauri('stop_alarm_sound').catch((err) => console.warn('Tauri invoke error:', err));
}

export function prPlay() {
  prayer.audio = 'chime';
  invokeTauri('play_alarm_sound').catch((err) => console.warn('Tauri invoke error:', err));
}

export function prStartLoop() {
  prayer.audio = 'chime';
  invokeTauri('start_alarm_loop', { gapMs: 350 }).catch((err) => console.warn('Tauri invoke error:', err));
}

export function prQuiet(q) {
  prEl('c-alarm-box')?.classList.toggle('pr-quiet', !!q);
}

export function prMute() {
  prStopAudio();
  prQuiet(true);
  prEl('btn-alarm-snooze')?.classList.add('hidden');
  const tok = prayer.cardTok;
  setTimeout(() => {
    if (tok === prayer.cardTok && appState.alarmActive) dismissTimerAlarm();
  }, 600);
}

export function prAnnounce(ev, preview) {
  const c = prCfg();
  const snd = c.adhanSound || 'madinah';
  const sound = snd !== 'mute';
  let soundName = 'beep';
  if (!ev.lead && !ev.repeat) {
    soundName = (snd === 'madinah' || snd === 'short') ? 'short' : snd;
  }
  let title = '\uD83D\uDD4C ' + PR_NAMES[ev.name];
  if (ev.lead) title += ' in ' + (ev.min || '') + ' min';
  else if (ev.repeat) title += ' Reminder (+' + (ev.min || '') + 'm)';
  else title += (snd === 'madinah' ? ' Takbeer' : ' Alert');
  const sub = prFmt(ev.prayerAt);
  const tok = ++prayer.cardTok;

  let cardMs = 12000;
  if (sound) {
    if (ev.lead || ev.repeat) cardMs = 14000;
    else if (soundName === 'short') cardMs = 46000;
    else if (soundName === 'beep') cardMs = 14000;
    else cardMs = preview ? 35000 : 46000;
  }

  const ownCard = !appState.alarmActive;
  if (ownCard) {
    triggerTimerAlarm({
      kind: 'prayer', silent: true, title, sub,
      snooze: sound, snoozeLabel: 'Mute', snoozeTitle: 'Silence the sound', dismissLabel: 'Dismiss',
      ms: cardMs,
      onSnooze: prMute,
      onDismiss: () => {
        if (tok === prayer.cardTok) {
          prStopAudio();
          prQuiet(false);
        }
      }
    });
    prQuiet(!sound);
  }

  if (sound) {
    prStopAudio();
    // Play full alarm sound end-to-end and repeat sequentially until Dismiss, Mute, or card timeout.
    if (ownCard) {
      prStartLoop();
    } else {
      prPlay();
    }
    prayer.stopTimer = setTimeout(() => {
      if (tok === prayer.cardTok && appState.alarmActive) {
        prStopAudio();
        dismissTimerAlarm();
      }
    }, cardMs);
  }
}

export function prFire(ev) {
  prayer.fired = ev.key;
  try {
    localStorage.setItem(PR_FIRED_KEY, ev.key);
  } catch (err) {
    console.warn('Storage write failed:', err);
  }
  prAnnounce(ev, false);
}

export function prArm() {
  clearTimeout(prayer.evTimer);
  prayer.evTimer = 0;
  if (!prOn() || !prayer.loc) return;
  const days = prEnsureDays();
  if (!days) return;
  const lead = (parseInt(prCfg().alertLead, 10) || 0) * 60000;
  const repeat = (parseInt(prCfg().alertRepeat, 10) || 0) * 60000;
  let last = prayer.fired;
  if (!last) {
    try {
      last = localStorage.getItem(PR_FIRED_KEY) || '';
    } catch (err) {
      console.warn('Storage read failed:', err);
    }
  }
  const now = Date.now();
  const evs = [];
  [days.today, days.tomorrow].forEach((day) => {
    PR_FIVE.forEach((k) => {
      if (lead > 0) evs.push({ name: k, prayerAt: day[k], at: day[k] - lead, lead: true, repeat: false, min: Math.round(lead / 60000), key: day[k] + ':lead' });
      evs.push({ name: k, prayerAt: day[k], at: day[k], lead: false, repeat: false, key: day[k] + ':adhan' });
      if (repeat > 0) evs.push({ name: k, prayerAt: day[k], at: day[k] + repeat, lead: false, repeat: true, min: Math.round(repeat / 60000), key: day[k] + ':repeat' });
    });
  });
  evs.sort((a, b) => a.at - b.at);
  const nextEv = evs.find((e) => e.at >= now - 90000 && e.key !== last && !(e.lead && e.prayerAt <= now));
  if (!nextEv) return;
  const delay = Math.min(2147483000, Math.max(0, nextEv.at - now));
  prayer.evTimer = setTimeout(() => {
    prayer.evTimer = 0;
    if (nextEv.at - Date.now() > 1500 && delay >= 2147483000) { prArm(); return; }
    if (prOn()) prFire(nextEv);
    prArm();
    if (prayer.open) prRender();
  }, delay);
}

export function prCloseDeck() {
  clearInterval(prayer.ui);
  prayer.ui = 0;
  prayer.open = false;
  prEl('view-control-deck')?.classList.remove('prayer-open');
  prEl('deck-prayer-btn')?.classList.remove('on');
}

export function prOpenDeck() {
  const deck = prEl('view-control-deck');
  if (!deck || !prOn()) return;
  wxdCloseDeck();
  if (typeof window.closeDeckSub === 'function') window.closeDeckSub();
  bus.emit('deck:close-other-panels', 'prayer');
  deck.classList.add('prayer-open');
  prEl('deck-prayer-btn')?.classList.add('on');
  prayer.open = true;
  prRender();
  prEnsureLoc().then(() => {
    if (prayer.open) prRender();
    prArm();
  });
  clearInterval(prayer.ui);
  prayer.ui = setInterval(() => {
    if (!prayer.open || appState.currentView !== 'view-control-deck') {
      prCloseDeck();
      return;
    }
    prRender();
  }, 20000);
}

export function deckPrayerReset() {
  if (prayer.open) prCloseDeck();
}

export function prayerApplySettings() {
  const SET = loadSettings();
  const on = prOn();
  const isDeck = !SET.appearance || SET.appearance.menuLayout === 'deck';
  prEl('deck-prayer-btn')?.classList.toggle('hidden', !(on && isDeck));
  if (!(on && isDeck)) prCloseDeck();
  const sig = JSON.stringify(SET.prayer || {});
  if (sig === prayer.sig) return;
  prayer.sig = sig;
  prayer.days = null;
  if (!on) {
    clearTimeout(prayer.evTimer);
    prayer.evTimer = 0;
    prStopAudio();
    return;
  }
  prayer.locFailAt = 0;
  prEnsureLoc().then(() => {
    prArm();
    if (prayer.open) prRender();
  });
}

export function initPrayer() {
  prEl('deck-prayer-btn')?.addEventListener('click', () => {
    if (prayer.open) {
      prCloseDeck();
    } else {
      if (typeof window.wgSetTab === 'function') window.wgSetTab('controls');
      prOpenDeck();
    }
  });

  listenTauri('system-resumed', () => {
    if (prOn()) {
      prayer.days = null;
      prArm();
      if (prayer.open) prRender();
    }
  });

  window.addEventListener('storage', (e) => {
    if (e.key === 'inex.prayer.preview' && prOn()) {
      const st = prState(Date.now());
      prAnnounce({ name: st ? st.next : 'dhuhr', prayerAt: st ? st.nextAt : Date.now(), lead: false }, true);
    }
    if (e.key === 'inex.prayer.refreshLoc' && prOn()) {
      try {
        localStorage.removeItem(PR_LOC_KEY);
      } catch (err) {
        console.warn('Storage operation failed:', err);
      }
      prayer.loc = null;
      prayer.days = null;
      prEnsureLoc(true).then(() => {
        prArm();
        if (prayer.open) prRender();
      });
    }
  });

  bus.on('prayer:open', () => prOpenDeck());
  bus.on('prayer:close', () => prCloseDeck());
  bus.on('deck:close-other-panels', (who) => {
    if (who !== 'prayer' && prayer.open) prCloseDeck();
  });
  bus.on('prayer:apply-settings', () => prayerApplySettings());
  bus.on('deck:reset', () => deckPrayerReset());
  bus.on('view:change', (view) => {
    if (view !== 'view-control-deck' && prayer.open) prCloseDeck();
  });

  prayerApplySettings();
}
