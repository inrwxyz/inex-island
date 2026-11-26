// Weather Feature: Open-Meteo forecasts, IP Geolocation, Deck weather cards, and Hover widgets
import { $, island } from '../../core/dom.js';
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { loadSettings } from '../../core/settings.js';
import { updateClocks } from '../clock/index.js';

export interface WeatherLocation {
  lat: number;
  lon: number;
  city: string;
  cc: string;
}

export interface WeatherState {
  text: string;
  iconSvg: string;
  condition: string;
  at: number;
  key: string;
  place: string;
  loc: WeatherLocation | null;
  locAt: number;
  locFailAt: number;
  busy: boolean;
  cityLoc: WeatherLocation | null;
  cityQ: string;
  code: number;
  isDay: boolean;
  precip: number;
  rain: number;
}

export interface WeatherDeckDay {
  t: string;
  code: number;
  hi: number | null;
  lo: number | null;
}

export interface WeatherDeckData {
  unit: string;
  locKey: string;
  place: string;
  temp: number | null;
  feels: number | null;
  hum: number | null;
  code: number;
  isDay: boolean;
  precip: number;
  rain: number;
  pres: number | null;
  wind: number | null;
  wdir: number | null;
  vis: number | null;
  uv: number | null;
  hi: number | null;
  lo: number | null;
  days: WeatherDeckDay[];
  ti: number;
  rises: number[];
  sets: number[];
  riseT: string[];
  setT: string[];
  aqi: number | null;
}

export interface WeatherDeckState {
  open: boolean;
  built: boolean;
  data: WeatherDeckData | null;
  at: number;
  busy: boolean;
  again: boolean;
  tick: ReturnType<typeof setInterval> | 0;
  bgKey: string;
  lt: ReturnType<typeof setTimeout> | 0;
  skyDay: boolean;
  moonB: number;
}

