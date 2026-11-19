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
const WXD_SUN_SVG = '<circle cx="12" cy="12" r="5" fill="#FFB900"/><g stroke="#F59E0B" stroke-width="1.9" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4.6"/><line x1="12" y1="19.4" x2="12" y2="22"/><line x1="2" y1="12" x2="4.6" y2="12"/><line x1="19.4" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="6.8" y2="6.8"/><line x1="17.2" y1="17.2" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.8" y2="17.2"/><line x1="17.2" y1="6.8" x2="19.1" y2="4.9"/></g>';
const WXD_MOON_SVG = '<path d="M20 13.6A8.4 8.4 0 1 1 10.4 4 6.6 6.6 0 0 0 20 13.6z" fill="#E6EAF5"/><path d="M18.6 2.6l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" fill="#FFFFFF"/><circle cx="21.2" cy="10.4" r="0.8" fill="#C9D1E8"/>';
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
  body.innerHTML =
    '<div class="mx-widget-card">' +
      '<div class="wg-head"><b>Weather</b><span id="wxd-place">--</span></div>' +
      '<div class="wxd-main"><span id="wxd-ico"></span><b id="wxd-temp">--</b></div>' +
      '<div class="wxd-cond" id="wxd-cond">--</div>' +
      '<div class="wxd-sub" id="wxd-sub">--</div>' +
      '<div class="wxd-aqi"><small>AQI</small><b id="wxd-aqi">--</b></div>' +
      '<div class="wxd-aqit" id="wxd-aqit"></div>' +
      '<div class="wxd-scale"><u id="wxd-aqi-mark" style="left:0%;display:none"></u></div>' +
    '</div>' +
    '<div class="mx-widget-card">' +
      '<div class="wxd-bg" id="wxd-bg" aria-hidden="true"></div>' +
      '<div class="wg-head"><b>Sun</b><span id="wxd-daylen"></span></div>' +
      '<div class="wxd-sun-box">' +
        '<svg id="wxd-bar" viewBox="0 0 200 32" aria-hidden="true">' +
          '<defs>' +
            '<linearGradient id="wxd-p-day" x1="0" y1="0" x2="1" y2="0">' +
              '<stop offset="0%" stop-color="#f5a623"/>' +
              '<stop offset="100%" stop-color="#ffcc4d"/>' +
            '</linearGradient>' +
            '<linearGradient id="wxd-p-night" x1="0" y1="0" x2="1" y2="0">' +
              '<stop offset="0%" stop-color="#4a7bdc"/>' +
              '<stop offset="100%" stop-color="#8baaff"/>' +
            '</linearGradient>' +
          '</defs>' +
          '<line class="wxd-bar-base" x1="12" y1="16" x2="188" y2="16"/>' +
          '<line id="wxd-prog" class="wxd-bar-prog" x1="12" y1="16" x2="12" y2="16"/>' +
          '<g id="wxd-body" transform="translate(12 16)">' +
            '<circle id="wxd-halo" class="wxd-halo" r="13"/>' +
            '<g id="wxd-sun" transform="scale(1.05) translate(-12 -12)">' + WXD_SUN_SVG + '</g>' +
            '<g id="wxd-moon" style="display:none" transform="scale(1.05) translate(-12 -12)">' + WXD_MOON_SVG + '</g>' +
          '</g>' +
        '</svg>' +
        '<div class="wxd-sun-times">' +
          '<b id="wxd-l-time">--</b>' +
          '<b id="wxd-r-time">--</b>' +
        '</div>' +
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
  if (!force && wxd.data && wxd.data.unit === unit && wxd.data.rises && Date.now() - wxd.at < 10 * 60 * 1000) return;
  wxd.busy = true;
  try {
    const loc = await detectLocation();
    if (!loc) return;
    const f = unit === 'F';
    const uf = f ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '&wind_speed_unit=kmh';
    const u1 = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,precipitation,rain,showers,surface_pressure,wind_speed_10m,wind_direction_10m,visibility,uv_index' +
      '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min&timezone=auto&past_days=1&forecast_days=2' + uf;
    const u2 = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + loc.lat + '&longitude=' + loc.lon + '&current=us_aqi&timezone=auto';
    const [r1, r2] = await Promise.allSettled([wxFetch(u1), wxFetch(u2)]);
    let j1 = null, j2 = null;
    try { if (r1.status === 'fulfilled' && r1.value.ok) j1 = await r1.value.json(); } catch (_) {}
    try { if (r2.status === 'fulfilled' && r2.value.ok) j2 = await r2.value.json(); } catch (_) {}
    if (!j1 || !j1.current) return;                 // keep whatever we had
    const c = j1.current, d = j1.daily || {}, off = j1.utc_offset_seconds || 0;
    const riseA = d.sunrise || [], setA = d.sunset || [];
    const ti = riseA.length >= 3 && setA.length >= 3 ? 1 : 0;           // index of "today" (0 = yesterday)
    const msOf = (a) => a.map((x) => Date.parse(x + 'Z') - off * 1000);
    const num = (v) => (typeof v === 'number' ? v : null);
    wxd.data = {
      unit, place: loc.city || (typeof weather !== 'undefined' ? weather.place : '') || '',
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature), hum: num(c.relative_humidity_2m),
      code: c.weather_code || 0, isDay: c.is_day === 1, precip: num(c.precipitation) || 0, rain: (num(c.rain) || 0) + (num(c.showers) || 0), pres: num(c.surface_pressure),
      wind: num(c.wind_speed_10m), wdir: num(c.wind_direction_10m), vis: num(c.visibility), uv: num(c.uv_index),
      hi: d.temperature_2m_max ? num(d.temperature_2m_max[ti]) : null, lo: d.temperature_2m_min ? num(d.temperature_2m_min[ti]) : null,
      ti, rises: msOf(riseA), sets: msOf(setA), riseT: riseA.map(wxdFmt12), setT: setA.map(wxdFmt12),
      aqi: (j2 && j2.current && typeof j2.current.us_aqi === 'number') ? Math.round(j2.current.us_aqi) : null
    };
    wxd.at = Date.now();
    try { localStorage.setItem(WXD_CACHE_KEY, JSON.stringify({ data: wxd.data, at: wxd.at })); } catch (_) {}
  } catch (_) {
  } finally {
    wxd.busy = false;
  }
}

