// Widgets (Reliable Weather with Open-Meteo + Fast IP Geolocation, RAM, CPU, Disk, Battery)
const W_SVG = (inner) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="display:inline-block;vertical-align:-2px;margin-right:3px;flex-shrink:0;">${inner}</svg>`;

const W_ICONS = {
  sun: W_SVG('<circle cx="12" cy="12" r="5" fill="#F59E0B"/><g stroke="#F59E0B" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22"/><line x1="2" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.07" y2="19.07"/><line x1="4.93" y1="19.07" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.07" y2="4.93"/></g>'),
  moon: W_SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#FBBF24"/><circle cx="17.5" cy="5.5" r="0.8" fill="#FDE68A"/><circle cx="20" cy="9.5" r="0.6" fill="#FDE68A"/>'),
  cloud_sun: W_SVG('<circle cx="8.5" cy="8.5" r="4" fill="#F59E0B"/><g stroke="#F59E0B" stroke-width="1.6" stroke-linecap="round"><line x1="8.5" y1="2" x2="8.5" y2="3.8"/><line x1="2" y1="8.5" x2="3.8" y2="8.5"/><line x1="3.9" y1="3.9" x2="5.2" y2="5.2"/><line x1="13.1" y1="3.9" x2="11.8" y2="5.2"/></g><path d="M19.5 18H8a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 18.8 11.5 3.5 3.5 0 0 1 19.5 18z" fill="#E2E8F0"/>'),
  cloud_moon: W_SVG('<path d="M13.5 3.8a4.5 4.5 0 0 1 4.8 4.8 4.5 4.5 0 0 1-.5 2A4 4 0 0 0 12 7a4 4 0 0 0-.2-1.7 4.5 4.5 0 0 1 1.7-1.5z" fill="#FBBF24"/><path d="M19.5 18H8a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 18.8 11.5 3.5 3.5 0 0 1 19.5 18z" fill="#E2E8F0"/>'),
  cloud: W_SVG('<path d="M16 13a3.5 3.5 0 0 0-3.5-3.5 3.5 3.5 0 0 0-.6.05 4.8 4.8 0 0 0-7.4 2.45A3.5 3.5 0 0 0 6 17h10a3.5 3.5 0 0 0 0-7z" fill="#94A3B8" opacity="0.65"/><path d="M19.5 19H8a4.5 4.5 0 0 1-.4-8.98 5.5 5.5 0 0 1 10.7 2.48A3.5 3.5 0 0 1 19.5 19z" fill="#F1F5F9"/>'),
  drizzle: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#94A3B8"/><g stroke="#38BDF8" stroke-width="1.8" stroke-linecap="round"><line x1="8.5" y1="16.5" x2="7.5" y2="19"/><line x1="13.5" y1="16.5" x2="12.5" y2="19"/></g>'),
  rain: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#64748B"/><g stroke="#38BDF8" stroke-width="1.8" stroke-linecap="round"><line x1="8" y1="16" x2="6.5" y2="20.5"/><line x1="12" y1="16" x2="10.5" y2="20.5"/><line x1="16" y1="16" x2="14.5" y2="20.5"/></g>'),
  storm: W_SVG('<path d="M19 13.5H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 13.5z" fill="#475569"/><polygon points="12,12.5 8.5,17.5 11.5,17.5 10,22.5 15.5,16 12.5,16" fill="#FACC15" stroke="#EAB308" stroke-width="0.5"/>'),
  snow: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#94A3B8"/><circle cx="8" cy="18" r="1.2" fill="#BAE6FD"/><circle cx="12.5" cy="19.5" r="1.2" fill="#E0F2FE"/><circle cx="16.5" cy="18" r="1.2" fill="#BAE6FD"/>'),
  haze: W_SVG('<circle cx="12" cy="9" r="4" fill="#FBBF24"/><path d="M4 16h16M6 19h12" stroke="#94A3B8" stroke-width="1.8" stroke-linecap="round"/>')
};

const WMO_CODES = {
  0: { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' },
  1: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud_moon, text: 'Mostly Clear' },
  2: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud_moon, text: 'Partly Cloudy' },
  3: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Mostly Cloudy' },
  45: { day: W_ICONS.haze, night: W_ICONS.moon, text: 'Fog' },
  48: { day: W_ICONS.haze, night: W_ICONS.moon, text: 'Haze' },
  51: { day: W_ICONS.drizzle, night: W_ICONS.drizzle, text: 'Light Drizzle' },
  53: { day: W_ICONS.drizzle, night: W_ICONS.drizzle, text: 'Drizzle' },
  55: { day: W_ICONS.drizzle, night: W_ICONS.drizzle, text: 'Drizzle' },
  56: { day: W_ICONS.drizzle, night: W_ICONS.drizzle, text: 'Freezing Drizzle' },
  57: { day: W_ICONS.drizzle, night: W_ICONS.drizzle, text: 'Freezing Drizzle' },
  61: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Light Rain' },
  63: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Rain' },
  65: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Rain' },
  66: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  67: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Freezing Rain' },
  71: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Light Snow' },
  73: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow' },
  75: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  77: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow Grains' },
  80: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  81: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Showers' },
  82: { day: W_ICONS.rain, night: W_ICONS.rain, text: 'Heavy Showers' },
  85: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Snow Showers' },
  86: { day: W_ICONS.snow, night: W_ICONS.snow, text: 'Heavy Snow' },
  95: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm' },
  96: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm with Hail' },
  99: { day: W_ICONS.storm, night: W_ICONS.storm, text: 'Thunderstorm with Hail' }
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
  const q = name.toLowerCase().trim();
  try {
    const sv = JSON.parse(localStorage.getItem('inex.geo') || 'null');
    if (sv && sv.q === q && sv.loc) return sv.loc;
  } catch (_) {}
  let r = null;
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  const searchName = parts[0] || name;
  const rest = parts.slice(1).join(' ').toLowerCase();

  try {
    const res = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=10&language=en&format=json`);
    if (res.ok) {
      const d = await res.json();
      const list = (d && d.results) || [];
      if (list.length) {
        r = list[0];
        if (rest) {
          const hit = list.find((x) => [x.country, x.country_code, x.admin1, x.admin2].filter(Boolean).join(' ').toLowerCase().includes(rest));
          if (hit) r = hit;
        } else {
          // If no country specified, prioritize match in local user country / timezone (e.g. India)
          const inHit = list.find((x) => x.country_code === 'IN' || x.timezone === 'Asia/Kolkata');
          if (inHit) r = inHit;
        }
      }
    }
  } catch (_) {}

  // If no exact match for multi-word query (e.g. "Savar DEPZ", "Uttara Sector 10"), try main city words
  if ((!r || !isFinite(+r.latitude)) && name.includes(' ')) {
    const words = name.split(/[\s,/-]+/).filter(w => w.trim().length > 2);
    for (const w of words) {
      if (/^(depz|epz|zone|road|sector|block|area|thana|upazila)$/i.test(w)) continue;
      try {
        const subRes = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(w)}&count=10&language=en&format=json`);
        if (subRes.ok) {
          const subD = await subRes.json();
          const subList = (subD && subD.results) || [];
          if (subList.length) {
            const inHit = subList.find((x) => x.country_code === 'IN' || x.timezone === 'Asia/Kolkata');
            r = inHit || subList[0];
            break;
          }
        }
      } catch (_) {}
    }
  }

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
  if (!(SET.weather && SET.weather.enabled)) return false;
  const compactNeedsWeather = ['weather', 'cycle'].includes(SET.notch?.compactContent);
  const macNeedsWeather = SET.appearance?.menuLayout === 'mac' && (!SET.macMenu || SET.macMenu.showWeather !== false);
  const w = SET.widgets || {};
  const hoverNeedsWeather = w.enabled !== false && (w.left === 'weather' || w.right === 'weather');
  return compactNeedsWeather || macNeedsWeather || hoverNeedsWeather;
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
    updateClocks();
    renderWidgets();
  } finally {
    weather.busy = false;
  }
}

window.addEventListener('storage', (e) => {
  if (e.key === 'inex.weather.refresh') {
    weather.loc = null; weather.locAt = 0; weather.at = 0; weather.key = ''; weather.cityLoc = null; weather.cityQ = '';
    try {
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null');
      if (sv && sv.loc) { weather.loc = sv.loc; weather.locAt = sv.at || Date.now(); }
    } catch (_) {}
    refreshWeather();
  }
});

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

function syncMacWeatherUI() {
  const pill = document.getElementById('mac-weather');
  const tempEl = document.getElementById('mac-weather-temp');
  if (!pill || !tempEl) return;
  const hasWx = !!(SET.weather && SET.weather.enabled && weather.text);
  tempEl.textContent = hasWx ? weather.text : '--°';
  pill.title = weather.place ? `${weather.condition || 'Weather'} • ${weather.place}` : 'Weather';
  const oldSvg = pill.querySelector('svg');
  if (hasWx && oldSvg && typeof getActiveWeatherIcon === 'function') {
    const tmp = document.createElement('span');
    tmp.innerHTML = getActiveWeatherIcon();
    const newSvg = tmp.querySelector('svg');
    if (newSvg) {
      newSvg.setAttribute('width', '14');
      newSvg.setAttribute('height', '14');
      oldSvg.replaceWith(newSvg);
    }
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
  // Prevent empty side-stretch when hover widgets are disabled or both set to None.
  island.classList.toggle('no-hover-expand', !(left || right));

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
  syncMacWeatherUI();
}

function batteryOverlays(stats) {
  if (!(stats.battery_pct >= 0)) return;            // desktop PC: no battery
  const g = SET.general;
  // charger plugged in / removed
  if (appState.prevCharging !== undefined && stats.charging !== appState.prevCharging && g.chargeToast) {
    playStatusSound('power', stats.charging ? 'power' : 'power-off');
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
    playStatusSound('power', 'low');
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

const MAC_BT_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>';
// Control Deck Bluetooth tile: show the connected device's icon (earbuds, headphones...) with a battery ring,
// same look as the device status card. Each copy of BUDS_SVG gets its own gradient id: a duplicate id that
// sits inside a hidden element makes the gradient fail and the buds turn invisible.
function syncMacBtTileIcon(dev) {
  const ico = document.querySelector('#mac-tile-bt .mx-ico');
  if (!ico) return;
  let key = 'bt', html = MAC_BT_GLYPH;
  if (dev && appState.btRadio) {
    const kind = dev.kind || 'bt';
    const isBuds = (kind === 'headphones' || kind === 'bt') && /airpod|buds|earbud|earphone|airdope|tws|pods|wf-/i.test(dev.name || '');
    if (isBuds && typeof BUDS_SVG !== 'undefined') { key = 'buds'; html = BUDS_SVG.replace(/budg/g, 'budg-tile'); }
    else if (kind !== 'bt' && typeof DEV_ICONS !== 'undefined' && DEV_ICONS[kind]) { key = kind; html = DEV_ICONS[kind]; }
  }
  if (ico.dataset.k !== key) {
    ico.dataset.k = key;
    ico.innerHTML = html;
    ico.classList.toggle('has-dev', key !== 'bt');
  }
  let pct = null;
  if (key !== 'bt' && typeof btBatteryFor === 'function') pct = btBatteryFor(dev.name);
  if (pct === null || pct === undefined || !(pct >= 0)) {
    ico.classList.remove('has-batt');
    ico.style.removeProperty('--p');
  } else {
    ico.classList.add('has-batt');
    ico.style.setProperty('--p', Math.max(0, Math.min(100, pct)));
    ico.style.setProperty('--bc', pct <= 15 ? '#ff453a' : pct <= 30 ? '#ff9f0a' : '#30d158');
  }
}

// Long text (song title, Bluetooth name) slides slowly instead of being cut with "...". Only runs while text overflows.
function mqFit(el) {
  if (!el || el._mqBusy) return;
  el._mqBusy = true;
  const inner = el.querySelector(':scope > .mq-in');
  const text = inner ? inner.textContent : el.textContent;
  el.classList.remove('mq');
  if (inner) el.textContent = text;
  if (el.clientWidth > 0) {
    const over = el.scrollWidth - el.clientWidth;
    if (over > 2) {
      const s = document.createElement('span');
      s.className = 'mq-in';
      s.textContent = text;
      el.textContent = '';
      el.appendChild(s);
      el.style.setProperty('--mq-d', `-${over + 6}px`);
      el.style.setProperty('--mq-t', `${Math.max(4, (over + 6) / 20).toFixed(1)}s`);
      el.classList.add('mq');
    }
  }
  requestAnimationFrame(() => { el._mqBusy = false; });
}
['mac-title', 'mac-artist', 'mac-bt-sub'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const fit = () => mqFit(el);
  new MutationObserver(fit).observe(el, { childList: true, characterData: true, subtree: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(el);
  fit();
});

function setBtCaption(devices) {
  const first = (devices || []).find((d) => d.connected);
  let txt = appState.btRadio && appState.btPresent !== false && first ? first.name : '';
  if (txt && SET.overlays.btBattery) {
    const pct = btBatteryFor(first.name);
    if (pct !== null) txt += ` • ${pct}%`;
  }
  document.getElementById('bt-cap').textContent = txt;
  syncMacBtTileIcon(first);
  const macBtSub = document.getElementById('mac-bt-sub');
  if (macBtSub) {
    const _s = appState.btPresent === false ? 'No adapter' : appState.btRadio ? (first ? first.name : 'On') : 'Off';
    if (macBtSub.textContent !== _s) macBtSub.textContent = _s;
  }
}
async function refreshBtCaption() {
  if (!slotRunning.has('bt') && SET.appearance?.menuLayout !== 'mac') return;
  if (appState.btPresent === false || !appState.btRadio) { setBtCaption([]); return; }
  setBtCaption(await invokeTauri('get_bt_devices'));
}
