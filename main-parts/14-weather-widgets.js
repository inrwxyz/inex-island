// Widgets (Reliable Weather with Open-Meteo + Fast IP Geolocation, RAM, CPU, Disk, Battery)
const W_SVG = (inner) => `<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:2px;flex-shrink:0;">${inner}</svg>`;

const W_ICONS = {
  sun: W_SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
  moon: W_SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  cloud_sun: W_SVG('<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.9 12.6a4 4 0 0 0-5.9-4.1"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>'),
  cloud: W_SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
  rain: W_SVG('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="m8 19-1 3m5-3-1 3m5-3-1 3"/>'),
  storm: W_SVG('<path d="M19 16.9A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/><polyline points="13 11 9 17 15 17 11 23"/>'),
  snow: W_SVG('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><line x1="8" y1="15" x2="8.01" y2="15"/><line x1="12" y1="17" x2="12.01" y2="17"/><line x1="16" y1="15" x2="16.01" y2="15"/>')
};

const WMO_CODES = {
  0: { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' },
  1: { day: W_ICONS.cloud_sun, night: W_ICONS.moon, text: 'Mostly Clear' },
  2: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud, text: 'Partly Cloudy' },
  3: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Overcast' },
  45: { day: W_ICONS.cloud_sun, night: W_ICONS.moon, text: 'Hazy' },
  48: { day: W_ICONS.cloud_sun, night: W_ICONS.moon, text: 'Hazy' },
  51: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Drizzle' },
  53: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Drizzle' },
  55: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Drizzle' },
  56: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Drizzle' },
  57: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Drizzle' },
  61: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Rain' },
  63: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Rain' },
  65: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Rain' },
  66: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  67: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  71: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  73: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  75: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  77: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  80: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  81: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  82: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Showers' },
  85: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow Showers' },
  86: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  95: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' },
  96: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' },
  99: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' }
};

const W_DOT_SVG = (inner) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:2px;flex-shrink:0;">${inner}</svg>`;

const W_DOT_ICONS = {
  sun: W_DOT_SVG('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="4.5" r="1.2"/><circle cx="12" cy="19.5" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="19.5" cy="12" r="1.2"/><circle cx="6.7" cy="6.7" r="1.2"/><circle cx="17.3" cy="17.3" r="1.2"/><circle cx="6.7" cy="17.3" r="1.2"/><circle cx="17.3" cy="6.7" r="1.2"/>'),
  moon: W_DOT_SVG('<circle cx="13" cy="5" r="1.2"/><circle cx="11" cy="7" r="1.2"/><circle cx="9" cy="9.5" r="1.2"/><circle cx="8" cy="12.5" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/><circle cx="10.5" cy="18" r="1.2"/><circle cx="13" cy="19" r="1.2"/><circle cx="18" cy="7" r="0.9"/><circle cx="19" cy="13" r="0.9"/>'),
  cloud_sun: W_DOT_SVG('<circle cx="8" cy="13" r="1.3"/><circle cx="11" cy="11.5" r="1.3"/><circle cx="14" cy="11.5" r="1.3"/><circle cx="17" cy="13" r="1.3"/><circle cx="6" cy="16" r="1.3"/><circle cx="9" cy="16" r="1.3"/><circle cx="12" cy="16" r="1.3"/><circle cx="15" cy="16" r="1.3"/><circle cx="18" cy="16" r="1.3"/><circle cx="12" cy="5.5" r="1.2"/><circle cx="16" cy="7.5" r="1.2"/>'),
  cloud: W_DOT_SVG('<circle cx="8" cy="12" r="1.3"/><circle cx="11" cy="10.5" r="1.3"/><circle cx="14" cy="10.5" r="1.3"/><circle cx="17" cy="12" r="1.3"/><circle cx="6" cy="15" r="1.3"/><circle cx="9" cy="15" r="1.3"/><circle cx="12" cy="15" r="1.3"/><circle cx="15" cy="15" r="1.3"/><circle cx="18" cy="15" r="1.3"/>'),
  rain: W_DOT_SVG('<circle cx="8" cy="11" r="1.2"/><circle cx="11" cy="9.5" r="1.2"/><circle cx="14" cy="9.5" r="1.2"/><circle cx="17" cy="11" r="1.2"/><circle cx="6" cy="13.5" r="1.2"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="12" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/><circle cx="18" cy="13.5" r="1.2"/><circle cx="8" cy="18" r="1"/><circle cx="13" cy="18" r="1"/><circle cx="18" cy="18" r="1"/><circle cx="7" cy="21" r="1"/><circle cx="12" cy="21" r="1"/><circle cx="17" cy="21" r="1"/>'),
  storm: W_DOT_SVG('<circle cx="8" cy="10.5" r="1.2"/><circle cx="11" cy="9" r="1.2"/><circle cx="14" cy="9" r="1.2"/><circle cx="17" cy="10.5" r="1.2"/><circle cx="6" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/><circle cx="12" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><circle cx="18" cy="13" r="1.2"/><path d="M12 15l-2 4h3l-1 4" stroke="currentColor" stroke-width="1.8" fill="none"/>'),
  snow: W_DOT_SVG('<circle cx="8" cy="11" r="1.2"/><circle cx="11" cy="9.5" r="1.2"/><circle cx="14" cy="9.5" r="1.2"/><circle cx="17" cy="11" r="1.2"/><circle cx="6" cy="13.5" r="1.2"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="12" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/><circle cx="18" cy="13.5" r="1.2"/><circle cx="8" cy="18" r="1.1"/><circle cx="13" cy="18" r="1.1"/><circle cx="17" cy="18" r="1.1"/>')
};