export const W_SVG = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="display:inline-block;vertical-align:-2px;margin-right:3px;flex-shrink:0;">${inner}</svg>`;

export const W_ICONS = {
  sun: W_SVG('<circle cx="12" cy="12" r="5" fill="#FFB900"/><g stroke="#F59E0B" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22"/><line x1="2" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.07" y2="19.07"/><line x1="4.93" y1="19.07" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.07" y2="4.93"/></g>'),
  moon: W_SVG('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="#FBBF24"/><circle cx="17.5" cy="5.5" r="0.8" fill="#FDE68A"/><circle cx="20" cy="9.5" r="0.6" fill="#FDE68A"/>'),
  cloud_sun: W_SVG('<circle cx="8.5" cy="8.5" r="4.2" fill="#FFB900"/><g stroke="#F59E0B" stroke-width="1.6" stroke-linecap="round"><line x1="8.5" y1="2" x2="8.5" y2="3.8"/><line x1="2" y1="8.5" x2="3.8" y2="8.5"/><line x1="3.9" y1="3.9" x2="5.2" y2="5.2"/><line x1="13.1" y1="3.9" x2="11.8" y2="5.2"/></g><path d="M19.5 18H8a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 18.8 11.5 3.5 3.5 0 0 1 19.5 18z" fill="#F1F5F9"/>'),
  cloud_moon: W_SVG('<path d="M13.5 3.8a4.5 4.5 0 0 1 4.8 4.8 4.5 4.5 0 0 1-.5 2A4 4 0 0 0 12 7a4 4 0 0 0-.2-1.7 4.5 4.5 0 0 1 1.7-1.5z" fill="#FBBF24"/><path d="M19.5 18H8a4.5 4.5 0 0 1-.4-8.98A5.5 5.5 0 0 1 18.8 11.5 3.5 3.5 0 0 1 19.5 18z" fill="#F1F5F9"/>'),
  cloud: W_SVG('<path d="M16 13a3.5 3.5 0 0 0-3.5-3.5 3.5 3.5 0 0 0-.6.05 4.8 4.8 0 0 0-7.4 2.45A3.5 3.5 0 0 0 6 17h10a3.5 3.5 0 0 0 0-7z" fill="#94A3B8" opacity="0.75"/><path d="M19.5 19H8a4.5 4.5 0 0 1-.4-8.98 5.5 5.5 0 0 1 10.7 2.48A3.5 3.5 0 0 1 19.5 19z" fill="#F8FAFC"/>'),
  rain: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#64748B"/><g stroke="#38BDF8" stroke-width="1.8" stroke-linecap="round"><line x1="8" y1="16" x2="6.5" y2="20.5"/><line x1="12" y1="16" x2="10.5" y2="20.5"/><line x1="16" y1="16" x2="14.5" y2="20.5"/></g>'),
  rain_light: W_SVG('<path d="M19 13.5H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 13.5z" fill="#94A3B8"/><g stroke="#38BDF8" stroke-width="1.6" stroke-linecap="round"><line x1="9.5" y1="16" x2="8.7" y2="18.6"/><line x1="14" y1="16" x2="13.2" y2="18.6"/><line x1="11.8" y1="19.4" x2="11" y2="22"/></g>'),
  storm: W_SVG('<path d="M19 13.5H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 13.5z" fill="#475569"/><polygon points="12,12.5 8.5,17.5 11.5,17.5 10,22.5 15.5,16 12.5,16" fill="#FACC15" stroke="#EAB308" stroke-width="0.5"/>'),
  snow: W_SVG('<path d="M19 14H7.5a4 4 0 0 1-.4-7.98 5 5 0 0 1 9.7 2.2A3.2 3.2 0 0 1 19 14z" fill="#94A3B8"/><circle cx="8" cy="18" r="1.2" fill="#BAE6FD"/><circle cx="12.5" cy="19.5" r="1.2" fill="#E0F2FE"/><circle cx="16.5" cy="18" r="1.2" fill="#BAE6FD"/>')
};

export const WMO_CODES: Record<number, { day: string; night: string; text: string }> = {
  0: { day: W_ICONS.sun, night: W_ICONS.moon, text: 'Clear' },
  1: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud_moon, text: 'Mostly Clear' },
  2: { day: W_ICONS.cloud_sun, night: W_ICONS.cloud_moon, text: 'Partly Cloudy' },
  3: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Mostly Cloudy' },
  45: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Fog' },
  48: { day: W_ICONS.cloud, night: W_ICONS.cloud, text: 'Haze' },
  51: { day: W_ICONS.rain_light, night: W_ICONS.rain_light, text: 'Light Drizzle' },
  53: { day: W_ICONS.rain_light, night: W_ICONS.rain_light, text: 'Drizzle' },
  55: { day: W_ICONS.rain_light, night: W_ICONS.rain_light, text: 'Drizzle' },
  56: { day: W_ICONS.rain_light, night: W_ICONS.rain_light, text: 'Freezing Drizzle' },
  57: { day: W_ICONS.rain_light, night: W_ICONS.rain_light, text: 'Freezing Drizzle' },
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

export const WX_RAIN_CODES = (c: number): boolean => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
export const WX_SNOW_CODES = (c: number): boolean => (c >= 71 && c <= 77) || c === 85 || c === 86;

export function wxResolve(code: number, isDay: boolean, precip?: number, rain?: number): { kind: string; svg: string; text: string } {
  const cd = +code || 0;
  const dayMode = isDay !== false;
  const mm = Math.max(+(precip ?? 0) || 0, +(rain ?? 0) || 0);
  const base = WMO_CODES[cd] || WMO_CODES[0];
  const pick = (o: { day: string; night: string }): string => (dayMode ? o.day : o.night);
  if (WX_SNOW_CODES(cd) || cd >= 95) return { kind: cd >= 95 ? 'storm' : 'snow', svg: pick(base), text: base.text };
  if (WX_RAIN_CODES(cd) || mm > 0) {
    const wetCode = WX_RAIN_CODES(cd);
    const light = (cd >= 51 && cd <= 57) || cd === 61 || (!wetCode && mm < 2.5);
    const text = wetCode ? base.text : (mm >= 7.6 ? 'Heavy Rain' : mm >= 2.5 ? 'Rain' : 'Light Rain');
    const heavy = !light || mm >= 2.5;
    return { kind: 'rain', svg: heavy ? W_ICONS.rain : W_ICONS.rain_light, text };
  }
  return { kind: cd <= 2 ? 'sky' : 'cloud', svg: pick(base), text: base.text };
}

export const weather: WeatherState = {
  text: '', iconSvg: W_ICONS.sun, condition: '', at: 0, key: '', place: '',
  loc: null, locAt: 0, locFailAt: 0, busy: false, cityLoc: null, cityQ: '',
  code: 0, isDay: true, precip: 0, rain: 0
};

export function getActiveWeatherIcon(): string {
  return weather.iconSvg || W_ICONS.sun;
}

export function wxFetch(url: string, ms = 7000): Promise<Response> {
  const ctl = new window.AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

export async function detectIpLocation(): Promise<WeatherLocation | null> {
  const LOC_TTL = 6 * 60 * 60 * 1000;
  const FAIL_TTL = 5 * 60 * 1000;
  if (!weather.loc) {
    try {
      const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null') as { loc?: WeatherLocation; at?: number } | null;
      if (sv && sv.loc && sv.loc.cc && sv.at !== undefined && Date.now() - sv.at < LOC_TTL) {
        weather.loc = sv.loc;
        weather.locAt = sv.at;
      }
    } catch (err) {
      console.warn('Storage read failed:', err);
    }
  }
  if (weather.loc && weather.loc.cc && Date.now() - weather.locAt < LOC_TTL) return weather.loc;
  if (weather.locFailAt && Date.now() - weather.locFailAt < FAIL_TTL) return weather.loc;

  let loc: WeatherLocation | null = null;
  const tries: Array<() => Promise<WeatherLocation | null>> = [
    async () => {
      const res = await wxFetch('https://ipapi.co/json/');
      if (res.ok) {
        const d = await res.json();
        const lat = d.latitude || d.lat;
        const lon = d.longitude || d.lon;
        if (lat && lon) return { lat: +lat, lon: +lon, city: d.city || '', cc: String(d.country_code || d.country || '').toUpperCase().slice(0, 2) };
      }
      return null;
    },
    async () => {
      const r = await wxFetch('https://ipwho.is/');
      if (r.ok) {
        const d = await r.json();
        if (d && d.success !== false) return { lat: +d.latitude, lon: +d.longitude, city: d.city || '', cc: String(d.country_code || '').toUpperCase() };
      }
      return null;
    },
    async () => {
      const res = await wxFetch('https://freeipapi.com/api/json');
      if (res.ok) {
        const d = await res.json();
        if (d && d.latitude && d.longitude) return { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '', cc: String(d.countryCode || '').toUpperCase() };
      }
      return null;
    }
  ];

  for (const t of tries) {
    try {
      const r = await t();
      if (r && isFinite(r.lat) && isFinite(r.lon)) {
        loc = r;
        break;
      }
    } catch (err) {
      console.warn('Location query failed:', err);
    }
  }

  if (loc) {
    weather.loc = loc;
    weather.locAt = Date.now();
    weather.locFailAt = 0;
    try {
      localStorage.setItem('inex.loc', JSON.stringify({ loc, at: weather.locAt }));
    } catch (err) {
      console.warn('Storage write failed:', err);
    }
  } else {
    weather.locFailAt = Date.now();
    try {
      const old = JSON.parse(localStorage.getItem('inex.loc') || 'null') as { loc?: WeatherLocation } | null;
      if (old && old.loc) weather.loc = old.loc;
    } catch (err) {
      console.warn('Storage read fallback failed:', err);
    }
  }
  return loc || weather.loc;
}

export async function homeCountryCode(): Promise<string> {
  if (weather.loc && weather.loc.cc) return weather.loc.cc;
  try {
    const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null') as { loc?: WeatherLocation } | null;
    if (sv && sv.loc && sv.loc.cc) return sv.loc.cc;
  } catch (err) {
    console.warn('Storage read failed:', err);
  }
  try {
    const l = await detectIpLocation();
    if (l && l.cc) return l.cc;
  } catch (err) {
    console.warn('Home country detect failed:', err);
  }
  return '';
}

interface GeoResultItem {
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
}

export function wxPickGeoHit(list: GeoResultItem[], rest: string, cc: string): GeoResultItem | null {
  if (!list.length) return null;
  const hay = (x: GeoResultItem): string => [x.country, x.country_code, x.admin1, x.admin2].filter(Boolean).join(' ').toLowerCase();
  if (rest) {
    const hit = list.find((x) => hay(x).includes(rest));
    if (hit) return hit;
  }
  if (cc) {
    const local = list.find((x) => String(x.country_code || '').toUpperCase() === cc);
    if (local) return local;
  }
  return list[0];
}

export async function geocodeCity(name: string): Promise<WeatherLocation | null> {
  const cc = await homeCountryCode();
  const q = name.toLowerCase().trim() + (cc ? '|' + cc : '');
  try {
    const sv = JSON.parse(localStorage.getItem('inex.geo') || 'null') as { q?: string; loc?: WeatherLocation } | null;
    if (sv && sv.q === q && sv.loc) return sv.loc;
  } catch (err) {
    console.warn('Storage read failed:', err);
  }
  let r: GeoResultItem | null = null;
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  const searchName = parts[0] || name;
  const rest = parts.slice(1).join(' ').toLowerCase();

  try {
    const res = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=20&language=en&format=json`);
    if (res.ok) {
      const d = await res.json() as { results?: GeoResultItem[] };
      r = wxPickGeoHit((d && d.results) || [], rest, cc);
    }
  } catch (err) {
    console.warn('Geocoding search failed:', err);
  }

  if ((!r || !isFinite(+Number(r.latitude))) && name.includes(' ')) {
    const words = name.split(/[\s,/-]+/).filter((w) => w.trim().length > 2);
    for (const w of words) {
      if (/^(depz|epz|zone|road|sector|block|area|thana|upazila)$/i.test(w)) continue;
      try {
        const subRes = await wxFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(w)}&count=10&language=en&format=json`);
        if (subRes.ok) {
          const subD = await subRes.json() as { results?: GeoResultItem[] };
          const hit = wxPickGeoHit((subD && subD.results) || [], '', cc);
          if (hit) {
            r = hit;
            break;
          }
        }
      } catch (err) {
        console.warn('Sub-geocoding search failed:', err);
      }
    }
  }

  if (!r || !isFinite(+Number(r.latitude)) || !isFinite(+Number(r.longitude))) return null;
  const loc: WeatherLocation = {
    lat: +Number(r.latitude),
    lon: +Number(r.longitude),
    city: r.name || name,
    cc: String(r.country_code || '').toUpperCase()
  };
  try {
    localStorage.setItem('inex.geo', JSON.stringify({ q, loc }));
  } catch (err) {
    console.warn('Storage write failed:', err);
  }
  return loc;
}

export async function detectLocation(): Promise<WeatherLocation | null> {
  const SET = loadSettings();
  const cityName = ((SET.weather && SET.weather.city) || '').trim();
  const lat = SET.weather ? SET.weather.lat : null;
  const lon = SET.weather ? SET.weather.lon : null;
  // A place chosen by coordinates keeps those coordinates; its name is only the label.
  const byCoords = Boolean(cityName && lat !== null && lon !== null && isFinite(+lat) && isFinite(+lon));
  const cityQ = byCoords ? `${cityName}|${lat}|${lon}` : cityName;
  if (cityQ) {
    if (weather.cityLoc && weather.cityQ === cityQ) return weather.cityLoc;
    if (byCoords && lat !== null && lon !== null) {
      weather.cityQ = cityQ;
      weather.cityLoc = { lat: +lat, lon: +lon, city: cityName, cc: '' };
      return weather.cityLoc;
    }
    try {
      const g = await geocodeCity(cityName);
      if (g) {
        weather.cityQ = cityQ;
        weather.cityLoc = g;
        return g;
      }
    } catch (err) {
      console.warn('City geocode error:', err);
    }
  }
  return detectIpLocation();
}

export function weatherWanted(): boolean {
  const SET = loadSettings();
  if (!(SET.weather && SET.weather.enabled)) return false;
  const compactNeedsWeather = ['weather', 'cycle'].includes(SET.notch?.compactContent || '');
  const isDeck = !SET.appearance || SET.appearance.menuLayout === 'deck';
  const deckNeedsWeather = isDeck && (!SET.deckMenu || SET.deckMenu.showWeather !== false);
  const w = SET.widgets || ({} as Partial<typeof SET.widgets>);
  const hoverNeedsWeather = w.enabled !== false && (w.left === 'weather' || w.right === 'weather');
  return compactNeedsWeather || deckNeedsWeather || hoverNeedsWeather;
}

export function fmtNet(b: number): string {
  if (!(b > 0)) return '0 K/s';
  const k = b / 1024;
  if (k < 1000) return Math.round(k) + ' K/s';
  const m = k / 1024;
  return (m >= 10 ? Math.round(m) : m.toFixed(1)) + ' M/s';
}

export function widgetHtml(kind: string | undefined): string {
  const SET = loadSettings();
  const s = appState.stats;
  const net = appState.net as [number, number] | undefined;
  switch (kind) {
    case 'weather': return SET.weather?.enabled ? `${getActiveWeatherIcon()}<span>${weather.text || '--'}</span>` : '';
    case 'ram': return s ? `RAM ${s.ram_pct}%` : '';
    case 'cpu': return s ? `CPU ${s.cpu_pct}%` : '';
    case 'gpu': return s ? `GPU ${s.gpu_pct ?? 0}%` : '';
    case 'disk': return s ? `Disk ${s.disk_pct}%` : '';
    case 'battery': return s && (s.battery_pct ?? -1) >= 0 ? `${s.battery_pct}%` : '';
    case 'net': return net ? `<span class="net2"><b>↓ ${fmtNet(net[0])}</b><b>↑ ${fmtNet(net[1])}</b></span>` : '';
    default: return '';
  }
}

export function syncDeckWeatherUI(): void {
  const SET = loadSettings();
  const pill = $('deck-weather');
  const tempEl = $('deck-weather-temp');
  if (!pill || !tempEl) return;
  const hasWx = !!(SET.weather && SET.weather.enabled && weather.text);
  tempEl.textContent = hasWx ? weather.text : '--°';
  pill.title = weather.place ? `${weather.condition || 'Weather'} • ${weather.place}` : 'Weather';
  const oldSvg = pill.querySelector('svg');
  if (hasWx && oldSvg) {
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

export function renderWidgets(): void {
  const SET = loadSettings();
  const on = SET.widgets?.enabled !== false;
  const left = on ? widgetHtml(SET.widgets?.left) : '';
  const right = on ? widgetHtml(SET.widgets?.right) : '';
  const cTemp = $('c-temp');
  const cRam = $('c-ram');
  if (cTemp) cTemp.innerHTML = left;
  if (cRam) cRam.innerHTML = right;
  $('c-left-box')?.classList.toggle('has-widget', !!left);
  $('c-right-box')?.classList.toggle('has-widget', !!right);
  island?.classList.toggle('no-hover-expand', !(left || right));

  if (cTemp) cTemp.title = SET.widgets?.left === 'weather' && weather.place ? `Forecast • ${weather.place}` : '';
  if (cRam) cRam.title = SET.widgets?.right === 'weather' && weather.place ? `Forecast • ${weather.place}` : '';

  const topLeft = $('top-left-label');
  const calLeft = $('cal-left-label');
  const topRam = $('top-ram-label');
  const calRam = $('cal-ram-label');
  if (topLeft) topLeft.innerHTML = left;
  if (calLeft) calLeft.innerHTML = left;
  if (topRam) topRam.innerHTML = right;
  if (calRam) calRam.innerHTML = right;
  syncDeckWeatherUI();
}

let lastWeatherAlertTime = 0;
let lastWeatherAlertKey = '';
try {
  const sv = JSON.parse(localStorage.getItem('inex.weather.alert') || 'null') as { t?: number; k?: string } | null;
  if (sv && typeof sv.t === 'number') {
    lastWeatherAlertTime = sv.t;
    lastWeatherAlertKey = String(sv.k || '');
  }
} catch (err) {
  console.warn('Storage read error:', err);
}

export function wxAlertFor(code: number, windKmh: number, aqi: number | null): { key: string; icon: string; title: string } | null {
  if (code === 95 || code === 96 || code === 99) return { key: 'storm', icon: 'cloud', title: 'Severe Thunderstorm Warning' };
  if (code === 75 || code === 86) return { key: 'snow', icon: 'cloud', title: 'Blizzard Warning' };
  if (code === 65 || code === 82) return { key: 'rain', icon: 'cloud', title: 'Heavy Rain Alert' };
  if (windKmh > 50) return { key: 'wind', icon: 'alert', title: 'High Wind Warning' };
  if (typeof aqi === 'number' && aqi > 150) return { key: 'aqi', icon: 'alert', title: 'Hazardous Air Quality Alert' };
  return null;
}

export async function weatherCheckAlerts(loc: WeatherLocation, code: number, windKmh: number): Promise<void> {
  const SET = loadSettings();
  if (!(SET.weather && SET.weather.alerts !== false)) return;
  let a = wxAlertFor(code, windKmh, null);
  if (!a) {
    let aqi: number | null = null;
    try {
      const r = await wxFetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}&longitude=${loc.lon}&current=us_aqi&timezone=auto`);
      if (r.ok) {
        const v = ((await r.json()) as { current?: { us_aqi?: number } })?.current?.us_aqi;
        if (typeof v === 'number') aqi = Math.round(v);
      }
    } catch (err) {
      console.warn('AQI fetch failed:', err);
    }
    a = wxAlertFor(code, windKmh, aqi);
  }
  if (!a) return;
  const now = Date.now();
  if (a.key === lastWeatherAlertKey && now - lastWeatherAlertTime < 30 * 60 * 1000) return;
  lastWeatherAlertKey = a.key;
  lastWeatherAlertTime = now;
  try {
    localStorage.setItem('inex.weather.alert', JSON.stringify({ k: a.key, t: now }));
  } catch (err) {
    console.warn('Storage write failed:', err);
  }
  if (!appState.transferring && !appState.prompting && !appState.lockerPrompting && !document.getElementById('anim-radar-card')) {
    bus.emit('toast:show', { icon: a.icon, title: a.title, ms: 4000 });
  }
}

