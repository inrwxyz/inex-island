// ---- Weather deck (Mac Control Deck): click the weather in the top strip -> big weather panel ----
// Same idea as the Prayer deck (20-prayer-deck.js): the panel is built lazily on the first click, fetches its
// details ONLY while open, and its only timer exists ONLY while open. Closed = zero cost, nothing polling.
// Data: Open-Meteo forecast (current + today's sunrise/sunset) and Open-Meteo air-quality (US AQI). No API key.
const wxd = { open: false, built: false, data: null, at: 0, busy: false, tick: 0 };
const WXD_CACHE_KEY = 'inex.wxdeck';

function wxdEl(id) { return document.getElementById(id); }

const WXD_AQI = [
  [50, 'Good', '#3fbf5f'], [100, 'Moderate', '#e8c52f'], [150, 'Unhealthy for some', '#f0892f'],
  [200, 'Unhealthy', '#e0453f'], [300, 'Very unhealthy', '#9a4fc1'], [500, 'Hazardous', '#8f2a45']
];
const WXD_UV = [
  [2, 'Low', '#3fbf5f'], [5, 'Moderate', '#e8c52f'], [7, 'High', '#f0892f'],
  [10, 'Very high', '#e0453f'], [99, 'Extreme', '#9a4fc1']
];
function wxdBand(table, v) {
  for (let i = 0; i < table.length; i++) if (v <= table[i][0]) return { i, label: table[i][1], color: table[i][2] };
  const i = table.length - 1; return { i, label: table[i][1], color: table[i][2] };
}

