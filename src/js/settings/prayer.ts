import { save } from '../../shared.js';
import { S } from './state.js';

export interface GeoLoc {
  lat: number;
  lon: number;
  city?: string;
}

export interface PrayerTimesMap {
  fajr: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
  [key: string]: string;
}

export function getSavedLocation(): GeoLoc | null {
  try {
    const pl = JSON.parse(localStorage.getItem('inex.prayer.loc') || 'null');
    if (pl && pl.loc && isFinite(pl.loc.lat) && isFinite(pl.loc.lon)) return pl.loc as GeoLoc;
    const wl = JSON.parse(localStorage.getItem('inex.loc') || 'null');
    if (wl && wl.loc && isFinite(wl.loc.lat) && isFinite(wl.loc.lon)) return wl.loc as GeoLoc;
  } catch { /* ignore */ }
  return null;
}

export function getCalculatedPrayerTimes(loc: GeoLoc | null, hanafi: boolean): PrayerTimesMap | null {
  if (!loc || !isFinite(loc.lat) || !isFinite(loc.lon)) return null;
  try {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const base = Date.UTC(y, m, d);
    const tzH = -now.getTimezoneOffset() / 60;
    const jdAt = (localH: number): number => (base + (localH - tzH) * 3600000) / 86400000 + 2440587.5;
    const R = Math.PI / 180;
    const sunCalc = (jd: number): { dec: number; eqMin: number } => {
      const n = jd - 2451545.0;
      const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;
      const g = (((357.528 + 0.9856003 * n) % 360) + 360) % 360 * R;
      const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R;
      const dec = Math.asin(Math.sin(23.439 * R) * Math.sin(lambda));
      let ra = Math.atan2(Math.cos(23.439 * R) * Math.sin(lambda), Math.cos(lambda)) / R;
      ra = (((ra % 360) + 360) % 360) / 15;
      const eqMin = (L / 15 - ra) * 60;
      return { dec, eqMin: eqMin > 20 ? eqMin - 1440 : eqMin < -20 ? eqMin + 1440 : eqMin };
    };
    const transit = (sp: { dec: number; eqMin: number }): number => 12 + tzH - loc.lon / 15 - sp.eqMin / 60;
    let T = transit(sunCalc(jdAt(12)));
    T = transit(sunCalc(jdAt(T)));
    const ev = (alt: number | 'asr', sign: number): number => {
      let g = T;
      for (let k = 0; k < 3; k++) {
        const sp = sunCalc(jdAt(g));
        const a = alt === 'asr'
          ? Math.atan(1 / ((hanafi ? 2 : 1) + Math.tan(Math.abs(loc.lat - sp.dec / R) * R))) / R
          : alt;
        const cosH = (Math.sin(a * R) - Math.sin(loc.lat * R) * Math.sin(sp.dec)) / (Math.cos(loc.lat * R) * Math.cos(sp.dec));
        if (cosH < -1 || cosH > 1) return NaN;
        g = transit(sp) + sign * (Math.acos(cosH) / R / 15);
      }
      return g;
    };
    const pad = (n: number): string => String(Math.floor(n)).padStart(2, '0');
    const toClock = (hours: number): string => {
      if (isNaN(hours)) return '';
      const totalM = Math.round(hours * 60);
      const h = Math.floor(totalM / 60) % 24;
      const min = totalM % 60;
      return `${pad(h)}:${pad(min)}`;
    };
    return {
      fajr: toClock(ev(-18, -1)),
      dhuhr: toClock(T + 1 / 60),
      asr: toClock(ev('asr', 1)),
      maghrib: toClock(ev(-0.833, 1)),
      isha: toClock(ev(-18, 1))
    };
  } catch { return null; }
}

async function fetchLiveIpLocation(): Promise<GeoLoc | null> {
  const tries: Array<() => Promise<GeoLoc | null>> = [
    async () => {
      const r = await fetch('https://ipwho.is/');
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.success !== false && d.latitude && d.longitude) ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '' } : null;
    },
    async () => {
      const r = await fetch('https://ipapi.co/json/');
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.latitude && d.longitude) ? { lat: +d.latitude, lon: +d.longitude, city: d.city || '' } : null;
    },
    async () => {
      const r = await fetch('https://freeipapi.com/api/json');
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.latitude && d.longitude) ? { lat: +d.latitude, lon: +d.longitude, city: d.cityName || '' } : null;
    }
  ];
  for (const t of tries) {
    try {
      const res = await t();
      if (res && isFinite(res.lat) && isFinite(res.lon)) return res;
    } catch { /* ignore */ }
  }
  return null;
}

export async function resolvePrayerLocation(): Promise<GeoLoc | null> {
  let loc: GeoLoc | null = null;
  const city = String(S.prayer?.city || '').trim();
  if (city) {
    try {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=en&format=json');
      if (res.ok) {
        const d = await res.json();
        if (d && d.results && d.results[0]) {
          const r = d.results[0];
          loc = { lat: +r.latitude, lon: +r.longitude, city: r.name || city };
        }
      }
    } catch { /* ignore */ }
  }
  if (!loc) loc = getSavedLocation();
  if (!loc) {
    loc = await fetchLiveIpLocation();
    if (loc) {
      try {
        localStorage.setItem('inex.prayer.loc', JSON.stringify({ mode: 'auto', loc, at: Date.now() }));
        localStorage.setItem('inex.loc', JSON.stringify({ loc, at: Date.now() }));
      } catch { /* ignore */ }
    }
  }
  return loc;
}

export function updateMasjidInputs(times: PrayerTimesMap | null): void {
  ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].forEach((k) => {
    const input = document.querySelector<HTMLInputElement>(`input[data-path="prayer.masjid.${k}"]`);
    if (input) input.value = (times && times[k]) || '';
  });
}

export function updatePrayerCityUI(cityName: string): void {
  const cityInput = document.querySelector<HTMLInputElement>('input[data-path="prayer.city"]');
  if (cityInput && !cityInput.value) {
    cityInput.placeholder = cityName || 'Auto-detect';
  }
}

export async function resetMasjidToCalculated(): Promise<void> {
  if (!S.prayer) S.prayer = {} as typeof S.prayer;
  const loc = await resolvePrayerLocation();
  if (loc && isFinite(loc.lat) && isFinite(loc.lon)) {
    const calc = getCalculatedPrayerTimes(loc, S.prayer.asrMethod === 'hanafi');
    if (calc) {
      S.prayer.masjid = {
        fajr: calc.fajr,
        dhuhr: calc.dhuhr,
        asr: calc.asr,
        maghrib: calc.maghrib,
        isha: calc.isha
      };
      save(S);
      try { localStorage.setItem('inex.prayer.refreshLoc', String(Date.now())); } catch { /* ignore */ }
      updateMasjidInputs(calc);
      if (loc.city) updatePrayerCityUI(loc.city);
      return;
    }
  }
  S.prayer.masjid = { fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' };
  save(S);
  updateMasjidInputs({ fajr: '', dhuhr: '', asr: '', maghrib: '', isha: '' });
}