export async function refreshWeather(): Promise<void> {
  if (weather.busy) return;
  weather.busy = true;
  try {
    const SET = loadSettings();
    if (!weatherWanted()) {
      weather.text = '';
      weather.at = 0;
      weather.key = '';
      renderWidgets();
      return;
    }
    const unit = SET.weather?.unit === 'F' ? 'F' : 'C';
    const loc = await detectLocation();
    if (!loc) {
      weather.text = '';
      weather.place = '';
      weather.at = 0;
      weather.key = '';
      renderWidgets();
      return;
    }
    const ck = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
    const key = `${ck}|${unit}`;
    if (weather.text && weather.key === key && Date.now() - weather.at < 20 * 60 * 1000) return;
    weather.key = key;
    weather.at = Date.now();

    let tempStr = '';
    let code = 0;
    let isDay = true;
    let windKmh = 0;
    weather.precip = 0;
    weather.rain = 0;

    try {
      const unitParam = unit === 'F' ? '&temperature_unit=fahrenheit' : '';
      const wRes = await wxFetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day,precipitation,rain,showers,wind_speed_10m&wind_speed_unit=kmh&timezone=auto${unitParam}`);
      if (wRes.ok) {
        const wData = await wRes.json();
        const tVal = wData?.current?.temperature_2m;
        if (typeof tVal === 'number') {
          tempStr = `${Math.round(tVal)}°${unit}`;
          code = wData.current.weather_code ?? 0;
          weather.code = code;
          isDay = wData.current.is_day === 1;
          weather.isDay = isDay;
          windKmh = +wData.current.wind_speed_10m || 0;
          weather.precip = +wData.current.precipitation || 0;
          weather.rain = (+wData.current.rain || 0) + (+wData.current.showers || 0);
        }
      }
    } catch (err) {
      console.warn('Weather fetch failed:', err);
    }

    if (!tempStr) {
      try {
        const r = await wxFetch(`https://wttr.in/${ck}?format=j1`);
        if (r.ok) {
          const cur = (await r.json())?.current_condition?.[0];
          const val = cur ? (unit === 'F' ? cur.temp_F : cur.temp_C) : undefined;
          if (val !== undefined) tempStr = `${Math.round(+val)}°${unit}`;
        }
      } catch (err) {
        console.warn('Fallback weather fetch failed:', err);
      }
    }

    if (!tempStr) {
      weather.text = '';
      weather.condition = 'Offline';
      weather.at = 0;
      updateClocks();
      renderWidgets();
      syncDeckWeatherUI();
      return;
    }

    const wx = wxResolve(code, isDay, weather.precip, weather.rain);
    weather.text = tempStr;
    weather.iconSvg = wx.svg;
    weather.condition = wx.text;
    weather.place = loc.city || '';
    updateClocks();
    renderWidgets();
    weatherCheckAlerts(loc, code, windKmh).catch((err) => console.warn('Weather check alert rejected:', err));
  } finally {
    weather.busy = false;
  }
}

// ================================================================================================
// Weather Deck (Control Deck expanded view cards)
// ================================================================================================
export const wxd: WeatherDeckState = {
  open: false, built: false, data: null, at: 0, busy: false, again: false, tick: 0, bgKey: '', lt: 0, skyDay: true, moonB: -1
};
const WXD_CACHE_KEY = 'inex.wxdeck';

function wxdEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

const WXD_AQI: Array<[number, string, string]> = [
  [50, 'Good', '#3fbf5f'], [100, 'Moderate', '#e8c52f'], [150, 'Unhealthy for some', '#f0892f'],
  [200, 'Unhealthy', '#e0453f'], [300, 'Very unhealthy', '#9a4fc1'], [500, 'Hazardous', '#8f2a45']
];
const WXD_UV: Array<[number, string, string]> = [
  [2, 'Low', '#3fbf5f'], [5, 'Moderate', '#e8c52f'], [7, 'High', '#f0892f'],
  [10, 'Very high', '#e0453f'], [99, 'Extreme', '#9a4fc1']
];

function wxdBand(table: Array<[number, string, string]>, v: number): { i: number; label: string; color: string } {
  for (let i = 0; i < table.length; i++) {
    if (v <= table[i][0]) return { i, label: table[i][1], color: table[i][2] };
  }
  const i = table.length - 1;
  return { i, label: table[i][1], color: table[i][2] };
}

const WXD_SUNRISE = '<svg viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 19h18"/><path d="M7 19a5 5 0 0 1 10 0"/><path d="M12 4v6"/><path d="M9.5 6.5L12 4l2.5 2.5"/></svg>';
const WXD_SUNSET = '<svg viewBox="0 0 24 24" fill="none" stroke="#f26b3a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 19h18"/><path d="M7 19a5 5 0 0 1 10 0"/><path d="M12 4v6"/><path d="M9.5 7.5L12 10l2.5-2.5"/></svg>';
const WXD_KNOB_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3L7 7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7"/></svg>';
const WXD_KNOB_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5z"/></svg>';
const WXD_I = (c: string, inner: string): string => '<svg viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
const WXD_ICONS = {
  hum: WXD_I('#4aa3df', '<path d="M12 3c3.5 4.2 6 7.2 6 10.5a6 6 0 0 1-12 0C6 10.2 8.5 7.2 12 3z"/>'),
  wind: WXD_I('#9a9aa6', '<path d="M3 8h10a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>'),
  uv: WXD_I('#9a9aa6', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>'),
  pres: WXD_I('#9a9aa6', '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-4"/>'),
  vis: WXD_I('#9a9aa6', '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>')
};

export function wxdBuild(): boolean {
  if (wxd.built) return true;
  const deck = wxdEl('view-control-deck');
  if (!deck) return false;
  const body = document.createElement('div');
  body.id = 'mx-weather-body';
  body.innerHTML =
    '<div class="mx-widget-card wxd-hero">' +
      '<div class="wxd-bg" id="wxd-bg" aria-hidden="true"></div>' +
      '<div class="wxd-sun-slider-card is-day-mode" id="wxd-slider">' +
        '<div class="wxd-sun-track-wrap"><div class="wxd-sun-track">' +
          '<div class="wxd-sun-fill" id="wxd-fill"></div><div class="wxd-sun-rest"></div>' +
          '<div class="wxd-sun-knob" id="wxd-knob"><i class="wxd-knob-celestial sun" id="wxd-knob-c"></i></div>' +
        '</div></div>' +
        '<div class="wxd-sun-footer">' +
          '<div class="wxd-sun-edge left"><span class="wxd-time-val" id="wxd-l-time">--</span>' +
            '<span class="wxd-sun-sub"><span class="wxd-sun-icon" id="wxd-ico-l">' + WXD_SUNRISE + '</span><span class="wxd-sun-label" id="wxd-lbl-l">Sunrise</span></span></div>' +
          '<span class="wxd-sun-mid" id="wxd-phase"></span>' +
          '<div class="wxd-sun-edge right"><span class="wxd-time-val" id="wxd-r-time">--</span>' +
            '<span class="wxd-sun-sub"><span class="wxd-sun-label" id="wxd-lbl-r">Sunset</span><span class="wxd-sun-icon" id="wxd-ico-r">' + WXD_SUNSET + '</span></span></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="mx-widget-card wxd-tempcard">' +
      '<div class="wg-head"><span>Weather</span><span id="wxd-place">--</span></div>' +
      '<div class="wxd-main"><span id="wxd-ico"></span><b id="wxd-temp">--</b></div>' +
      '<div class="wxd-cond" id="wxd-cond">--</div>' +
      '<div class="wxd-sub" id="wxd-sub">--</div>' +
      '<div class="wxd-aqi"><small>AQI</small><b id="wxd-aqi">--</b><span class="wxd-aqit" id="wxd-aqit"></span></div>' +
      '<div class="wxd-scale"><u id="wxd-aqi-mark" style="left:0%;display:none"></u></div>' +
    '</div>' +
    '<div class="mx-widget-card wxd-details">' +
      '<section class="wxd-page">' +
        '<div class="wg-head"><span>Details</span><span>Today</span></div>' +
        '<div class="wxd-rows">' +
          '<div class="wxd-row">' + WXD_ICONS.hum + '<span>Humidity</span><b id="wxd-hum">--</b></div>' +
          '<div class="wxd-row">' + WXD_ICONS.wind + '<span>Wind</span><b id="wxd-wind">--</b></div>' +
          '<div class="wxd-row">' + WXD_ICONS.uv + '<span>UV index</span><b id="wxd-uv">--</b></div>' +
          '<div class="wxd-row">' + WXD_ICONS.pres + '<span>Pressure</span><b id="wxd-pres">--</b></div>' +
          '<div class="wxd-row">' + WXD_ICONS.vis + '<span>Visibility</span><b id="wxd-vis">--</b></div>' +
        '</div>' +
      '</section>' +
      '<section class="wxd-page">' +
        '<div class="wg-head"><span>Forecast</span><span>5 days</span></div>' +
        '<div class="wxd-fc" id="wxd-fc"></div>' +
      '</section>' +
    '</div>';
  deck.appendChild(body);
  wxd.built = true;
  return true;
}

export function wxdFmt12(str: string): string {
  if (!str || str.length < 16) return '--';
  let h = parseInt(str.slice(11, 13), 10);
  const m = str.slice(14, 16);
  if (isNaN(h)) return '--';
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return h + ':' + m + ' ' + ap;
}

export function wxdClearView(): void {
  wxd.bgKey = '';
  ['wxd-place', 'wxd-temp', 'wxd-cond', 'wxd-sub', 'wxd-aqi', 'wxd-hum', 'wxd-wind', 'wxd-uv', 'wxd-pres', 'wxd-vis', 'wxd-dew', 'wxd-l-time', 'wxd-r-time']
    .forEach((id) => {
      const e = wxdEl(id);
      if (e) { e.textContent = '--'; e.style.color = ''; }
    });
  const t = wxdEl('wxd-aqit'); if (t) t.textContent = '';
  const m = wxdEl('wxd-aqi-mark'); if (m) m.classList.add('hidden');
  const ico = wxdEl('wxd-ico'); if (ico) ico.innerHTML = '';
  const bg = wxdEl('wxd-bg'); if (bg) { bg.innerHTML = ''; bg.className = 'wxd-bg'; }
  const sl = wxdEl('wxd-slider'); if (sl) sl.style.setProperty('--p', '0');
  const fcl = wxdEl('wxd-fc'); if (fcl) fcl.innerHTML = '';
  const ph = wxdEl('wxd-phase'); if (ph) ph.textContent = '';
}

export function wxdDropData(): void {
  wxd.data = null;
  wxd.at = 0;
  wxd.bgKey = '';
  try { localStorage.removeItem(WXD_CACHE_KEY); } catch (err) { console.warn('Cache clear error:', err); }
}

const wxdTexCache: Record<string, unknown> = {};
const wxdSS = (a: number, b: number, v: number): number => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const wxdCl = (v: number, a?: number, b?: number): number => Math.max(a === undefined ? 0 : a, Math.min(b === undefined ? 1 : b, v));
const wxdMixC = (c1: number[], c2: number[], t: number): number[] => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
const wxdRGB = (c: number[]): string => Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]);

function wxdRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function wxdMakeFbm(seed: number, oct: number, gx0: number, gy0: number): (x: number, y: number) => number {
  let a = seed >>> 0;
  const rnd = (): number => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const L: Float32Array[] = [];
  for (let o = 0; o < oct; o++) {
    const gx = gx0 << o;
    const gy = gy0 << o;
    const arr = new Float32Array(gx * (gy + 1));
    for (let i = 0; i < arr.length; i++) arr[i] = rnd();
    L.push(arr);
  }
  const sm = (t: number): number => t * t * (3 - 2 * t);
  return function (x: number, y: number): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      const gx = gx0 << o;
      const gy = gy0 << o;
      const fx = x * gx;
      const fy = y * gy;
      const ix = Math.floor(fx);
      const iy = Math.min(gy - 1, Math.floor(fy));
      const tx = sm(fx - ix);
      const ty = sm(fy - iy);
      const x0 = ((ix % gx) + gx) % gx;
      const x1 = (x0 + 1) % gx;
      const arr = L[o];
      const v0 = arr[iy * gx + x0] * (1 - tx) + arr[iy * gx + x1] * tx;
      const v1 = arr[(iy + 1) * gx + x0] * (1 - tx) + arr[(iy + 1) * gx + x1] * tx;
      sum += (v0 * (1 - ty) + v1 * ty) * amp;
      norm += amp;
      amp *= 0.54;
    }
    return sum / norm;
  };
}

function wxdCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function wxdUrl(c: HTMLCanvasElement, q?: number): string {
  let u = '';
  try { u = c.toDataURL('image/webp', q || 0.85); } catch (err) { console.warn('Canvas export failed:', err); }
  return u ? 'url(' + u + ')' : '';
}

function wxdCloudTex(thr: number, seed: number): { a: string; l: string } | null {
  const key = 'c' + thr + '|' + seed;
  if (wxdTexCache[key]) return wxdTexCache[key] as { a: string; l: string };
  const W = 256;
  const H = 96;
  const ca = wxdCanvas(W, H);
  const cs = wxdCanvas(W, H);
  const xa = ca.getContext('2d');
  const xs = cs.getContext('2d');
  if (!xa || !xs) return null;
  const ia = xa.createImageData(W, H);
  const is = xs.createImageData(W, H);
  const da = ia.data;
  const ds = is.data;
  const main = wxdMakeFbm(seed, 5, 4, 3);
  const warp = wxdMakeFbm(seed + 77, 3, 3, 2);
  const lit = wxdMakeFbm(seed + 191, 4, 5, 3);
  for (let py = 0; py < H; py++) {
    const y = py / (H - 1);
    const env = (1 - wxdSS(0.5, 1, y)) * wxdSS(0, 0.16, y);
    for (let px = 0; px < W; px++) {
      const x = px / W;
      const w = warp(x, y) - 0.5;
      const xx = (x + 0.10 * w + 1) % 1;
      const yy = wxdCl(y + 0.14 * w);
      const n = main(xx, yy);
      const nu = main(xx, wxdCl(yy - 0.05));
      const nd = main(xx, wxdCl(yy + 0.05));
      const al = wxdSS(thr, thr + 0.26, n) * env;
      const sh = wxdCl(0.56 + (nd - nu) * 7 + (lit(x, y) - 0.5) * 0.55 - wxdSS(0.45, 0.95, y) * 0.26);
      const i = (py * W + px) * 4;
      da[i] = da[i + 1] = da[i + 2] = 255;
      da[i + 3] = al * 255;
      ds[i] = ds[i + 1] = ds[i + 2] = 255;
      ds[i + 3] = al * sh * 255;
    }
  }
  xa.putImageData(ia, 0, 0);
  xs.putImageData(is, 0, 0);
  return (wxdTexCache[key] = { a: wxdUrl(ca), l: wxdUrl(cs) }) as { a: string; l: string };
}

function wxdWispTex(seed: number): string {
  const key = 'w' + seed;
  if (wxdTexCache[key]) return wxdTexCache[key] as string;
  const W = 320;
  const H = 96;
  const c = wxdCanvas(W, H);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const main = wxdMakeFbm(seed, 4, 2, 7);
  const warp = wxdMakeFbm(seed + 31, 3, 2, 3);
  for (let py = 0; py < H; py++) {
    const y = py / (H - 1);
    const env = wxdSS(0, 0.22, y) * (1 - wxdSS(0.74, 1, y));
    for (let px = 0; px < W; px++) {
      const x = px / W;
      const w = warp(x, y) - 0.5;
      const n = main((x + 0.25 * w + 1) % 1, wxdCl(y + 0.1 * w));
      const i = (py * W + px) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = wxdSS(0.5, 0.8, n) * env * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return (wxdTexCache[key] = wxdUrl(c, 0.8)) as string;
}

function wxdFogTex(seed: number): string {
  const key = 'f' + seed;
  if (wxdTexCache[key]) return wxdTexCache[key] as string;
  const W = 320;
  const H = 80;
  const c = wxdCanvas(W, H);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const main = wxdMakeFbm(seed, 4, 2, 3);
  for (let py = 0; py < H; py++) {
    const y = py / (H - 1);
    const env = wxdSS(0, 0.4, y) * (1 - wxdSS(0.55, 1, y));
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = (0.25 + 0.75 * wxdSS(0.3, 0.75, main(px / W, y))) * env * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return (wxdTexCache[key] = wxdUrl(c, 0.8)) as string;
}

function wxdRainTex(n: number, seed: number, kind?: string, lmin?: number, lmax?: number, lw?: number): string {
  const key = 'r' + n + '|' + (kind || 'm') + '|' + seed;
  if (wxdTexCache[key]) return wxdTexCache[key] as string;
  const W = 64;
  const H = 256;
  const c = wxdCanvas(W, H);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const rnd = wxdRng(seed);
  const minL = lmin || 14;
  const maxL = lmax || 28;
  const baseW = lw || 0.95;
  for (let i = 0; i < n; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const len = minL + rnd() * (maxL - minL);
    const a = (kind === 'heavy' || kind === 'storm') ? (0.55 + rnd() * 0.25) : (kind === 'drizzle') ? (0.28 + rnd() * 0.24) : (0.42 + rnd() * 0.26);
    const w = baseW * (0.85 + rnd() * 0.35);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const x0 = x + ox * W;
        const y0 = y + oy * H;
        const x1 = x0 - len * 0.16;
        const y1 = y0 + len;
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.45, 'rgba(255,255,255,' + (a * 0.45).toFixed(2) + ')');
        g.addColorStop(1, 'rgba(255,255,255,' + a.toFixed(2) + ')');
        ctx.strokeStyle = g;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }
  return (wxdTexCache[key] = wxdUrl(c, 0.88)) as string;
}

function wxdSnowTex(n: number, seed: number): string {
  const key = 's' + n + '|' + seed;
  if (wxdTexCache[key]) return wxdTexCache[key] as string;
  const S = 128;
  const c = wxdCanvas(S, S);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const rnd = wxdRng(seed);
  for (let i = 0; i < n; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 0.9 + rnd() * rnd() * 2.6;
    const a = 0.55 + rnd() * 0.45;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const g = ctx.createRadialGradient(x + ox * S, y + oy * S, 0, x + ox * S, y + oy * S, r);
        g.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(2) + ')');
        g.addColorStop(0.55, 'rgba(255,255,255,' + (a * 0.6).toFixed(2) + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox * S - r, y + oy * S - r, r * 2, r * 2);
      }
    }
  }
  return (wxdTexCache[key] = wxdUrl(c, 0.9)) as string;
}

function wxdRippleTex(): string {
  if (wxdTexCache.rip) return wxdTexCache.rip as string;
  const c = wxdCanvas(64, 12);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 0.8;
  ([[10, 4, 5], [34, 8, 8], [54, 5, 4], [22, 9, 3]] as Array<[number, number, number]>).forEach(([x, y, r]) => {
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.32, 0, 0, 6.2832);
    ctx.stroke();
  });
  return (wxdTexCache.rip = wxdUrl(c, 0.9)) as string;
}

function wxdStarTex(kind: string): string {
  const key = 'st' + kind;
  if (wxdTexCache[key]) return wxdTexCache[key] as string;
  const W = 240;
  const H = 260;
  const c = wxdCanvas(W, H);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const rnd = wxdRng(kind === 's' ? 11 : kind === 'a' ? 23 : 37);
  const n = kind === 's' ? 54 : 13;
  const big = kind !== 's';
  for (let i = 0; i < n; i++) {
    const x = rnd() * W;
    const y = rnd() * H * 0.92;
    const hz = 1 - 0.8 * Math.pow(y / H, 2.4);
    const r = big ? 0.9 + rnd() * 0.9 : 0.5 + rnd() * 0.5;
    const a = (big ? 0.8 : 0.4 + rnd() * 0.4) * hz;
    if (big) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, 'rgba(220,230,255,' + (a * 0.45).toFixed(2) + ')');
      g.addColorStop(1, 'rgba(220,230,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    }
    ctx.fillStyle = 'rgba(235,240,255,' + a.toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    ctx.fill();
  }
  return (wxdTexCache[key] = wxdUrl(c, 0.9)) as string;
}

