
// ==================== 20. PRAYER & SOLAR DECK (optional, OFF by default) ====================
// Settings > Notch > Prayer Times.  While "Prayer & Solar Deck" is off this part does nothing at all:
// no button, no timer, no network, no audio.  Everything is calculated offline from latitude / longitude
// (NOAA-style solar position), so the only network use is ONE location lookup that is then cached for good.
//
//  * Deck      : mosque button in the Control Deck top strip -> #mx-prayer-body (solar arc + prayer list).
//                Its 20 s refresh timer exists ONLY while the deck is open.
//  * Alerts    : ONE setTimeout aimed at the next alert (same pattern as clock alarms: 0 timers when off).
//  * Adhan card: re-uses the timer-end island card (triggerTimerAlarm) with { kind: 'prayer' }.
//  * Audio     : local files in src/audio/ (see PR_SOUNDS), falls back to the chime when a file is missing.
// (functions + var on purpose: applySettings() runs before this part has executed)

var prayer = {
  open: false,
  ui: 0,            // deck refresh interval id
  evTimer: 0,       // next-alert timeout id
  loc: null,        // { lat, lon, city, tz }
  locBusy: false,
  locFailAt: 0,
  locErr: '',
  sig: '',
  dayKey: '',
  days: null,       // { today, tomorrow } calculated times (epoch ms)
  audio: null,
  cardTok: 0,
  fired: ''
};
var prayerMO = null;

var PR_ANGLE = { fajr: 18, isha: 18 };            // Karachi / Islamic Foundation (South Asia): 18 deg / 18 deg
var PR_ADJ_MIN = { dhuhr: 1, maghrib: 0 };        // +1 min after solar noon (standard safety margin)
var PR_NAMES = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
var PR_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
var PR_FIVE = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
// Put the recordings in src/audio/ (anything the Tauri frontend serves, CSP "self" allows it).
var PR_SOUNDS = { madinah: 'audio/adhan-madinah.mp3', short: 'audio/adhan-short.mp3', beep: 'audio/chime.wav' };
var PR_FIRED_KEY = 'inex.prayer.fired';
var PR_LOC_KEY = 'inex.prayer.loc';

function prEl(id) { return document.getElementById(id); }
function prCfg() { return (typeof SET !== 'undefined' && SET && SET.prayer) || {}; }
function prOn() { return !!prCfg().enabled; }

// ---------------------------------------------------------------- astronomy (offline, no libraries)
// Sun declination + equation of time at a Julian date (accurate to well under a minute for prayer use).
function prSun(jd) {
  const R = Math.PI / 180;
  const n = jd - 2451545.0;
  const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;              // mean longitude (deg)
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * R;        // mean anomaly
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R;    // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * R;                               // obliquity
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / R;   // deg
  let eq = L - ra;
  eq = (((eq + 180) % 360) + 360) % 360 - 180;
  return { dec: dec, eqMin: eq * 4 };                                     // 1 deg of RA = 4 min of time
}
// hours from solar noon until the sun sits at altitude `alt` (deg); NaN when it never does (polar day / night)
function prHourAngle(alt, lat, dec) {
  const R = Math.PI / 180;
  const c = (Math.sin(alt * R) - Math.sin(lat * R) * Math.sin(dec)) / (Math.cos(lat * R) * Math.cos(dec));
  if (c < -1 || c > 1 || !isFinite(c)) return NaN;
  return Math.acos(c) / R / 15;
}
// UTC offset (hours) of an IANA zone at an instant; no zone = this PC's zone
function prTzOffset(tz, ms) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return (asUtc - Math.floor(ms / 1000) * 1000) / 3600000;
  } catch (_) { return -new Date(ms).getTimezoneOffset() / 60; }
}
// calendar date (y, m0, d) it is right now in that zone
function prYMD(tz, ms) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric' });
    const p = {};
    f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month - 1, d: +p.day };
  } catch (_) { const d = new Date(ms); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }; }
}
// All six times of one civil date at a place, as epoch ms (null when the sun cannot give them, e.g. polar summer)
function prCalc(loc, y, m, d, hanafi) {
  const base = Date.UTC(y, m, d);                                        // 00:00 UTC of that date
  const tzH = prTzOffset(loc.tz, base + 12 * 3600000);
  const jdAt = (localH) => (base + (localH - tzH) * 3600000) / 86400000 + 2440587.5;
  const transit = (sp) => 12 + tzH - loc.lon / 15 - sp.eqMin / 60;       // local clock hours
  const R = Math.PI / 180;
  let T = transit(prSun(jdAt(12)));
  T = transit(prSun(jdAt(T)));                                           // refine with the sun at noon itself
  // event: sign -1 morning / +1 evening; alt = sun altitude in deg, or 'asr'
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
  let h = {
    fajr: ev(-PR_ANGLE.fajr, -1),
    sunrise: ev(-0.833, -1),
    dhuhr: T + PR_ADJ_MIN.dhuhr / 60,
    asr: ev('asr', 1),
    maghrib: ev(-0.833, 1) + PR_ADJ_MIN.maghrib / 60,
    isha: ev(-PR_ANGLE.isha, 1)
  };
  if (isNaN(h.sunrise) || isNaN(h.maghrib)) return null;
  const night = h.sunrise + 24 - h.maghrib;                              // high latitudes: night / 7 rule
  if (isNaN(h.fajr)) h.fajr = h.sunrise - night / 7;
  if (isNaN(h.isha)) h.isha = h.maghrib + night / 7;
  const out = { base: base, tzH: tzH };
  PR_ORDER.forEach((k) => { out[k] = base + (Math.round(h[k] * 60) / 60 - tzH) * 3600000; });   // whole minutes
  return out;
}