const WXD_SUNRISE = '<svg viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 19h18"/><path d="M7 19a5 5 0 0 1 10 0"/><path d="M12 4v6"/><path d="M9.5 6.5L12 4l2.5 2.5"/></svg>';
const WXD_SUNSET = '<svg viewBox="0 0 24 24" fill="none" stroke="#f26b3a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 19h18"/><path d="M7 19a5 5 0 0 1 10 0"/><path d="M12 4v6"/><path d="M9.5 7.5L12 10l2.5-2.5"/></svg>';
const WXD_I = (c, inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
const WXD_ICONS = {
  hum: WXD_I('#4aa3df', '<path d="M12 3c3.5 4.2 6 7.2 6 10.5a6 6 0 0 1-12 0C6 10.2 8.5 7.2 12 3z"/>'),
  wind: WXD_I('#9a9aa6', '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>'),
  uv: WXD_I('#9a9aa6', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>'),
  pres: WXD_I('#9a9aa6', '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-4"/>'),
  vis: WXD_I('#9a9aa6', '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>')
};

function wxdBuild() {
  if (wxd.built) return true;
  const deck = wxdEl('view-control-mac');
  if (!deck) return false;
  const body = document.createElement('div');
  body.id = 'mx-weather-body';
  let segs = ''; WXD_AQI.forEach((b) => { segs += '<i style="background:' + b[2] + '"></i>'; });
  body.innerHTML =
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Weather</b><span id="wxd-place">--</span></div>' +
      '<div class="wxd-main"><span id="wxd-ico"></span><b id="wxd-temp">--</b></div>' +
      '<div class="wxd-cond" id="wxd-cond">--</div>' +
      '<div class="wxd-sub" id="wxd-sub">--</div>' +
      '<div class="wxd-aqi"><small>AQI</small><b id="wxd-aqi">--</b></div>' +
      '<div class="wxd-aqit" id="wxd-aqit"></div>' +
      '<div class="wxd-scale">' + segs + '<u id="wxd-aqi-mark" style="left:0%;display:none"></u></div>' +
    '</div>' +
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Sun</b><span id="wxd-daylen"></span></div>' +
      '<svg id="wxd-arc" viewBox="0 0 200 100" aria-hidden="true">' +
        '<line class="wxd-horizon" x1="8" y1="84" x2="192" y2="84"/>' +
        '<path class="wxd-base" d="M22 84A78 78 0 0 1 178 84" pathLength="100"/>' +
        '<path id="wxd-prog" class="wxd-prog" d="M22 84A78 78 0 0 1 178 84" pathLength="100" stroke-dasharray="0 100"/>' +
        '<circle id="wxd-halo" class="wxd-halo" r="9" cx="22" cy="84" style="display:none"/>' +
        '<circle id="wxd-dot" class="wxd-dot night" r="5" cx="22" cy="84"/>' +
      '</svg>' +
      '<div class="wxd-times">' +
        '<div><small>' + WXD_SUNRISE + 'Sunrise</small><b id="wxd-rise">--</b></div>' +
        '<div><small>Sunset' + WXD_SUNSET + '</small><b id="wxd-set">--</b></div>' +
      '</div>' +
    '</div>' +
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Details</b><span>Today</span></div>' +
      '<div class="wxd-rows">' +
        '<div class="wxd-row">' + WXD_ICONS.hum + '<span>Humidity</span><b id="wxd-hum">--</b></div>' +
        '<div class="wxd-row">' + WXD_ICONS.wind + '<span>Wind</span><b id="wxd-wind">--</b></div>' +
        '<div class="wxd-row" id="wxd-uvrow">' + WXD_ICONS.uv + '<span>UV index</span><b id="wxd-uv">--</b></div>' +
        '<div class="wxd-row">' + WXD_ICONS.pres + '<span>Pressure</span><b id="wxd-pres">--</b></div>' +
        '<div class="wxd-row">' + WXD_ICONS.vis + '<span>Visibility</span><b id="wxd-vis">--</b></div>' +
      '</div>' +
    '</div>';
  deck.appendChild(body);
  wxd.built = true;
  return true;
}

function wxdFmt12(str) {                       // "2026-11-20T16:50" -> "4:50 pm" (the place's own clock)
  if (!str || str.length < 16) return '--';
  let h = parseInt(str.slice(11, 13), 10); const m = str.slice(14, 16);
  if (isNaN(h)) return '--';
  const ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ' ' + ap;
}
function wxdLoadCache() {
  if (wxd.data) return;
  try {
    const c = JSON.parse(localStorage.getItem(WXD_CACHE_KEY) || 'null');
    if (c && c.data && typeof c.data === 'object') { wxd.data = c.data; wxd.at = c.at || 0; }
  } catch (_) {}
}

async function wxdFetch(force) {
  if (wxd.busy) return;
  const unit = (typeof SET !== 'undefined' && SET.weather && SET.weather.unit === 'F') ? 'F' : 'C';
  if (!force && wxd.data && wxd.data.unit === unit && Date.now() - wxd.at < 10 * 60 * 1000) return;
  wxd.busy = true;
  try {
    const loc = await detectLocation();
    if (!loc) return;
    const f = unit === 'F';
    const uf = f ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '&wind_speed_unit=kmh';
    const u1 = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,surface_pressure,wind_speed_10m,wind_direction_10m,visibility,uv_index' +
      '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1' + uf;
    const u2 = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + loc.lat + '&longitude=' + loc.lon + '&current=us_aqi&timezone=auto';
    const [r1, r2] = await Promise.allSettled([wxFetch(u1), wxFetch(u2)]);
    let j1 = null, j2 = null;
    try { if (r1.status === 'fulfilled' && r1.value.ok) j1 = await r1.value.json(); } catch (_) {}
    try { if (r2.status === 'fulfilled' && r2.value.ok) j2 = await r2.value.json(); } catch (_) {}
    if (!j1 || !j1.current) return;                 // keep whatever we had
    const c = j1.current, d = j1.daily || {}, off = j1.utc_offset_seconds || 0;
    const riseS = d.sunrise && d.sunrise[0], setS = d.sunset && d.sunset[0];
    const num = (v) => (typeof v === 'number' ? v : null);
    wxd.data = {
      unit, place: loc.city || (typeof weather !== 'undefined' ? weather.place : '') || '',
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature), hum: num(c.relative_humidity_2m),
      code: c.weather_code || 0, isDay: c.is_day === 1, pres: num(c.surface_pressure),
      wind: num(c.wind_speed_10m), wdir: num(c.wind_direction_10m), vis: num(c.visibility), uv: num(c.uv_index),
      hi: d.temperature_2m_max ? num(d.temperature_2m_max[0]) : null, lo: d.temperature_2m_min ? num(d.temperature_2m_min[0]) : null,
      rise: riseS ? Date.parse(riseS + 'Z') - off * 1000 : null, set: setS ? Date.parse(setS + 'Z') - off * 1000 : null,
      riseTxt: wxdFmt12(riseS), setTxt: wxdFmt12(setS),
      aqi: (j2 && j2.current && typeof j2.current.us_aqi === 'number') ? Math.round(j2.current.us_aqi) : null
    };
    wxd.at = Date.now();
    try { localStorage.setItem(WXD_CACHE_KEY, JSON.stringify({ data: wxd.data, at: wxd.at })); } catch (_) {}
  } catch (_) {
  } finally {
    wxd.busy = false;
  }
}

function wxdSet(id, txt) { const e = wxdEl(id); if (e) e.textContent = txt; }

function wxdRenderSun() {
  const v = wxd.data; if (!v || !v.rise || !v.set || v.set <= v.rise) return;
  const t = (Date.now() - v.rise) / (v.set - v.rise);
  const tc = Math.max(0, Math.min(1, t));
  const x = 100 - 78 * Math.cos(Math.PI * tc), y = 84 - 78 * Math.sin(Math.PI * tc);
  const day = t >= 0 && t <= 1;
  const prog = wxdEl('wxd-prog'); if (prog) prog.setAttribute('stroke-dasharray', (t > 1 ? 100 : tc * 100) + ' 100');
  const halo = wxdEl('wxd-halo'); if (halo) { halo.setAttribute('cx', x); halo.setAttribute('cy', y); halo.style.display = day ? '' : 'none'; }
  const dot = wxdEl('wxd-dot'); if (dot) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('class', day ? 'wxd-dot' : 'wxd-dot night'); }
}