let wxdMoonAlb: { S: number; alb: Float32Array; nrm: Float32Array } | null = null;
function wxdMoonBase(): { S: number; alb: Float32Array; nrm: Float32Array } {
  if (wxdMoonAlb) return wxdMoonAlb;
  const S = 96;
  const alb = new Float32Array(S * S);
  const nrm = new Float32Array(S * S * 3);
  const rnd = wxdRng(54321);
  const maria = [
    [-0.38, -0.06, 0.36, 0.42, 0.34],
    [-0.18, -0.32, 0.26, 0.22, 0.38],
    [0.20, -0.28, 0.20, 0.18, 0.36],
    [0.32, -0.06, 0.24, 0.22, 0.40],
    [0.60, -0.20, 0.14, 0.12, 0.44],
    [0.42, 0.20, 0.22, 0.20, 0.35],
    [-0.18, 0.34, 0.22, 0.20, 0.32],
    [-0.42, 0.30, 0.14, 0.14, 0.30]
  ];
  const craters = [
    [-0.12, 0.65, 0.065, 0.42],
    [-0.24, -0.12, 0.07, 0.28],
    [-0.45, -0.08, 0.05, 0.24],
    [-0.52, -0.30, 0.045, 0.38]
  ];
  const micro: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 40; i++) {
    const a = rnd() * 6.2832;
    const r = Math.sqrt(rnd()) * 0.90;
    micro.push([Math.cos(a) * r, Math.sin(a) * r, 0.02 + rnd() * rnd() * 0.08, (rnd() - 0.45) * 0.18]);
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5) / S * 2 - 1;
      const ny = (y + 0.5) / S * 2 - 1;
      const rr = Math.sqrt(nx * nx + ny * ny);
      const i = y * S + x;
      if (rr >= 1) { alb[i] = -1; continue; }
      const nz = Math.sqrt(1 - rr * rr);
      let a = 0.88 - 0.08 * (1 - nz);
      for (let k = 0; k < maria.length; k++) {
        const m = maria[k];
        const dx = (nx - m[0]) / m[2];
        const dy = (ny - m[1]) / m[3];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1.25) a -= wxdSS(1.25, 0.45, d) * m[4];
      }
      for (let k = 0; k < craters.length; k++) {
        const c = craters[k];
        const d = Math.sqrt((nx - c[0]) ** 2 + (ny - c[1]) ** 2) / c[2];
        if (d < 2.0) a += wxdSS(2.0, 0.3, d) * c[3];
      }
      const tdx = nx - craters[0][0];
      const tdy = ny - craters[0][1];
      const tr = Math.sqrt(tdx * tdx + tdy * tdy);
      if (tr > 0.06 && tr < 0.9) {
        const ang = Math.atan2(tdy, tdx);
        const ray = Math.pow(Math.sin(ang * 8), 6) * wxdSS(0.9, 0.08, tr);
        a += ray * 0.18;
      }
      for (let k = 0; k < micro.length; k++) {
        const m = micro[k];
        const d = Math.sqrt((nx - m[0]) ** 2 + (ny - m[1]) ** 2) / m[2];
        if (d < 1.4) a += wxdSS(1.4, 0.6, d) * m[3];
      }
      alb[i] = Math.max(0.25, Math.min(1.0, a));
      nrm[i * 3] = nx;
      nrm[i * 3 + 1] = ny;
      nrm[i * 3 + 2] = nz;
    }
  }
  return (wxdMoonAlb = { S, alb, nrm });
}

function wxdMoonTex(p: number): string {
  const b = Math.round(p * 40) % 40;
  const key = 'm' + b;
  if (wxdTexCache[key]) return wxdTexCache[key] as string;
  const M = wxdMoonBase();
  const S = M.S;
  const c = wxdCanvas(S, S);
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const th = (b / 40) * 6.2832;
  const Lx = Math.sin(th);
  const Lz = -Math.cos(th);
  for (let i = 0; i < S * S; i++) {
    if (M.alb[i] < 0) continue;
    const nx = M.nrm[i * 3];
    const nz = M.nrm[i * 3 + 2];
    const rr = Math.sqrt(nx * nx + M.nrm[i * 3 + 1] ** 2);
    const dot = nx * Lx + nz * Lz;
    const litK = wxdSS(-0.04, 0.08, dot);
    const shade = 0.82 + 0.18 * Math.max(0, dot);
    const val = Math.max(0, Math.min(1, M.alb[i] * litK * shade * 1.35));
    d[i * 4] = Math.min(255, val * 242);
    d[i * 4 + 1] = Math.min(255, val * 246);
    d[i * 4 + 2] = Math.min(255, val * 255);
    d[i * 4 + 3] = Math.min(255, (1 - rr) * 64 * 255) * litK;
  }
  ctx.putImageData(img, 0, 0);
  return (wxdTexCache[key] = wxdUrl(c, 0.9)) as string;
}

function wxdMoonCalc(ms: number): { p: number; k: number; name: string } {
  const syn = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const p = ((((ms - ref) / 86400000) % syn) + syn) % syn / syn;
  const k = (1 - Math.cos(p * 6.2832)) / 2;
  let name: string;
  if (p < 0.0339 || p >= 0.9661) name = 'New moon';
  else if (p < 0.2161) name = 'Waxing crescent';
  else if (p < 0.2839) name = 'First quarter';
  else if (p < 0.4661) name = 'Waxing gibbous';
  else if (p < 0.5339) name = 'Full moon';
  else if (p < 0.7161) name = 'Waning gibbous';
  else if (p < 0.7839) name = 'Last quarter';
  else name = 'Waning crescent';
  return { p, k, name };
}

interface PaletteStop {
  m: number;
  top: number[];
  mid: number[];
  bot: number[];
  L: number[];
  S: number[];
  gc: number[];
  ga: number;
  sc: number[];
  wp: number[];
}

const WXD_STOPS: PaletteStop[] = [
  { m: -80, top: [6, 10, 30], mid: [10, 18, 52], bot: [20, 34, 82], L: [104, 122, 170], S: [26, 36, 68], gc: [90, 70, 150], ga: 0, sc: [255, 240, 200], wp: [168, 172, 236] },
  { m: -42, top: [12, 18, 54], mid: [28, 32, 88], bot: [60, 48, 116], L: [128, 124, 178], S: [36, 40, 84], gc: [120, 84, 170], ga: 0.18, sc: [255, 200, 150], wp: [190, 170, 230] },
  { m: -16, top: [26, 36, 98], mid: [82, 62, 138], bot: [198, 100, 112], L: [236, 152, 140], S: [72, 60, 120], gc: [255, 120, 84], ga: 0.50, sc: [255, 110, 50], wp: [255, 170, 170] },
  { m: 0, top: [40, 68, 148], mid: [138, 104, 162], bot: [250, 152, 92], L: [255, 196, 140], S: [112, 94, 142], gc: [255, 160, 84], ga: 0.62, sc: [255, 126, 58], wp: [255, 196, 160] },
  { m: 22, top: [34, 84, 174], mid: [108, 142, 202], bot: [246, 192, 132], L: [255, 228, 192], S: [128, 142, 190], gc: [255, 200, 130], ga: 0.34, sc: [255, 196, 118], wp: [255, 232, 214] },
  { m: 62, top: [24, 92, 202], mid: [62, 140, 224], bot: [152, 202, 238], L: [255, 255, 255], S: [150, 176, 212], gc: [255, 226, 170], ga: 0.06, sc: [255, 234, 170], wp: [255, 255, 255] },
  { m: 130, top: [22, 88, 206], mid: [58, 140, 228], bot: [154, 204, 240], L: [255, 255, 255], S: [148, 174, 212], gc: [255, 226, 170], ga: 0, sc: [255, 244, 205], wp: [255, 255, 255] }
];

function wxdPalette(m: number): PaletteStop {
  const S = WXD_STOPS;
  if (m <= S[0].m) return S[0];
  if (m >= S[S.length - 1].m) return S[S.length - 1];
  let i = 0;
  while (m > S[i + 1].m) i++;
  const a = S[i];
  const b = S[i + 1];
  const t = wxdSS(0, 1, (m - a.m) / (b.m - a.m));
  return {
    m,
    top: wxdMixC(a.top, b.top, t),
    mid: wxdMixC(a.mid, b.mid, t),
    bot: wxdMixC(a.bot, b.bot, t),
    L: wxdMixC(a.L, b.L, t),
    S: wxdMixC(a.S, b.S, t),
    gc: wxdMixC(a.gc, b.gc, t),
    sc: wxdMixC(a.sc, b.sc, t),
    wp: wxdMixC(a.wp, b.wp, t),
    ga: a.ga + (b.ga - a.ga) * t
  };
}

function wxdWxCol(c: number[], g: number, dk: number, tint: number[] | undefined, tk: number | undefined, dayk: number): number[] {
  const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  let r = [0, 1, 2].map((i) => (c[i] + (l - c[i]) * g) * dk);
  if (tk && tint) {
    const f = 0.25 + 0.75 * dayk;
    r = r.map((x, i) => x + (tint[i] * f - x) * tk);
  }
  return r;
}

const WXD_CL: Record<string, number[][]> = {
  few: [[0.64, 1000, 300, 100, -2, 38, 0.85]],
  partly: [[0.52, 1626, 230, 84, 34, 46, 0.85], [0.41, 1000, 360, 136, -20, 30, 0.95], [0.46, 1313, 280, 108, 20, 22, 0.9]],
  overcast: [[0.30, 1626, 280, 120, 38, 40, 0.9], [0.28, 1000, 380, 150, -22, 28, 0.98], [0.31, 1313, 300, 130, 6, 20, 0.95]],
  drizzle: [[0.27, 1626, 280, 120, 36, 38, 0.92], [0.24, 1000, 380, 150, -24, 26, 0.98], [0.27, 1313, 300, 130, 4, 18, 0.95]],
  rain: [[0.25, 1626, 280, 124, 34, 34, 0.95], [0.22, 1000, 380, 156, -26, 24, 1], [0.25, 1313, 300, 132, 2, 16, 1]],
  heavy: [[0.22, 1626, 280, 128, 34, 28, 1], [0.19, 1000, 380, 160, -28, 20, 1], [0.22, 1313, 300, 136, 0, 14, 1]],
  storm: [[0.20, 1626, 280, 130, 32, 24, 1], [0.17, 1000, 380, 164, -30, 17, 1], [0.20, 1313, 300, 138, -2, 12, 1]],
  snow: [[0.40, 1626, 280, 110, 30, 42, 0.8], [0.36, 1000, 380, 140, -16, 28, 0.9]],
  fog: [[0.52, 1000, 380, 120, -10, 35, 0.45]]
};