function getActiveWeatherIcon() {
  if (SET?.appearance?.themeStyle === 'matrix') {
    const code = weather.code || 0;
    const isDay = weather.isDay !== false;
    if (code === 0) return isDay ? W_DOT_ICONS.sun : W_DOT_ICONS.moon;
    if (code === 1 || code === 2) return isDay ? W_DOT_ICONS.cloud_sun : W_DOT_ICONS.cloud;
    if (code === 3 || code === 45 || code === 48) return W_DOT_ICONS.cloud;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return W_DOT_ICONS.rain;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return W_DOT_ICONS.snow;
    if (code >= 95) return W_DOT_ICONS.storm;
    return isDay ? W_DOT_ICONS.sun : W_DOT_ICONS.moon;
  }
  return weather.iconSvg || W_ICONS.sun;
}

const weather = { text: '', iconSvg: W_ICONS.sun, condition: '', at: 0, key: '', place: '', loc: null, locAt: 0, locFailAt: 0, busy: false };
try {
  const cw = JSON.parse(localStorage.getItem('inex.weather.cached') || 'null');
  if (cw && cw.text && Date.now() - cw.at < 60 * 60 * 1000) {
    weather.text = cw.text;
    weather.iconSvg = cw.iconSvg || W_ICONS.sun;
    weather.condition = cw.condition || '';
    weather.place = cw.place || '';
    weather.at = cw.at;
  }
} catch (_) {}