function wxdRender() {
  if (!wxd.built) return;
  wxdLoadCache();
  const v = wxd.data;
  if (!v) return;
  const deg = (n) => (n === null || n === undefined ? '--' : Math.round(n) + '\u00b0');
  const wmo = (typeof WMO_CODES !== 'undefined' && WMO_CODES[v.code]) || null;
  const ico = wxdEl('wxd-ico'); if (ico && wmo) ico.innerHTML = v.isDay ? wmo.day : wmo.night;
  wxdSet('wxd-place', v.place || '--');
  wxdSet('wxd-temp', deg(v.temp) + (v.temp === null ? '' : v.unit));
  wxdSet('wxd-cond', wmo ? wmo.text : '--');
  wxdSet('wxd-sub', 'Feels ' + deg(v.feels) + '  \u00b7  H ' + deg(v.hi) + '  L ' + deg(v.lo));
  // AQI
  const aqiEl = wxdEl('wxd-aqi'), aqiT = wxdEl('wxd-aqit'), mark = wxdEl('wxd-aqi-mark');
  if (v.aqi === null) {
    if (aqiEl) { aqiEl.textContent = '--'; aqiEl.style.color = ''; }
    if (aqiT) aqiT.textContent = '';
    if (mark) mark.style.display = 'none';
  } else {
    const b = wxdBand(WXD_AQI, v.aqi);
    if (aqiEl) { aqiEl.textContent = v.aqi; aqiEl.style.color = b.color; }
    if (aqiT) { aqiT.textContent = b.label; aqiT.style.color = b.color; }
    const lo = b.i === 0 ? 0 : WXD_AQI[b.i - 1][0] + 1, hi = WXD_AQI[b.i][0];
    const pos = ((b.i + Math.min(1, (v.aqi - lo) / Math.max(1, hi - lo + 1))) / WXD_AQI.length) * 100;
    if (mark) { mark.style.left = pos + '%'; mark.style.display = ''; }
  }
  // sun
  wxdSet('wxd-rise', v.riseTxt); wxdSet('wxd-set', v.setTxt);
  if (v.rise && v.set && v.set > v.rise) {
    const mins = Math.round((v.set - v.rise) / 60000);
    wxdSet('wxd-daylen', Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm');
  }
  wxdRenderSun();
  // details
  const f = v.unit === 'F';
  const hum = wxdEl('wxd-hum'); if (hum) hum.innerHTML = v.hum === null ? '--' : Math.round(v.hum) + '<em>%</em>';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const wd = v.wdir === null ? '' : dirs[Math.round(v.wdir / 45) % 8] + ' ';
  const wind = wxdEl('wxd-wind'); if (wind) wind.innerHTML = v.wind === null ? '--' : wd + Math.round(v.wind) + '<em>' + (f ? 'mph' : 'km/h') + '</em>';
  const uvEl = wxdEl('wxd-uv');
  if (uvEl) {
    if (v.uv === null) { uvEl.textContent = '--'; uvEl.style.color = ''; }
    else { const b = wxdBand(WXD_UV, v.uv); uvEl.innerHTML = Math.round(v.uv) + '<em>' + b.label + '</em>'; uvEl.style.color = b.color; uvEl.querySelector('em').style.color = 'var(--menu-fg-dim)'; }
  }
  const pres = wxdEl('wxd-pres'); if (pres) pres.innerHTML = v.pres === null ? '--' : Math.round(v.pres) + '<em>hPa</em>';
  const vis = wxdEl('wxd-vis');
  if (vis) {
    if (v.vis === null) vis.textContent = '--';
    else { const km = v.vis / 1000; vis.innerHTML = (km >= 10 ? Math.round(km) : km.toFixed(1)) + '<em>km</em>'; }
  }
}

function wxdOpenDeck() {
  const deck = wxdEl('view-control-mac');
  if (!deck || !wxdBuild()) return;
  if (typeof prayer !== 'undefined' && prayer && prayer.open && typeof prCloseDeck === 'function') prCloseDeck();
  if (typeof wgOpen !== 'undefined' && wgOpen && typeof wgSetTab === 'function') wgSetTab('controls');
  if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
  if (typeof closeMacSub === 'function') closeMacSub();
  deck.classList.add('weather-open');
  wxdEl('mac-weather')?.classList.add('on');
  wxd.open = true;
  wxdRender();                                                        // instant: last saved data
  wxdFetch(false).then(() => { if (wxd.open) wxdRender(); });         // then refresh (skipped if < 10 min old)
  clearInterval(wxd.tick);
  wxd.tick = setInterval(() => {                                      // exists ONLY while the deck is open
    if (!wxd.open || appState.currentView !== 'view-control-mac') { wxdCloseDeck(); return; }
    wxdRenderSun();
  }, 30000);
}
function wxdCloseDeck() {
  clearInterval(wxd.tick); wxd.tick = 0;
  wxd.open = false;
  wxdEl('view-control-mac')?.classList.remove('weather-open');
  wxdEl('mac-weather')?.classList.remove('on');
}

wxdEl('mac-weather')?.addEventListener('click', () => { if (wxd.open) wxdCloseDeck(); else wxdOpenDeck(); });

// Only one deck at a time: opening the Prayer deck closes this one; leaving the menu (switchView) closes it too.
if (typeof prOpenDeck === 'function') {
  const wxdPrevOpen = prOpenDeck;
  prOpenDeck = function () { wxdCloseDeck(); return wxdPrevOpen.apply(this, arguments); };
}
if (typeof macPrayerReset === 'function') {
  const wxdPrevReset = macPrayerReset;
  macPrayerReset = function () { wxdCloseDeck(); return wxdPrevReset.apply(this, arguments); };
}