interface RainSpec {
  kind: string;
  count: number;
  du: number[];
  op: number;
  len: number[];
  lw: number;
  mist: number;
  rip: number;
}

interface WxVisualSpec {
  g: number;
  dk: number;
  cg: number;
  cdk: number;
  cover: number;
  d: number;
  gl: number;
  fl: number;
  rim: number;
  hz: number;
  wisp: number;
  rn?: RainSpec;
  storm?: number;
  tint?: number[];
  tk?: number;
  snow?: number;
  fog?: number;
}

const WXD_WX: Record<string, WxVisualSpec> = {
  clear: { g: 0, dk: 1, cg: 0, cdk: 1, cover: 0, d: 1, gl: 1, fl: 1, rim: 0.5, hz: 1, wisp: 0.22 },
  few: { g: 0.04, dk: 1, cg: 0, cdk: 1, cover: 0.12, d: 1, gl: 1, fl: 0.9, rim: 0.75, hz: 1, wisp: 0.45 },
  partly: { g: 0.14, dk: 0.97, cg: 0.04, cdk: 1, cover: 0.45, d: 1, gl: 0.9, fl: 0.65, rim: 1, hz: 0.95, wisp: 0.65 },
  overcast: { g: 0.62, dk: 0.80, cg: 0.58, cdk: 0.80, cover: 0.95, d: 0, gl: 0.55, fl: 0, rim: 0.5, hz: 0.5, wisp: 0 },
  drizzle: { g: 0.72, dk: 0.70, cg: 0.72, cdk: 0.66, cover: 1, d: 0, gl: 0.22, fl: 0, rim: 0.2, hz: 0.3, wisp: 0, rn: { kind: 'drizzle', count: 12, du: [2.2, 1.7, 1.3], op: 0.5, len: [8, 16], lw: 0.8, mist: 0.15, rip: 0.3 } },
  rain: { g: 0.80, dk: 0.60, cg: 0.80, cdk: 0.54, cover: 1, d: 0, gl: 0.12, fl: 0, rim: 0.12, hz: 0.2, wisp: 0, rn: { kind: 'rain', count: 18, du: [1.4, 1.1, 0.85], op: 0.65, len: [14, 28], lw: 0.95, mist: 0.35, rip: 0.55 } },
  heavy: { g: 0.85, dk: 0.52, cg: 0.85, cdk: 0.44, cover: 1, d: 0, gl: 0.06, fl: 0, rim: 0.05, hz: 0.12, wisp: 0, rn: { kind: 'heavy', count: 26, du: [1.0, 0.78, 0.60], op: 0.8, len: [20, 36], lw: 1.15, mist: 0.55, rip: 0.75 } },
  storm: { g: 0.90, dk: 0.40, cg: 0.92, cdk: 0.30, cover: 1, d: 0, gl: 0, fl: 0, rim: 0, hz: 0.05, wisp: 0, rn: { kind: 'storm', count: 30, du: [0.85, 0.68, 0.52], op: 0.88, len: [24, 42], lw: 1.25, mist: 0.65, rip: 0.85 }, storm: 1 },
  snow: { g: 0.62, dk: 0.92, cg: 0.66, cdk: 0.92, cover: 0.9, d: 0, gl: 0.30, fl: 0, rim: 0.2, hz: 0.4, wisp: 0, tint: [176, 190, 214], tk: 0.28, snow: 1 },
  fog: { g: 0.82, dk: 0.86, cg: 0.80, cdk: 0.9, cover: 0.85, d: 0.28, gl: 0.45, fl: 0, rim: 0.1, hz: 0.5, wisp: 0, tint: [168, 174, 186], tk: 0.4, fog: 1 }
};
const WXD_KIND: Record<string, string> = { clear: 'clear', few: 'clear', partly: 'clear', overcast: 'cloud', drizzle: 'rain', rain: 'rain', heavy: 'rain', storm: 'rain', snow: 'snow', fog: 'fog' };

function wxdBgSpec(v: WeatherDeckData): WxVisualSpec & { wx: string; kind: string; cl: number[][] | null } {
  const code = +v.code || 0;
  const mm = Math.max(+v.precip || 0, +v.rain || 0);
  const r = wxResolve(code, v.isDay !== false, v.precip, v.rain);
  const condText = (r && r.text ? r.text.toLowerCase() : '');
  let wx = 'clear';
  if ((r && r.kind === 'storm') || [95, 96, 99].indexOf(code) >= 0) wx = 'storm';
  else if ((r && r.kind === 'rain') || (WX_RAIN_CODES(code)) || mm > 0) {
    const isHeavy = [65, 67, 82].indexOf(code) >= 0 || mm >= 3.0 || condText.indexOf('heavy') >= 0 || condText.indexOf('violent') >= 0;
    const isDrizzle = !isHeavy && ([51, 53, 55, 56, 57, 61].indexOf(code) >= 0 || condText.indexOf('drizzle') >= 0 || condText.indexOf('light') >= 0 || (mm > 0 && mm < 1.0));
    wx = isHeavy ? 'heavy' : isDrizzle ? 'drizzle' : 'rain';
  } else if ((code >= 71 && code <= 77) || code === 85 || code === 86) wx = 'snow';
  else if (code === 45 || code === 48) wx = 'fog';
  else if (code === 3) wx = 'overcast';
  else if (code === 2) wx = 'partly';
  else if (code === 1) wx = 'few';
  return Object.assign({ wx, kind: WXD_KIND[wx], cl: WXD_CL[wx] || null }, WXD_WX[wx]);
}

function wxdNoAnim(): boolean {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  } catch (err) {
    console.warn('Media query error:', err);
  }
  return !!document.querySelector('.island.no-anim');
}

function wxdBolt(on: number): void {
  if (!on || !wxd.open || wxdNoAnim()) {
    clearTimeout(wxd.lt);
    wxd.lt = 0;
    return;
  }
  if (wxd.lt) return;
  const go = (first: boolean): void => {
    wxd.lt = setTimeout(() => {
      wxd.lt = 0;
      const bg = wxdEl('wxd-bg');
      const b = bg?.querySelector<HTMLElement>('i.bolt');
      if (!wxd.open || !bg || !b) return;
      b.style.setProperty('--bx', (12 + Math.random() * 58).toFixed(0) + '%');
      b.style.setProperty('--bf', String(Math.random() < 0.5 ? -1 : 1));
      bg.classList.remove('zap');
      void bg.offsetWidth;
      bg.classList.add('zap');
      go(false);
    }, first ? 1500 + Math.random() * 2500 : 5000 + Math.random() * 7000);
  };
  go(true);
}

function wxdSkyState(v: WeatherDeckData | null): { now: number; day: boolean; t: number; m: number; lt: string; rt: string; early: boolean } | null {
  if (!v || !v.rises || !v.rises.length) return null;
  const k = v.ti || 0;
  const now = Date.now();
  let mode: 'day' | 'night';
  let a: number;
  let b: number;
  let lt: string;
  let rt: string;
  const has3 = v.rises.length >= 3 && v.sets.length >= 3;
  if (has3) {
    if (now < v.rises[k]) { mode = 'night'; a = v.sets[k - 1]; b = v.rises[k]; lt = v.setT[k - 1]; rt = v.riseT[k]; }
    else if (now <= v.sets[k]) { mode = 'day'; a = v.rises[k]; b = v.sets[k]; lt = v.riseT[k]; rt = v.setT[k]; }
    else { mode = 'night'; a = v.sets[k]; b = v.rises[k + 1]; lt = v.setT[k]; rt = v.riseT[k + 1]; }
  } else {
    const r = v.rises[0];
    const st = v.sets[0];
    if (now >= r && now <= st) { mode = 'day'; a = r; b = st; lt = v.riseT[0]; rt = v.setT[0]; }
    else { mode = 'night'; a = st; b = r + 86400000; lt = v.setT[0]; rt = v.riseT[0]; if (now < r) { a = st - 86400000; b = r; } }
  }
  if (!(b > a)) return null;
  const t = wxdCl((now - a) / (b - a));
  const day = mode === 'day';
  const toEv = Math.min(now - a, b - now) / 60000;
  return { now, day, t, m: day ? toEv : -toEv, lt, rt, early: t < 0.5 };
}

function wxdSet(id: string, txt: string): void {
  const e = wxdEl(id);
  if (e) e.textContent = txt;
}