// fetch with a time limit: one hanging request must never keep the weather "busy" for ever
function wxFetch(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

// City typed in Settings -> lat/lon through Open-Meteo's free geocoding (no key). Runs only when the city changes.
async function geocodeCity(name) {
  const q = name.toLowerCase();
  try {
    const sv = JSON.parse(localStorage.getItem('inex.geo') || 'null');
    if (sv && sv.q === q && sv.loc) return sv.loc;
  } catch (_) {}
  const res = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  if (!res.ok) return null;
  const d = await res.json();
  const r = d && d.results && d.results[0];
  if (!r || !isFinite(+r.latitude) || !isFinite(+r.longitude)) return null;
  const loc = { lat: +r.latitude, lon: +r.longitude, city: r.name || name };
  try { localStorage.setItem('inex.geo', JSON.stringify({ q, loc })); } catch (_) {}
  return loc;
}

// Fast IP-based geolocation (no Windows Location COM delays or process locks)
async function detectLocation() {
  const cityQ = ((SET.weather && SET.weather.city) || '').trim();
  if (cityQ) {
    if (weather.cityLoc && weather.cityQ === cityQ) return weather.cityLoc;
    try {
      const g = await geocodeCity(cityQ);
      if (g) { weather.cityQ = cityQ; weather.cityLoc = g; return g; }
    } catch (_) {}
    // city not found / offline: fall back to the automatic IP location below
  }
  const LOC_TTL = 6 * 60 * 60 * 1000, FAIL_TTL = 5 * 60 * 1000;
  if (!weather.loc) {
    try {
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (sv && sv.loc && Date.now() - sv.at < LOC_TTL) { weather.loc = sv.loc; weather.locAt = sv.at; }
    } catch (_) {}
  }
  if (weather.loc && Date.now() - weather.locAt < LOC_TTL) return weather.loc;
  if (weather.locFailAt && Date.now() - weather.locFailAt < FAIL_TTL) return weather.loc;

  let loc = null;
  const tries = [
    async () => {
      const res = await wxFetch('https://ipapi.co/json/');
      if (res.ok) {
        const d = await res.json();
        const lat = d.latitude || d.lat, lon = d.longitude || d.lon;
        if (lat && lon) return { lat: +lat, lon: +lon, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('https://ipwho.is/');
      if (res.ok) {
        const d = await res.json();
        if (d && d.success !== false) return { lat: +d.latitude, lon: +d.longitude, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('http://ip-api.com/json/?fields=status,lat,lon,city');
      if (res.ok) {
        const d = await res.json();
        if (d && d.status === 'success') return { lat: +d.lat, lon: +d.lon, city: d.city || '' };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('https://freeipapi.com/api/json');
      if (res.ok) {
        const d = await res.json();
        if (d && d.latitude && d.longitude) return { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '' };
      }
      return null;
    }
  ];

  for (const t of tries) {
    try {
      const r = await t();
      if (r && isFinite(r.lat) && isFinite(r.lon)) { loc = r; break; }
    } catch (_) {}
  }

  if (loc) {
    weather.loc = loc; weather.locAt = Date.now(); weather.locFailAt = 0;
    try { localStorage.setItem('inex.loc', JSON.stringify({ loc, at: weather.locAt })); } catch (_) {}
  } else {
    weather.locFailAt = Date.now();
    // every lookup failed: keep using the last known place instead of showing nothing
    try {
      const old = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (old && old.loc) weather.loc = old.loc;
    } catch (_) {}
  }
  return loc || weather.loc;
}

// Weather runs ONLY while "Live Weather" is on AND Weather is picked as a hover widget (left or right).
// Not picked = no request, no timer, nothing.
function weatherWanted() {
  const w = SET.widgets || {};
  return w.enabled !== false && !!(SET.weather && SET.weather.enabled) && (w.left === 'weather' || w.right === 'weather');
}

async function refreshWeather() {
  if (weather.busy) return;
  weather.busy = true;
  try {
    if (!weatherWanted()) {
      weather.text = ''; weather.at = 0; weather.key = '';
      renderWidgets();
      return;
    }
    const unit = SET.weather.unit === 'F' ? 'F' : 'C';
    const loc = await detectLocation();
    if (!loc) {
      weather.text = ''; weather.place = ''; weather.at = 0; weather.key = '';
      renderWidgets();
      return;
    }
    const ck = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    const key = `${ck}|${unit}`;
    if (weather.text && weather.key === key && Date.now() - weather.at < 20 * 60 * 1000) return;
    weather.key = key;
    weather.at = Date.now();

    let tempStr = '', code = 0, isDay = true;
    try {
      const unitParam = unit === 'F' ? '&temperature_unit=fahrenheit' : '';
      const wRes = await wxFetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&timezone=auto${unitParam}`);
      if (wRes.ok) {
        const wData = await wRes.json();
        const tVal = wData?.current?.temperature_2m;
        if (typeof tVal === 'number') {
          tempStr = `${Math.round(tVal)}°${unit}`;
          code = wData.current.weather_code ?? 0; weather.code = code;
          isDay = wData.current.is_day === 1; weather.isDay = isDay;
        }
      }
    } catch (_) {}

    if (!tempStr) {
      try {
        const r = await wxFetch(`https://wttr.in/${ck}?format=j1`);
        if (r.ok) {
          const cur = (await r.json())?.current_condition?.[0];
          const val = cur ? (unit === 'F' ? cur.temp_F : cur.temp_C) : undefined;
          if (val !== undefined) tempStr = `${Math.round(+val)}°${unit}`;
        }
      } catch (_) {}
    }

    const wmo = WMO_CODES[code] || { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' };
    weather.text = tempStr;
    weather.iconSvg = isDay ? wmo.day : wmo.night;
    weather.condition = wmo.text;
    weather.place = loc.city || '';
    if (!weather.text) weather.at = 0;
    try { localStorage.setItem('inex.weather.cached', JSON.stringify({ text: weather.text, iconSvg: weather.iconSvg, condition: weather.condition, place: weather.place, at: Date.now() })); } catch (_) {}
    renderWidgets();
  } finally {
    weather.busy = false;
  }
}

// bytes per second -> short text for the Net Speed widget: "512 K/s", "2.4 M/s", "12 M/s"
function fmtNet(b) {
  if (!(b > 0)) return '0 K/s';
  const k = b / 1024;
  if (k < 1000) return Math.round(k) + ' K/s';
  const m = k / 1024;
  return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' M/s';
}

function widgetHtml(kind) {
  const s = appState.stats;
  switch (kind) {
    case 'weather': return SET.weather.enabled && weather.text ? `${getActiveWeatherIcon()}<span>${weather.text}</span>` : '';
    case 'ram': return s ? `RAM ${s.ram_pct}%` : '';
    case 'cpu': return s ? `CPU ${s.cpu_pct}%` : '';
    case 'gpu': return s ? `GPU ${s.gpu_pct ?? 0}%` : '';
    case 'disk': return s ? `Disk ${s.disk_pct}%` : '';
    case 'battery': return s && s.battery_pct >= 0 ? `${s.battery_pct}%` : '';
    case 'net': return appState.net ? `<span class="net2"><b>↓ ${fmtNet(appState.net[0])}</b><b>↑ ${fmtNet(appState.net[1])}</b></span>` : '';
    default: return '';
  }
}

function renderWidgets() {
  const on = SET.widgets.enabled !== false;   // Hover Widgets switch in Settings
  const left = on ? widgetHtml(SET.widgets.left) : '', right = on ? widgetHtml(SET.widgets.right) : '';
  const cTemp = document.getElementById('c-temp');
  const cRam = document.getElementById('c-ram');
  if (cTemp) cTemp.innerHTML = left;
  if (cRam) cRam.innerHTML = right;
  document.getElementById('c-left-box').classList.toggle('has-widget', !!left);
  document.getElementById('c-right-box').classList.toggle('has-widget', !!right);

  cTemp.title = SET.widgets.left === 'weather' && weather.place ? `Forecast • ${weather.place}` : '';
  cRam.title = SET.widgets.right === 'weather' && weather.place ? `Forecast • ${weather.place}` : '';

  const topLeft = document.getElementById('top-left-label');
  const calLeft = document.getElementById('cal-left-label');
  const topRam = document.getElementById('top-ram-label');
  const calRam = document.getElementById('cal-ram-label');
  if (topLeft) topLeft.innerHTML = left;
  if (calLeft) calLeft.innerHTML = left;
  if (topRam) topRam.innerHTML = right;
  if (calRam) calRam.innerHTML = right;
}

function batteryOverlays(stats) {
  if (!(stats.battery_pct >= 0)) return;            // desktop PC: no battery
  const g = SET.general;
  // charger plugged in / removed
  if (appState.prevCharging !== undefined && stats.charging !== appState.prevCharging && g.chargeToast) {
    if (stats.charging && hudCanShow()) {
      showDeviceHud({
        iconHTML: BOLT_SVG,
        battery: true,
        plain: true,
        accent: 'green',
        name: 'Charging',
        tag: `${stats.battery_pct}% • MagSafe Power`,
        pct: stats.battery_pct,
        ms: 3200
      });
    } else if (stats.charging) {
      showToast('bolt', `Charging ${stats.battery_pct}%`, 2400);
    } else if (hudCanShow()) {
      showDeviceHud({
        iconHTML: BATT_SVG,
        battery: true,
        plain: true,
        name: 'On Battery',
        tag: `${stats.battery_pct}% Remaining`,
        pct: stats.battery_pct,
        ms: 2800
      });
    } else {
      showToast('battery', `On battery ${stats.battery_pct}%`, 2400);
    }
  }
  appState.prevCharging = stats.charging;

  // low battery alert HUD
  const low = g.lowBatteryAlert && !stats.charging && stats.battery_pct <= g.lowBattery;
  if (low && !appState.lowShown) {
    if (hudCanShow()) {
      showDeviceHud({
        iconHTML: LOW_BATT_SVG,
        battery: true,
        plain: true,
        accent: stats.battery_pct <= 10 ? 'red' : 'amber',
        name: 'Low Battery',
        tag: `${stats.battery_pct}% • Connect to Power`,
        pct: stats.battery_pct,
        ms: 4000
      });
      appState.lowShown = true;
    } else if (showToast('low', `Low battery ${stats.battery_pct}%`, 4500)) {
      appState.lowShown = true;
    }
  }
  if (!low && (stats.charging || stats.battery_pct > g.lowBattery + 3)) appState.lowShown = false;
}

function setBtCaption(devices) {
  const first = (devices || []).find((d) => d.connected);
  let txt = appState.btRadio && first ? first.name : '';
  if (txt && SET.overlays.btBattery) {
    const pct = btBatteryFor(first.name);
    if (pct !== null) txt += ` • ${pct}%`;
  }
  document.getElementById('bt-cap').textContent = txt;
}
async function refreshBtCaption() {
  if (!slotRunning.has('bt')) return;
  if (!appState.btRadio) { setBtCaption([]); return; }
  setBtCaption(await invokeTauri('get_bt_devices'));
}