// ---- Sun-card weather background: ONE static-DOM layer, pure CSS animation (transform/opacity only) ----
// Like a real weather app: realistic textured clouds (procedural fractal noise painted ONCE into a tiny tileable
// sprite, then only slid sideways by the GPU), falling rain, a bright sun, a moon with silver glow + stars.
// Built lazily; children are replaced ONLY when the look changes. Closed deck = display:none = nothing runs.
const WXD_BG_X = [8, 19, 31, 42, 53, 64, 75, 86, 14, 47, 70, 92];     // fixed spread (no randomness)

// ---- cloud sprite: tileable-in-x fractal noise -> soft wispy cloud bank (alpha + 2-tone shading) ----
const WXD_TONES = {                       // [shadow rgb, light rgb, max alpha]
  night:     [[34, 47, 80],  [104, 124, 170], 0.85],
  nightrain: [[24, 33, 58],  [78, 96, 136],   0.92],
  day:       [[148, 170, 202], [255, 255, 255], 0.94],
  dayrain:   [[78, 92, 114],  [168, 180, 198], 0.92],
  snow:      [[138, 152, 178], [226, 233, 246], 0.88]
};
const wxdTexCache = {};
function wxdMakeFbm(seed, oct, gx0, gy0) {                          // value-noise fbm, wraps horizontally (seamless loop)
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const L = [];
  for (let o = 0; o < oct; o++) { const gx = gx0 << o, gy = gy0 << o, arr = new Float32Array(gx * (gy + 1)); for (let i = 0; i < arr.length; i++) arr[i] = rnd(); L.push(arr); }
  const sm = (t) => t * t * (3 - 2 * t);
  return function (x, y) {                                          // x wraps in [0,1), y in [0,1]
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      const gx = gx0 << o, gy = gy0 << o, fx = x * gx, fy = y * gy;
      const ix = Math.floor(fx), iy = Math.min(gy - 1, Math.floor(fy)), tx = sm(fx - ix), ty = sm(fy - iy);
      const x0 = ((ix % gx) + gx) % gx, x1 = (x0 + 1) % gx, arr = L[o];
      const v0 = arr[iy * gx + x0] * (1 - tx) + arr[iy * gx + x1] * tx;
      const v1 = arr[(iy + 1) * gx + x0] * (1 - tx) + arr[(iy + 1) * gx + x1] * tx;
      sum += (v0 * (1 - ty) + v1 * ty) * amp; norm += amp; amp *= 0.54;
    }
    return sum / norm;
  };
}
function wxdCloudTex(tone, thr, seed) {
  const key = tone + '|' + thr + '|' + seed;
  if (wxdTexCache[key]) return wxdTexCache[key];
  const T = WXD_TONES[tone] || WXD_TONES.night, W = 320, H = 120;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'); if (!ctx) return '';
  const img = ctx.createImageData(W, H), d = img.data;
  const main = wxdMakeFbm(seed, 5, 4, 3), warp = wxdMakeFbm(seed + 77, 3, 3, 2), lit = wxdMakeFbm(seed + 191, 4, 5, 3);
  const ss = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let py = 0; py < H; py++) {
    const y = py / (H - 1), env = 1 - ss(0.5, 1, y);                // bank fades out softly toward the bottom
    for (let px = 0; px < W; px++) {
      const x = px / W, w = warp(x, y) - 0.5;
      const n = main((x + 0.10 * w + 1) % 1, Math.max(0, Math.min(1, y + 0.14 * w)));
      const al = ss(thr, thr + 0.26, n) * env * T[2];
      const sh = Math.max(0, Math.min(1, lit(x, y) * 1.25 - 0.1));  // 0 = shadowed belly, 1 = lit top
      const i = (py * W + px) * 4;
      d[i]     = T[0][0] + (T[1][0] - T[0][0]) * sh;
      d[i + 1] = T[0][1] + (T[1][1] - T[0][1]) * sh;
      d[i + 2] = T[0][2] + (T[1][2] - T[0][2]) * sh;
      d[i + 3] = al * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  let url = ''; try { url = c.toDataURL('image/webp', 0.82); } catch (_) {}
  wxdTexCache[key] = url; return url;
}

function wxdBgSpec(v) {
  const code = +v.code || 0, day = v.isDay !== false, mm = Math.max(+v.precip || 0, +v.rain || 0);
  const r = (typeof wxResolve === 'function') ? wxResolve(code, day, v.precip, v.rain) : null;
  if (r && (r.kind === 'rain' || r.kind === 'storm')) {
    const heavy = [65, 67, 82, 95, 96, 99].indexOf(code) >= 0 || mm >= 2.5;
    const light = !heavy && ([51, 53, 55, 56, 57, 61].indexOf(code) >= 0 || (!WX_RAIN_CODES(code) && mm < 2.5));
    return { kind: 'rain', n: heavy ? 12 : light ? 6 : 9, cl: { thr: heavy ? 0.28 : 0.32, tone: day ? 'dayrain' : 'nightrain', layers: 2 } };
  }
  if (code >= 71 && code <= 77 || code === 85 || code === 86) return { kind: 'snow', n: 8, cl: { thr: 0.42, tone: 'snow', layers: 2 } };
  if (code === 45 || code === 48) return { kind: 'fog', n: 2 };
  if (code === 3) return { kind: 'cloud', n: 0, cl: { thr: 0.34, tone: day ? 'dayrain' : 'night', layers: 2 } };     // overcast
  if (code === 2) return { kind: 'cloud', n: 0, cl: { thr: 0.5, tone: day ? 'day' : 'night', layers: 2 }, sun: day, moon: !day };   // partly cloudy
  const few = code === 1 ? { thr: 0.6, tone: day ? 'day' : 'night', layers: 1 } : null;
  if (day) return { kind: 'clear', n: 0, cl: few, sun: true };                                                      // sunny
  return { kind: 'stars', n: 7, cl: few, moon: true };                                                              // clear night
}
function wxdApplyBg() {
  const bg = wxdEl('wxd-bg'), v = wxd.data;
  if (!bg || !v) return;
  const sp = wxdBgSpec(v), day = v.isDay !== false;
  const cl = sp.cl || null;
  const key = [sp.kind, day ? 'd' : 'n', sp.n, cl ? cl.tone + cl.thr + cl.layers : '', sp.sun ? 's' : '', sp.moon ? 'm' : ''].join('-');
  const body = wxdEl('mx-weather-body');
  if (body) {
    body.className = 'wxd-theme k-' + sp.kind + (day ? ' is-day' : ' is-night');
  }
  if (wxd.bgKey === key) return;                                    // same look: touch nothing
  wxd.bgKey = key;
  bg.className = 'wxd-bg k-' + sp.kind + (day ? ' is-day' : ' is-night');
  let h = '';
  if (sp.sun) h += '<i class="sunglow"></i><i class="rays"></i><i class="sunbody"></i>';       // behind the clouds
  if (sp.moon) h += '<i class="moonglow"></i><i class="moonbody"></i>';
  if (sp.kind === 'fog') { for (let i = 0; i < sp.n; i++) h += '<i style="top:' + (i ? 52 : 18) + '%;--d:-' + (i * 7) + 's"></i>'; }
  else for (let i = 0; i < sp.n; i++) {
    const x = WXD_BG_X[i % WXD_BG_X.length], d = ((i * 37) % 11) / 10;   // 0..1 stagger
    if (sp.kind === 'rain') h += '<i class="drop" style="left:' + x + '%;--d:-' + (d * 1.1).toFixed(2) + 's;--t:' + (0.85 + (i % 3) * 0.12).toFixed(2) + 's"></i>';
    else if (sp.kind === 'snow') h += '<i class="flake" style="left:' + x + '%;--d:-' + (d * 9).toFixed(1) + 's;--t:' + (9 + (i % 4)) + 's;--s:' + (2 + (i % 2)) + 'px"></i>';
    else if (sp.kind === 'stars') h += '<i class="star" style="left:' + [12, 27, 44, 58, 71, 85, 36][i] + '%;top:' + [14, 52, 24, 62, 18, 46, 78][i] + '%;--d:-' + (d * 4).toFixed(1) + 's;--t:' + (3 + (i % 3)) + 's"></i>';
  }
  if (cl) for (let i = 0; i < cl.layers; i++) h += '<i class="cl cl' + i + '"></i>';   // cloud banks drift OVER the sun/moon and rain
  bg.innerHTML = h;
  if (cl) {
    const els = bg.querySelectorAll('i.cl');
    for (let i = 0; i < els.length; i++) {
      const tex = wxdCloudTex(cl.tone, +(cl.thr + i * 0.04).toFixed(2), 1000 + i * 313);
      if (tex) els[i].style.backgroundImage = 'url(' + tex + ')';
    }
  }
}

function wxdSet(id, txt) { const e = wxdEl(id); if (e) e.textContent = txt; }

function wxdRenderSun() {
  const v = wxd.data; if (!v || !v.rises || !v.rises.length) return;
  const k = v.ti || 0, now = Date.now();
  let mode, a, b, lt, rt;
  if (v.rises.length >= 3 && v.sets.length >= 3) {
    if (now < v.rises[k]) { mode = 'night'; a = v.sets[k - 1]; b = v.rises[k]; lt = v.setT[k - 1]; rt = v.riseT[k]; }
    else if (now <= v.sets[k]) { mode = 'day'; a = v.rises[k]; b = v.sets[k]; lt = v.riseT[k]; rt = v.setT[k]; }
    else { mode = 'night'; a = v.sets[k]; b = v.rises[k + 1]; lt = v.setT[k]; rt = v.riseT[k + 1]; }
  } else {                                                          // only today's times known
    const r = v.rises[0], st = v.sets[0];
    if (now >= r && now <= st) { mode = 'day'; a = r; b = st; lt = v.riseT[0]; rt = v.setT[0]; }
    else { mode = 'night'; a = st; b = r + 86400000; lt = v.setT[0]; rt = v.riseT[0]; if (now < r) { a = st - 86400000; b = r; } }
  }
  if (!(b > a)) return;
  const t = Math.max(0, Math.min(1, (now - a) / (b - a)));
  const x = 12 + 176 * t;
  const prog = wxdEl('wxd-prog');
  if (prog) {
    prog.setAttribute('x2', x.toFixed(1));
    prog.setAttribute('stroke', mode === 'day' ? 'url(#wxd-p-day)' : 'url(#wxd-p-night)');
  }
  const body = wxdEl('wxd-body');
  if (body) body.setAttribute('transform', 'translate(' + x.toFixed(1) + ' 16)');
  const sun = wxdEl('wxd-sun'), moon = wxdEl('wxd-moon'), halo = wxdEl('wxd-halo');
  if (sun) sun.style.display = mode === 'day' ? '' : 'none';
  if (moon) moon.style.display = mode === 'day' ? 'none' : '';
  if (halo) {
    halo.style.display = '';
    halo.setAttribute('fill', mode === 'day' ? '#f5b73b' : '#8fa2cc');
    halo.setAttribute('fill-opacity', mode === 'day' ? '0.22' : '0.18');
  }
  wxdSet('wxd-l-time', lt); wxdSet('wxd-r-time', rt);
}

function wxdRender() {
  if (!wxd.built) return;
  wxdLoadCache();
  const v = wxd.data;
  if (!v) return;
  const deg = (n) => (n === null || n === undefined ? '--' : Math.round(n) + '\u00b0');
  const wmo = (typeof wxResolve === 'function') ? wxResolve(v.code, v.isDay, v.precip, v.rain) : null;
  const ico = wxdEl('wxd-ico'); if (ico && wmo) ico.innerHTML = wmo.svg;
  wxdSet('wxd-place', v.place || '--');
  wxdSet('wxd-temp', deg(v.temp) + (v.temp === null ? '' : v.unit));
  wxdSet('wxd-cond', wmo ? wmo.text : '--');
  wxdApplyBg();
  wxdSet('wxd-sub', 'Feels ' + deg(v.feels) + ' \u00b7 H' + deg(v.hi) + ' L' + deg(v.lo));
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
    if (mark) { mark.style.left = Math.max(4, Math.min(96, pos)) + '%'; mark.style.background = b.color; mark.style.display = ''; }
  }
  // sun
  if (v.rises && v.rises.length) {
    const k = v.ti || 0;
    const mins = Math.round((v.sets[k] - v.rises[k]) / 60000);
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