export function wxdRenderSun(): void {
  const v = wxd.data;
  const st = wxdSkyState(v);
  if (!st || !v) return;
  wxd.skyDay = st.day;
  const bg = wxdEl('wxd-bg');
  const sp = wxdBgSpec(v);
  const s = bg ? bg.style : null;
  const W = (bg && bg.offsetWidth) || 162;
  const H = (bg && bg.offsetHeight) || 174;
  const t = st.t;
  const m = st.m;
  const dayk = wxdSS(-25, 45, m);
  const up = wxdCl(m / 70);
  if (s && bg) {
    const sx = W * (0.16 + 0.68 * t);
    const sy = 20 + 18 * Math.pow(2 * t - 1, 2);
    s.setProperty('--sx', sx.toFixed(1) + 'px');
    s.setProperty('--sy', sy.toFixed(1) + 'px');
    const cx = W * 0.5;
    const cy = H * 0.52;
    [[1, 0.38], [2, 0.70], [3, 1.02]].forEach(([n, k]) => {
      s.setProperty('--g' + n + 'x', (sx + (cx - sx) * k).toFixed(1) + 'px');
      s.setProperty('--g' + n + 'y', (sy + (cy - sy) * k).toFixed(1) + 'px');
    });
    s.setProperty('--hx', (t < 0.5 ? '4%' : '96%'));
    const P = wxdPalette(m);
    const wc = (c: number[], g: number, dk: number, tt: number[] | undefined, tk: number | undefined): string =>
      wxdRGB(wxdWxCol(c, g, dk, tt, tk, dayk));
    s.setProperty('--sk1', wc(P.top, sp.g, sp.dk, sp.tint, sp.tk));
    s.setProperty('--sk2', wc(P.mid, sp.g, sp.dk, sp.tint, sp.tk));
    s.setProperty('--sk3', wc(P.bot, sp.g, sp.dk, sp.tint, sp.tk));
    const cdk = sp.cdk + (1 - sp.cdk) * (1 - dayk) * 0.4;
    s.setProperty('--cL', wc(P.L, sp.cg, cdk, sp.tint, sp.tk));
    s.setProperty('--cS', wc(P.S, sp.cg, cdk * 0.92, sp.tint, sp.tk));
    s.setProperty('--wp', wxdRGB(P.wp));
    s.setProperty('--sc', wxdRGB(P.sc));
    s.setProperty('--gc', wxdRGB(P.gc));
    const rainC = wxdMixC([120, 142, 196], [204, 218, 238], dayk);
    const snowC = wxdMixC([196, 208, 238], [255, 255, 255], dayk);
    const fogC = wxdMixC([108, 118, 150], [214, 218, 226], dayk);
    s.setProperty('--rn', wxdRGB(rainC));
    s.setProperty('--sn', wxdRGB(snowC));
    s.setProperty('--fgc', wxdRGB(fogC));
    s.setProperty('--mc', wxdRGB(wxdMixC([60, 74, 108], [150, 166, 190], dayk)));
    const so = wxdSS(-6, -46, m) * (1 - sp.cover * 0.92);
    s.setProperty('--so', so.toFixed(3));
    s.setProperty('--gl', (P.ga * sp.hz).toFixed(3));
    s.setProperty('--dk', sp.d.toFixed(2));
    s.setProperty('--gk', (sp.gl * (0.62 + 0.38 * up)).toFixed(2));
    s.setProperty('--fk', (sp.fl * up).toFixed(2));
    s.setProperty('--rk', sp.rim.toFixed(2));
    s.setProperty('--wk', (0.85 * (1 - sp.cover * 0.5)).toFixed(2));
    bg.classList.toggle('is-day', st.day);
    bg.classList.toggle('is-night', !st.day);
  }
  const body = wxdEl('mx-weather-body');
  if (body) {
    body.classList.toggle('is-day', st.day);
    body.classList.toggle('is-night', !st.day);
  }
  const mc = wxdMoonCalc(st.now);
  if (s) {
    s.setProperty('--mk', (sp.gl * (0.3 + 0.7 * mc.k)).toFixed(2));
    s.setProperty('--mb', sp.d.toFixed(2));
  }
  const mb = bg?.querySelector<HTMLElement>('i.mg .mbo');
  const bkt = Math.round(mc.p * 40) % 40;
  if (mb && wxd.moonB !== bkt) {
    const u = wxdMoonTex(mc.p);
    if (u) { mb.style.backgroundImage = u; wxd.moonB = bkt; }
  }
  const pct = (t * 100).toFixed(1);
  const day = st.day;
  const card = wxdEl('wxd-slider');
  if (card) {
    card.style.setProperty('--p', pct);
    card.className = 'wxd-sun-slider-card ' + (day ? 'is-day-mode' : 'is-night-mode');
  }
  const kc = wxdEl('wxd-knob-c');
  if (kc) {
    const cls = 'wxd-knob-celestial ' + (day ? 'sun' : 'moon');
    if (kc.className !== cls || !kc.firstChild) {
      kc.className = cls;
      kc.innerHTML = day ? WXD_KNOB_SUN : WXD_KNOB_MOON;
    }
  }
  const il = wxdEl('wxd-ico-l');
  const ir = wxdEl('wxd-ico-r');
  if (il) il.innerHTML = day ? WXD_SUNRISE : WXD_SUNSET;
  if (ir) ir.innerHTML = day ? WXD_SUNSET : WXD_SUNRISE;
  wxdSet('wxd-lbl-l', day ? 'Sunrise' : 'Sunset');
  wxdSet('wxd-lbl-r', day ? 'Sunset' : 'Sunrise');
  wxdSet('wxd-phase', day ? '' : mc.name);
  wxdSet('wxd-l-time', st.lt);
  wxdSet('wxd-r-time', st.rt);
}

export function wxdApplyBg(): void {
  const bg = wxdEl('wxd-bg');
  const v = wxd.data;
  if (!bg || !v) return;
  const sp = wxdBgSpec(v);
  const south = (parseFloat((v.locKey || '').split(',')[0]) || 0) < 0;
  const hasSun = sp.d > 0 || sp.gl > 0;
  const hasMoon = hasSun;
  const hasStars = sp.cover < 1;
  const key = [sp.wx, south ? 's' : 'n'].join('-');
  const body = wxdEl('mx-weather-body');
  if (body) body.className = 'wxd-theme k-' + sp.kind + (wxd.skyDay === false ? ' is-night' : ' is-day');
  wxdBolt(sp.storm ? 1 : 0);
  if (wxd.bgKey === key) return;
  wxd.bgKey = key;
  bg.className = 'wxd-bg k-' + sp.kind + ' wx-' + sp.wx + (wxd.skyDay === false ? ' is-night' : ' is-day') + (south ? ' south' : '');
  let h = '';
  if (hasStars) h += '<i class="stars"><b class="s0"></b><b class="sa"></b><b class="sb"></b></i>';
  if (hasSun) h += '<i class="sg"><b class="sgl"></b><b class="srg"></b><b class="sco"></b></i><i class="bk b1"></i><i class="bk b2"></i><i class="bk b3"></i>';
  if (hasMoon) h += '<i class="mg"><b class="mgl"></b><b class="mbo"></b></i>';
  if (sp.wisp) h += '<i class="wp wp0"></i><i class="wp wp1"></i>';
  if (sp.fog) h += '<i class="fg f0"></i><i class="fg f1"></i><i class="fg f2"></i>';
  if (sp.cl) for (let i = 0; i < sp.cl.length; i++) { const c = sp.cl[i]; h += '<i class="cl" style="--w:' + c[2] + 'px;--t:' + c[5] + 's;top:' + c[4] + 'px;height:' + c[3] + 'px;opacity:' + c[6] + '"><b class="cs"></b><b class="cL"></b></i>'; }
  if (sp.rn) h += '<i class="rn r0"></i><i class="rn r1"></i><i class="rn r2"></i>';
  if (sp.snow) h += '<i class="sn n0"></i><i class="sn n1"></i><i class="sn n2"></i>';
  if (sp.storm) h += '<i class="bolt"></i>';
  if (hasSun) h += '<i class="srim"></i>';
  if (hasMoon) h += '<i class="mrim"></i>';
  h += '<i class="hz"></i>';
  if (sp.storm) h += '<i class="flash"></i>';
  if (sp.rn) h += '<i class="mist"></i><i class="rip"></i>';
  bg.innerHTML = h;

  const q = (s: string): HTMLElement | null => bg.querySelector<HTMLElement>(s);
  const setM = (el: HTMLElement | null, url: string): void => { if (el && url) el.style.setProperty('--m', url); };
  if (hasStars) {
    (['s0', 'sa', 'sb'] as const).forEach((k) => {
      const e = q('.stars .' + k);
      const u = wxdStarTex(k === 's0' ? 's' : k === 'sa' ? 'a' : 'b');
      if (e && u) e.style.backgroundImage = u;
    });
  }
  if (sp.cl) {
    const els = bg.querySelectorAll<HTMLElement>('i.cl');
    for (let i = 0; i < els.length; i++) {
      const tx = wxdCloudTex(sp.cl[i][0], sp.cl[i][1]);
      if (tx) {
        (els[i].querySelector('.cs') as HTMLElement | null)?.style.setProperty('--m', tx.a);
        (els[i].querySelector('.cL') as HTMLElement | null)?.style.setProperty('--m', tx.l);
      }
    }
  }
  const wps = bg.querySelectorAll<HTMLElement>('i.wp');
  for (let i = 0; i < wps.length; i++) setM(wps[i], wxdWispTex(500 + i * 211));
  const fgs = bg.querySelectorAll<HTMLElement>('i.fg');
  for (let i = 0; i < fgs.length; i++) setM(fgs[i], wxdFogTex(900 + i * 97));
  if (sp.rn) {
    const rspec = sp.rn;
    const sc = [0.7, 1, 1.35];
    const du = rspec.du;
    const op = [0.55 * rspec.op, 0.8 * rspec.op, rspec.op];
    const dn = [rspec.count, rspec.count, Math.round(rspec.count * 0.7)];
    const rs = bg.querySelectorAll<HTMLElement>('i.rn');
    for (let i = 0; i < rs.length; i++) {
      setM(rs[i], wxdRainTex(dn[i], 40 + i * 17, rspec.kind, rspec.len[0], rspec.len[1], rspec.lw));
      rs[i].style.cssText += '--tw:' + (64 * sc[i]).toFixed(1) + 'px;--th:' + (256 * sc[i]).toFixed(1) + 'px;--t:' + du[i] + 's;--ro:' + op[i].toFixed(2);
    }
    const rip = q('.rip');
    const mist = q('.mist');
    if (rip) { setM(rip, wxdRippleTex()); rip.style.opacity = rspec.rip.toFixed(2); }
    if (mist) { mist.style.opacity = rspec.mist.toFixed(2); }
  }
  if (sp.snow) {
    const sc = [0.6, 1, 1.5];
    const du = [17, 11, 7];
    const op = [0.55, 0.8, 1];
    const dn = [46, 30, 16];
    const ns = bg.querySelectorAll<HTMLElement>('i.sn');
    for (let i = 0; i < ns.length; i++) {
      setM(ns[i], wxdSnowTex(dn[i], 70 + i * 13));
      ns[i].style.cssText += '--tw:' + (128 * sc[i]).toFixed(1) + 'px;--th:' + (128 * sc[i]).toFixed(1) + 'px;--t:' + du[i] + 's;--ro:' + op[i];
    }
  }
  wxd.moonB = -1;
}