// ---------------------------------------------------------------- custom masjid timings
// "5:12", "05:12 AM", "17:12", "5.12": a missing AM/PM is guessed the way mosque boards are written.
function prParseClock(str, key) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)?\s*$/i.exec(String(str || ''));
  if (!m) return null;
  let h = +m[1]; const mi = +m[2];
  if (mi > 59 || h > 23) return null;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  else if (!ap && h <= 12) {
    if (key === 'fajr') { if (h === 12) h = 0; }
    else if (key === 'dhuhr') { if (h < 11) h += 12; }
    else if (h < 12) h += 12;                                            // Asr / Maghrib / Isha are afternoon / evening
  }
  return h * 60 + mi;
}
function prApplyMasjid(t, dayOff) {
  const c = prCfg();
  if (!c.masjidOverride || !c.masjid || !t) return t;
  const o = Object.assign({}, t);
  PR_FIVE.forEach((k) => {
    const mins = prParseClock(c.masjid[k], k);
    if (mins != null) o[k] = t.base + (mins / 60 - t.tzH) * 3600000;
  });
  return o;
}

// ---------------------------------------------------------------- location (resolved ONCE, then cached for good)
function prFetch(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}
async function prGeocode(query) {
  const parts = String(query).split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts[0] || query;
  const rest = parts.slice(1).join(' ').toLowerCase();
  const res = await prFetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) + '&count=10&language=en&format=json');
  if (!res.ok) return null;
  const d = await res.json();
  const list = (d && d.results) || [];
  if (!list.length) return null;
  let r = list[0];
  if (rest) {   // "Sagardighi, India": pick the hit whose country / state matches the second part
    const hit = list.find((x) => [x.country, x.country_code, x.admin1, x.admin2].filter(Boolean).join(' ').toLowerCase().includes(rest));
    if (hit) r = hit;
  }
  if (!isFinite(+r.latitude) || !isFinite(+r.longitude)) return null;
  return { lat: +r.latitude, lon: +r.longitude, city: r.name || name, tz: r.timezone || '' };
}
async function prIpLocation() {
  try {   // the weather feature may already know where this PC is: reuse it, no request at all
    const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
    if (sv && sv.loc && isFinite(sv.loc.lat) && isFinite(sv.loc.lon)) return { lat: +sv.loc.lat, lon: +sv.loc.lon, city: sv.loc.city || '', tz: '' };
  } catch (_) {}
  const tries = [
    async () => { const r = await prFetch('https://ipapi.co/json/'); if (!r.ok) return null; const d = await r.json(); return d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '', tz: '' } : null; },
    async () => { const r = await prFetch('https://ipwho.is/'); if (!r.ok) return null; const d = await r.json(); return d && d.success !== false && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '', tz: '' } : null; },
    async () => { const r = await prFetch('https://freeipapi.com/api/json'); if (!r.ok) return null; const d = await r.json(); return d && d.latitude ? { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '', tz: '' } : null; }
  ];
  for (const t of tries) { try { const l = await t(); if (l && isFinite(l.lat) && isFinite(l.lon)) return l; } catch (_) {} }
  return null;
}
// Returns true when prayer.loc is usable. Auto mode keeps the PC's own time zone (an IP lookup is near the PC).
async function prEnsureLoc() {
  const c = prCfg();
  const manual = c.locationMode === 'manual' && String(c.city || '').trim();
  const q = manual ? String(c.city).trim().toLowerCase() : '';
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(PR_LOC_KEY) || 'null'); } catch (_) {}
  if (cached && cached.loc && (manual ? (cached.mode === 'manual' && cached.q === q) : cached.mode === 'auto')) {
    prayer.loc = cached.loc; prayer.locErr = '';
    return true;
  }
  if (prayer.locBusy) return !!prayer.loc;
  if (prayer.locFailAt && Date.now() - prayer.locFailAt < 5 * 60000) return !!prayer.loc;   // do not hammer the network
  prayer.locBusy = true;
  let loc = null;
  try { loc = manual ? await prGeocode(c.city.trim()) : await prIpLocation(); } catch (_) {}
  prayer.locBusy = false;
  if (loc) {
    prayer.loc = loc; prayer.locErr = ''; prayer.locFailAt = 0;
    try { localStorage.setItem(PR_LOC_KEY, JSON.stringify({ mode: manual ? 'manual' : 'auto', q: q, loc: loc })); } catch (_) {}
    return true;
  }
  prayer.locFailAt = Date.now();
  prayer.locErr = manual ? 'City not found' : 'Location unavailable';
  if (manual && !prayer.loc) {   // typed city failed: try the automatic location so the deck is still useful
    try { const a = await prIpLocation(); if (a) prayer.loc = a; } catch (_) {}
  }
  return !!prayer.loc;
}