export function wxdRender(): void {
  if (!wxd.built) return;
  const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
  const v = isOffline ? null : wxd.data;
  if (!v) {
    wxdClearView();
    wxdSet('wxd-place', weather.place || 'Weather');
    wxdSet('wxd-temp', '--');
    wxdSet('wxd-cond', isOffline ? 'Offline' : 'Connecting...');
    wxdSet('wxd-sub', isOffline ? 'No Internet Connection' : 'Fetching live weather...');
    return;
  }
  const deg = (n: number | null): string => (n === null || n === undefined ? '--' : Math.round(n) + '\u00b0');
  const wmo = wxResolve(v.code, v.isDay, v.precip, v.rain);
  const ico = wxdEl('wxd-ico');
  if (ico && wmo) ico.innerHTML = wmo.svg;
  wxdSet('wxd-place', v.place || '--');
  wxdSet('wxd-temp', deg(v.temp) + (v.temp === null ? '' : v.unit));
  wxdSet('wxd-cond', wmo ? wmo.text : '--');
  wxdRenderSun();
  wxdApplyBg();
  wxdSet('wxd-sub', 'Feels ' + deg(v.feels) + ' \u00b7 H' + deg(v.hi) + ' L' + deg(v.lo));

  const aqiEl = wxdEl('wxd-aqi');
  const aqiT = wxdEl('wxd-aqit');
  const mark = wxdEl('wxd-aqi-mark');
  if (v.aqi === null) {
    if (aqiEl) { aqiEl.textContent = '--'; aqiEl.style.color = ''; }
    if (aqiT) aqiT.textContent = '';
    if (mark) mark.classList.add('hidden');
  } else {
    const b = wxdBand(WXD_AQI, v.aqi);
    if (aqiEl) { aqiEl.textContent = String(v.aqi); aqiEl.style.color = b.color; }
    if (aqiT) { aqiT.textContent = b.label; aqiT.style.color = b.color; }
    const lo = b.i === 0 ? 0 : WXD_AQI[b.i - 1][0] + 1;
    const hi = WXD_AQI[b.i][0];
    const pos = ((b.i + Math.min(1, (v.aqi - lo) / Math.max(1, hi - lo + 1))) / WXD_AQI.length) * 100;
    if (mark) {
      mark.style.left = Math.max(4, Math.min(96, pos)) + '%';
      mark.style.background = b.color;
      mark.classList.remove('hidden');
    }
  }
  wxdRenderSun();

  const f = v.unit === 'F';
  const hum = wxdEl('wxd-hum');
  if (hum) hum.innerHTML = v.hum === null ? '--' : Math.round(v.hum) + '<em>%</em>';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const wd = v.wdir === null ? '' : dirs[Math.round(v.wdir / 45) % 8] + ' ';
  const wind = wxdEl('wxd-wind');
  if (wind) wind.innerHTML = v.wind === null ? '--' : wd + Math.round(v.wind) + '<em>' + (f ? 'mph' : 'km/h') + '</em>';
  const uvEl = wxdEl('wxd-uv');
  if (uvEl) {
    if (v.uv === null) {
      uvEl.textContent = '--';
      uvEl.style.color = '';
    } else {
      const b = wxdBand(WXD_UV, v.uv);
      uvEl.innerHTML = Math.round(v.uv) + '<em>' + b.label + '</em>';
      uvEl.style.color = b.color;
      const uvEm = uvEl.querySelector<HTMLElement>('em');
      if (uvEm) uvEm.style.color = 'var(--menu-fg-dim)';
    }
  }
  const dew = wxdEl('wxd-dew');
  if (dew) {
    if (v.temp === null || v.hum === null || v.hum <= 0) dew.textContent = '--';
    else {
      const tc = f ? (v.temp - 32) * 5 / 9 : v.temp;
      const g = Math.log(v.hum / 100) + (17.62 * tc) / (243.12 + tc);
      const dc = (243.12 * g) / (17.62 - g);
      dew.innerHTML = Math.round(f ? dc * 9 / 5 + 32 : dc) + '<em>\u00b0' + v.unit + '</em>';
    }
  }
  const pres = wxdEl('wxd-pres');
  if (pres) pres.innerHTML = v.pres === null ? '--' : Math.round(v.pres) + '<em>hPa</em>';
  const vis = wxdEl('wxd-vis');
  if (vis) {
    if (v.vis === null) vis.textContent = '--';
    else {
      const km = v.vis / 1000;
      vis.innerHTML = (km >= 10 ? Math.round(km) : km.toFixed(1)) + '<em>km</em>';
    }
  }
  const fc = wxdEl('wxd-fc');
  if (fc) {
    const dn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    fc.innerHTML = (v.days || []).map((x, i) => {
      const r = wxResolve(x.code, true, 0, 0);
      const nm = i === 0 ? 'Today' : dn[new Date(x.t + 'T00:00:00Z').getUTCDay()];
      return '<div class="wxd-fd"><span>' + nm + '</span><i>' + (r ? r.svg : '') + '</i><b>' + deg(x.lo) + '<u>/</u>' + deg(x.hi) + '</b></div>';
    }).join('');
  }
}

export async function wxdFetchOnce(force?: boolean): Promise<void> {
  if (wxd.busy) { if (force) wxd.again = true; return; }
  const SET = loadSettings();
  const unit = (SET.weather && SET.weather.unit === 'F') ? 'F' : 'C';
  wxd.busy = true;
  try {
    const loc = await detectLocation();
    if (!loc) return;
    const lk = (+loc.lat).toFixed(2) + ',' + (+loc.lon).toFixed(2);
    if (wxd.data && wxd.data.locKey && wxd.data.locKey !== lk) {
      wxdDropData();
      if (wxd.built) wxdClearView();
    }
    if (!force && wxd.data && wxd.data.unit === unit && wxd.data.rises && wxd.data.days && wxd.data.locKey === lk && Date.now() - wxd.at < 10 * 60 * 1000) return;
    const f = unit === 'F';
    const uf = f ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '&wind_speed_unit=kmh';
    const u1 = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,precipitation,rain,showers,surface_pressure,wind_speed_10m,wind_direction_10m,visibility,uv_index' +
      '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&past_days=1&forecast_days=6' + uf;
    const u2 = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + loc.lat + '&longitude=' + loc.lon + '&current=us_aqi&timezone=auto';
    const [r1, r2] = await Promise.allSettled([wxFetch(u1), wxFetch(u2)]);
    let j1: Record<string, unknown> | null = null;
    let j2: Record<string, unknown> | null = null;
    try { if (r1.status === 'fulfilled' && r1.value.ok) j1 = await r1.value.json(); } catch (err) { console.warn('Forecast parse error:', err); }
    try { if (r2.status === 'fulfilled' && r2.value.ok) j2 = await r2.value.json(); } catch (err) { console.warn('AQI parse error:', err); }
    if (!j1 || !j1.current) return;
    const c = j1.current as Record<string, number>;
    const d = (j1.daily || {}) as {
      sunrise?: string[];
      sunset?: string[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      weather_code?: number[];
      time?: string[];
    };
    const off = (j1.utc_offset_seconds as number | undefined) || 0;
    const riseA = d.sunrise || [];
    const setA = d.sunset || [];
    const ti = riseA.length >= 3 && setA.length >= 3 ? 1 : 0;
    const msOf = (a: string[]): number[] => a.map((x) => Date.parse(x + 'Z') - off * 1000);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const j2Cur = (j2 && (j2.current as { us_aqi?: number } | undefined)) || undefined;
    wxd.data = {
      unit, locKey: lk, place: loc.city || weather.place || '',
      temp: num(c.temperature_2m), feels: num(c.apparent_temperature), hum: num(c.relative_humidity_2m),
      code: c.weather_code || 0, isDay: c.is_day === 1, precip: num(c.precipitation) || 0, rain: (num(c.rain) || 0) + (num(c.showers) || 0), pres: num(c.surface_pressure),
      wind: num(c.wind_speed_10m), wdir: num(c.wind_direction_10m), vis: num(c.visibility), uv: num(c.uv_index),
      hi: d.temperature_2m_max ? num(d.temperature_2m_max[ti]) : null, lo: d.temperature_2m_min ? num(d.temperature_2m_min[ti]) : null,
      days: (d.time || []).slice(ti, ti + 5).map((t, n) => ({ t, code: d.weather_code ? d.weather_code[ti + n] : 0, hi: d.temperature_2m_max ? num(d.temperature_2m_max[ti + n]) : null, lo: d.temperature_2m_min ? num(d.temperature_2m_min[ti + n]) : null })),
      ti, rises: msOf(riseA), sets: msOf(setA), riseT: riseA.map(wxdFmt12), setT: setA.map(wxdFmt12),
      aqi: (j2Cur && typeof j2Cur.us_aqi === 'number') ? Math.round(j2Cur.us_aqi) : null
    };
    wxd.at = Date.now();
  } catch {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      wxd.data = null;
    }
  } finally {
    wxd.busy = false;
  }
}

export async function wxdFetch(force?: boolean): Promise<void> {
  await wxdFetchOnce(force);
  if (wxd.again) {
    wxd.again = false;
    await wxdFetchOnce(true);
  }
}

export function wxdOnLocationChange(): void {
  wxdDropData();
  if (!wxd.built) return;
  wxdClearView();
  if (wxd.open) void wxdFetch(true).then(() => { if (wxd.open) wxdRender(); });
}

export function wxdCloseDeck(): void {
  clearInterval(wxd.tick);
  wxd.tick = 0;
  clearTimeout(wxd.lt);
  wxd.lt = 0;
  wxd.open = false;
  wxdEl('view-control-deck')?.classList.remove('weather-open');
  wxdEl('deck-weather')?.classList.remove('on');
}

export function wxdOpenDeck(): void {
  const deck = wxdEl('view-control-deck');
  if (!deck || !wxdBuild()) return;
  bus.emit('deck:close-other-panels', 'weather');
  deck.classList.add('weather-open');
  wxdEl('deck-weather')?.classList.add('on');
  wxd.open = true;
  wxdRender();
  void wxdFetch(false).then(() => { if (wxd.open) wxdRender(); });
  clearInterval(wxd.tick);
  wxd.tick = setInterval(() => {
    if (!wxd.open || appState.currentView !== 'view-control-deck') {
      wxdCloseDeck();
      return;
    }
    wxdRenderSun();
  }, 30000);
}

export function initWeather(): void {
  window.wxdCloseDeck = wxdCloseDeck;
  window.wxdOpenDeck = wxdOpenDeck;

  wxdEl('deck-weather')?.addEventListener('click', () => {
    if (wxd.open) {
      wxdCloseDeck();
    } else {
      if (typeof window.wgSetTab === 'function') {
        window.wgSetTab('controls');
      }
      wxdOpenDeck();
    }
  });

  window.addEventListener('offline', () => {
    weather.text = '';
    weather.condition = 'Offline';
    weather.at = 0;
    weather.key = '';
    updateClocks();
    renderWidgets();
    syncDeckWeatherUI();
    if (wxd.open) {
      wxd.data = null;
      wxdRender();
    }
  });

  window.addEventListener('online', () => {
    void refreshWeather();
    if (wxd.open) {
      void wxdFetch(true).then(() => { if (wxd.open) wxdRender(); });
    }
  });

  window.addEventListener('storage', (e) => {
    if (e.key === 'inex.weather.refresh') {
      weather.loc = null;
      weather.locAt = 0;
      weather.at = 0;
      weather.key = '';
      weather.cityLoc = null;
      weather.cityQ = '';
      try {
        const sv = JSON.parse(localStorage.getItem('inex.loc') || 'null') as { loc?: WeatherLocation; at?: number } | null;
        if (sv && sv.loc) {
          weather.loc = sv.loc;
          weather.locAt = sv.at || Date.now();
        }
      } catch (err) {
        console.warn('Storage parse error:', err);
      }
      void refreshWeather();
      wxdOnLocationChange();
    }
  });

  bus.on('weather:refresh', () => refreshWeather());
  bus.on('weather:open-deck', () => wxdOpenDeck());
  bus.on('weather:close-deck', () => wxdCloseDeck());
  bus.on('weather:render-widgets', () => renderWidgets());
  bus.on<string>('view:change', (view) => {
    if (view !== 'view-control-deck' && wxd.open) wxdCloseDeck();
  });
}