// ---------------------------------------------------------------- schedule + state
function prEnsureDays() {
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
// what the deck shows right now
function prState(now) {
  const days = prEnsureDays();
  if (!days) return null;
  let view = days.today;
  let next = PR_FIVE.find((k) => days.today[k] > now);
  if (!next) { view = days.tomorrow; next = 'fajr'; }                    // after Isha: tomorrow's list
  const rise = view.sunrise, set = view.maghrib;
  const f = (now - rise) / (set - rise);                                 // 0..1 while the sun is up
  return { view: view, next: next, nextAt: view[next], f: f, day: f >= 0 && f <= 1 };
}
function prFmt(ms) {
  const off = prTzOffset(prayer.loc && prayer.loc.tz, ms);
  const d = new Date(ms + off * 3600000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const mm = String(m).padStart(2, '0');
  if (typeof SET !== 'undefined' && SET.general && SET.general.hour24) return String(h).padStart(2, '0') + ':' + mm;
  return String(((h + 11) % 12) + 1).padStart(2, '0') + ':' + mm + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function prIn(ms) {
  const mins = Math.ceil((ms - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins >= 60) return 'in ' + Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  return 'in ' + mins + 'm';
}

// ---------------------------------------------------------------- deck UI
var PR_ARC = { x0: 22, x1: 195, y0: 54, h: 46 };
function prArcPt(t) { return { x: PR_ARC.x0 + (PR_ARC.x1 - PR_ARC.x0) * t, y: PR_ARC.y0 - 4 * PR_ARC.h * t * (1 - t) }; }
function prSet(id, attrs) { const e = prEl(id); if (e) for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

function prRender() {
  if (!prEl('mx-prayer-body')) return;
  const loc = prEl('pr-loc');
  if (loc) loc.textContent = prayer.loc ? (prayer.loc.city || 'Your location') : (prayer.locErr || 'Locating…');
  const st = prRenderState();
  if (!st) {
    prEl('pr-next-name').textContent = prayer.locErr || '--';
    prEl('pr-next-in').textContent = '';
    prEl('pr-next-sub').textContent = prayer.loc ? 'No times at this latitude' : 'Finding your location';
    prEl('pr-list').innerHTML = '';
    return;
  }
}
function prRenderState() {
  const now = Date.now();
  const st = prState(now);
  if (!st) return null;
  const v = st.view;
  // ---- left card: title + countdown
  prEl('pr-next-name').textContent = PR_NAMES[st.next];
  prEl('pr-next-in').textContent = prIn(st.nextAt);
  prEl('pr-next-sub').textContent = prFmt(st.nextAt) + (v !== prayer.days.today ? ' \u2022 tomorrow' : '');
  // ---- right card: list
  let html = '';
  PR_ORDER.forEach((k) => {
    const cls = k === st.next ? 'next' : (v[k] <= now && v === prayer.days.today ? 'past' : '');
    html += '<div class="pr-row ' + cls + (k === 'sunrise' ? ' minor' : '') + '"><span class="pr-n">' + PR_NAMES[k] +
      '</span>' + (k === st.next ? '<span class="pr-badge">NEXT</span>' : '') + '<span class="pr-t">' + prFmt(v[k]) + '</span></div>';
  });
  prEl('pr-list').innerHTML = html;
  // ---- sun arc
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
    const c = m[0] === st.next ? 'pr-mk next' : (v[m[0]] <= now && v === prayer.days.today ? 'pr-mk past' : 'pr-mk');
    g += '<circle class="' + c + '" cx="' + q.x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (m[0] === st.next ? 3 : 2.2) + '"/>';
  });
  const gm = prEl('pr-marks'); if (gm) gm.innerHTML = g;
  const tl = prEl('pr-t-rise'); if (tl) tl.textContent = prFmt(v.sunrise);
  const tr = prEl('pr-t-set'); if (tr) tr.textContent = prFmt(v.maghrib);
  return st;
}

function prOpenDeck() {
  const deck = prEl('view-control-mac');
  if (!deck || !prOn()) return;
  if (typeof wgOpen !== 'undefined' && wgOpen && typeof wgSetTab === 'function') wgSetTab('controls');
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  if (typeof closeMacSub === 'function') closeMacSub();
  deck.classList.add('prayer-open');
  prEl('mac-prayer-btn')?.classList.add('on');
  prayer.open = true;
  prRender();
  prEnsureLoc().then(() => { if (prayer.open) prRender(); prArm(); });
  clearInterval(prayer.ui);
  prayer.ui = setInterval(() => {                                         // exists ONLY while the deck is open
    if (!prayer.open || appState.currentView !== 'view-control-mac') { prCloseDeck(); return; }
    prRender();
  }, 20000);
}
function prCloseDeck() {
  clearInterval(prayer.ui); prayer.ui = 0;
  prayer.open = false;
  prEl('view-control-mac')?.classList.remove('prayer-open');
  prEl('mac-prayer-btn')?.classList.remove('on');
}
// called from switchView(): the menu always opens on "Controls"
function macPrayerReset() { if (typeof prayer !== 'undefined' && prayer && prayer.open) prCloseDeck(); }

// ---------------------------------------------------------------- Adhan alert (island card + native audio)
function prStopAudio() {
  prayer.audio = null;
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
    window.__TAURI__.core.invoke('stop_adhan_native').catch(() => {});
  }
}

function prPlay(soundName, tok, isFallback) {
  prStopAudio();
  prayer.audio = soundName;
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
    window.__TAURI__.core.invoke('play_adhan_native', { soundName: soundName || 'madinah' })
      .then((ok) => {
        if (!ok && !isFallback) {
          prPlay('beep', tok, true);
        }
      })
      .catch(() => {
        if (!isFallback) prPlay('beep', tok, true);
      });
  }
}

function prQuiet(q) { prEl('c-alarm-box')?.classList.toggle('pr-quiet', !!q); }
function prMute() {
  prStopAudio();
  prQuiet(true);
  prEl('btn-alarm-snooze')?.classList.add('hidden');
  const tok = prayer.cardTok;
  setTimeout(() => { if (tok === prayer.cardTok && appState.alarmActive && typeof dismissTimerAlarm === 'function') dismissTimerAlarm(); }, 4000);
}
// ev: { name, prayerAt, lead (bool), repeat (bool), min (number) }
function prAnnounce(ev, preview) {
  const c = prCfg();
  const snd = c.adhanSound || 'madinah';
  const sound = snd !== 'mute';
  let soundName = 'beep';
  if (!ev.lead && !ev.repeat) {
    if (snd === 'madinah') {
      soundName = (c.fullAdhan === false) ? 'short' : 'madinah';
    } else {
      soundName = snd;
    }
  }
  let title = '\uD83D\uDD4C ' + PR_NAMES[ev.name];
  if (ev.lead) title += ' in ' + (ev.min || '') + ' min';
  else if (ev.repeat) title += ' Reminder (+' + (ev.min || '') + 'm)';
  else title += (c.fullAdhan === false && snd === 'madinah' ? ' Takbeer' : ' Adhan');
  const sub = prFmt(ev.prayerAt);
  const tok = ++prayer.cardTok;

  let cardMs = 12000;
  if (sound) {
    if (ev.lead || ev.repeat) {
      cardMs = 14000;
    } else if (soundName === 'short') {
      cardMs = 46000;
    } else if (soundName === 'beep') {
      cardMs = 14000;
    } else {
      cardMs = preview ? 35000 : 230000;
    }
  }

  if (!appState.alarmActive && typeof triggerTimerAlarm === 'function') {
    triggerTimerAlarm({
      kind: 'prayer', silent: true, title: title, sub: sub,
      snooze: sound, snoozeLabel: 'Mute', snoozeTitle: 'Silence the sound', dismissLabel: 'Dismiss',
      ms: cardMs,
      onSnooze: prMute,
      onDismiss: () => { if (tok === prayer.cardTok) { prStopAudio(); prQuiet(false); } }
    });
    prQuiet(!sound);
  }
  if (sound) {
    prPlay(soundName, tok, false);
    setTimeout(() => {
      if (tok === prayer.cardTok && appState.alarmActive && typeof dismissTimerAlarm === 'function') {
        prStopAudio();
        dismissTimerAlarm();
      }
    }, cardMs);
  }
}
function prFire(ev) {
  prayer.fired = ev.key;
  try { localStorage.setItem(PR_FIRED_KEY, ev.key); } catch (_) {}
  prAnnounce(ev, false);
}

// ONE timeout aimed at the next alert (like clock alarms: off = no timer, 0% CPU). Re-armed after every fire,
// every settings change, location change and after sleep / resume.
function prArm() {
  clearTimeout(prayer.evTimer); prayer.evTimer = 0;
  if (!prOn() || !prayer.loc) return;
  const days = prEnsureDays();
  if (!days) return;
  const lead = (parseInt(prCfg().alertLead, 10) || 0) * 60000;
  const repeat = (parseInt(prCfg().alertRepeat, 10) || 0) * 60000;
  let last = prayer.fired;
  if (!last) { try { last = localStorage.getItem(PR_FIRED_KEY) || ''; } catch (_) {} }
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
  // missed by < 90 s (PC just woke up) still counts; the last fired key is never repeated
  const nextEv = evs.find((e) => e.at >= now - 90000 && e.key !== last && !(e.lead && e.prayerAt <= now));
  if (!nextEv) return;
  const delay = Math.min(2147483000, Math.max(0, nextEv.at - now));
  prayer.evTimer = setTimeout(() => {
    prayer.evTimer = 0;
    if (nextEv.at - Date.now() > 1500 && delay >= 2147483000) { prArm(); return; }   // very long sleep: re-aim
    if (prOn()) prFire(nextEv);
    prArm();
    if (prayer.open) prRender();
  }, delay);
}

// ---------------------------------------------------------------- settings hook (cheap: only acts when something changed)
function prayerApplySettings() {
  if (typeof prayer === 'undefined' || !prayer) return;
  const on = prOn();
  const mac = !!(SET.appearance && SET.appearance.menuLayout === 'mac');
  prEl('mac-prayer-btn')?.classList.toggle('hidden', !(on && mac));
  if (!(on && mac)) prCloseDeck();
  const sig = JSON.stringify(SET.prayer || {});
  if (sig === prayer.sig) return;
  prayer.sig = sig;
  prayer.days = null;
  if (!on) {                                                              // off = zero footprint
    clearTimeout(prayer.evTimer); prayer.evTimer = 0;
    prStopAudio();
    return;
  }
  prayer.locFailAt = 0;
  prEnsureLoc().then(() => { prArm(); if (prayer.open) prRender(); });
}

// ---------------------------------------------------------------- wiring
prEl('mac-prayer-btn')?.addEventListener('click', () => { if (prayer.open) prCloseDeck(); else prOpenDeck(); });
// widgets tab / file tray opened (also by drag-drop): the prayer deck gives way
if (typeof MutationObserver !== 'undefined' && prEl('view-control-mac')) {
  prayerMO = new MutationObserver(() => {
    const cl = prEl('view-control-mac').classList;
    if (prayer.open && (cl.contains('widgets-open') || cl.contains('tray-open'))) prCloseDeck();
  });
  prayerMO.observe(prEl('view-control-mac'), { attributes: true, attributeFilter: ['class'] });
}
onTauriEvent('system-resumed', () => { if (prOn()) { prayer.days = null; prArm(); if (prayer.open) prRender(); } });
// "Preview Adhan Alert" button in Settings (the settings window pokes this key, same pattern as the alarm list)
window.addEventListener('storage', (e) => {
  if (e.key === 'inex.prayer.preview' && prOn()) {
    const st = prState(Date.now());
    prAnnounce({ name: st ? st.next : 'dhuhr', prayerAt: st ? st.nextAt : Date.now(), lead: false }, true);
  }
});
prayerApplySettings();
