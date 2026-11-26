// Control Deck: Widgets tab (Screen Time ring, Speed Test, Currency converter, Markets with sparklines)
import { appState } from '../../core/state.js';
import { bus } from '../../core/bus.js';
import { loadSettings } from '../../core/settings.js';
import { invokeTauri } from '../../core/tauri.js';
import { closeDeckTrayPane } from '../tray/index.js';

export interface ScreenTimeApp {
  name: string;
  exe: string;
  secs: number;
}

export interface ScreenTimeTodayResponse {
  total: number;
  apps?: ScreenTimeApp[];
}

export interface MarketMeta {
  symbol?: string;
  currency?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
}

export interface MarketFetchResult {
  meta: MarketMeta;
  closes: number[];
  px: number;
  pct: number | null;
}

export let wgOpen = false;
let wgTimer: ReturnType<typeof setInterval> | 0 = 0;
let wgRates: Record<string, number> | null = null;
let wgRatesAt = 0;
let wgRatesBusy = false;
let wgMkAt = 0;
let wgMkBusy = false;
let wgSpeedBusy = false;
let wgSpeedCtl: AbortController | null = null;
let wgSpeedXhr: XMLHttpRequest | null = null;
let wgSwapDeg = 0;

export function wgEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function wgText(id: string, txt: string): void {
  const e = wgEl(id);
  if (e) e.textContent = txt;
}

export function wgStOn(): boolean {
  const s = loadSettings();
  return (s.general as Record<string, unknown> | undefined)?.screenTimeEnabled !== false;
}

export function wgAgo(ms: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

export function applyScreenTimeSetting(): void {
  const on = wgStOn();
  invokeTauri('set_screen_time_enabled', { on }).catch(() => {});
  void wgRefreshScreenTime();
}

export function wgSetTab(name: string): void {
  const deck = wgEl('view-control-deck');
  if (!deck) return;
  const w = name === 'widgets';
  bus.emit('prayer:close');
  if (w) {
    closeDeckTrayPane();
    if (typeof window.closeDeckSub === 'function') window.closeDeckSub();
    if (typeof window.wxdCloseDeck === 'function') window.wxdCloseDeck();
  } else {
    if (typeof window.wxdCloseDeck === 'function') window.wxdCloseDeck();
  }
  deck.classList.toggle('widgets-open', w);
  document.querySelector('.mx-view-switcher')?.setAttribute('data-active', w ? 'widgets' : 'controls');
  wgEl('mx-tab-controls')?.classList.toggle('active', !w);
  wgEl('mx-tab-widgets')?.classList.toggle('active', w);
  wgOpen = w;
  if (w) wgStart();
  else wgStop();
}

export function deckWidgetsReset(): void {
  if (wgOpen) wgSetTab('controls');
}

export function wgStart(): void {
  wgStop();
  wgTick(true);
  wgTimer = setInterval(() => wgTick(false), 30000);
}

export function wgStop(): void {
  if (wgTimer) {
    clearInterval(wgTimer);
    wgTimer = 0;
  }
  wgSpeedCancel();
}

export function wgTick(first: boolean): void {
  if (!wgOpen || appState.currentView !== 'view-control-deck') {
    wgStop();
    return;
  }
  void wgRefreshScreenTime();
  if (first || Date.now() - wgMkAt > 55000) void wgRefreshMarkets();
  if (first || !wgRates || Date.now() - wgRatesAt > 3600000) void wgLoadRates();
  wgRateBadge();
}

export const WG_APP_COLORS: Array<[RegExp, string]> = [
  [/code|studio|devenv|cursor|jetbrains|idea|pycharm|rider/i, '#0a84ff'],
  [/chrome|edge|firefox|brave|opera|browser|safari/i, '#ffd60a'],
  [/figma|photoshop|illustrator|xd|canva|blender/i, '#bf5af2'],
  [/spotify|music|vlc|media|youtube/i, '#30d158'],
  [/discord|slack|teams|zoom/i, '#5e5ce6'],
  [/whatsapp|telegram|signal|messenger/i, '#32d74b'],
  [/word|excel|powerpoint|notion|obsidian|onenote/i, '#ff9f0a'],
  [/claude|antigravity/i, '#ff6a3d'],
];
export const WG_DOT_FALLBACK = ['#ff375f', '#64d2ff', '#ff9f0a', '#5e5ce6', '#30d158', '#bf5af2'];
export const WG_RING_R = [25, 19.5, 14];
export let wgStRings: Array<{ name: string; secs: number; color: string }> = [];
export const wgIcons: Record<string, string> = {};

export function wgAppColor(a: Pick<ScreenTimeApp, 'name' | 'exe'>): string {
  const key = (a.name || '') + ' ' + (a.exe || '');
  for (const [re, c] of WG_APP_COLORS) if (re.test(key)) return c;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return WG_DOT_FALLBACK[h % WG_DOT_FALLBACK.length];
}

export function wgFmtShort(s: number | undefined): string {
  const sec = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm';
  return sec + 's';
}

export function wgDrawRings(total: number): void {
  const svg = wgEl('wg-st-svg');
  if (!svg) return;
  let html = '';
  WG_RING_R.forEach((r, i) => {
    const c = 2 * Math.PI * r;
    html += '<circle class="wg-ring-bg" cx="28" cy="28" r="' + r + '"/>';
    const ring = wgStRings[i];
    if (ring && total > 0) {
      const frac = Math.max(0.03, Math.min(1, ring.secs / total));
      html += '<circle class="wg-ring-fg" cx="28" cy="28" r="' + r + '" stroke="' + ring.color + '" transform="rotate(-90 28 28)"' +
        ' stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - frac)).toFixed(2) + '"/>';
    }
  });
  svg.innerHTML = html;
}

export function wgDrawStList(apps: ScreenTimeApp[]): void {
  const list = wgEl('wg-st-list');
  if (!list) return;
  list.textContent = '';
  if (!apps.length) {
    const row = document.createElement('div');
    row.className = 'wg-st-app';
    const n = document.createElement('span');
    n.textContent = 'No data yet';
    row.append(n);
    list.append(row);
    return;
  }
  apps.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'wg-st-app';
    let mark: HTMLElement;
    if (wgIcons[a.exe]) {
      const img = new window.Image();
      img.alt = '';
      img.draggable = false;
      img.src = wgIcons[a.exe];
      mark = img;
    } else {
      mark = document.createElement('i');
      mark.style.setProperty('--dc', wgAppColor(a));
    }
    const n = document.createElement('span');
    n.textContent = a.name;
    const t = document.createElement('em');
    t.textContent = wgFmtShort(a.secs);
    row.append(mark, n, t);
    list.append(row);
  });
}

export function wgLoadIcons(apps: ScreenTimeApp[]): void {
  const need = apps.map((a) => a.exe).filter((e) => !(e in wgIcons));
  if (!need.length) return;
  need.forEach((e) => { wgIcons[e] = ''; });
  invokeTauri<Record<string, string>>('get_app_icons', { exes: need }).then((map) => {
    if (!map) return;
    Object.keys(map).forEach((k) => { wgIcons[k] = map[k]; });
    wgDrawStList(apps);
  }).catch((err) => console.warn('Promise rejected in widgets/index.js:', err));
}

let wgStFetchedAt = 0;
let wgLastSt: ScreenTimeTodayResponse | null = null;

function wgPaintScreenTime(d: ScreenTimeTodayResponse): void {
  wgText('wg-st-total', wgFmtShort(d.total));
  const apps = (d.apps || []).slice(0, 3);
  wgStRings = apps.map((a) => ({ name: a.name, secs: a.secs, color: wgAppColor(a) }));
  wgDrawRings(d.total || 0);
  wgDrawStList(apps);
  wgLoadIcons(apps);
}

export async function wgRefreshScreenTime(force = false): Promise<void> {
  const totalHead = wgEl('wg-st-total');
  const headSpan = totalHead?.parentElement;

  if (!wgStOn()) {
    if (totalHead) totalHead.textContent = 'Off';
    if (headSpan) headSpan.innerHTML = '<strong id="wg-st-total" style="color:var(--menu-fg-dim);font-weight:600">Off</strong>';
    const svg = wgEl('wg-st-svg');
    if (svg) svg.innerHTML = '';
    const list = wgEl('wg-st-list');
    if (list) list.innerHTML = '<div class="wg-st-app"><span style="opacity:0.75">Screen time is off</span><em style="opacity:0.5;font-size:9.5px">In Settings</em></div>';
    return;
  }
  if (headSpan && !(headSpan.textContent || '').includes('session')) {
    headSpan.innerHTML = '<strong id="wg-st-total" style="color:#f5f5f7;font-weight:600">0m</strong> session';
  }
  if (wgLastSt) {
    wgPaintScreenTime(wgLastSt);
    if (!force && Date.now() - wgStFetchedAt < 10_000) return;
  }
  let d: ScreenTimeTodayResponse | null = null;
  try {
    d = await invokeTauri<ScreenTimeTodayResponse>('get_screen_time_today');
  } catch (err) {
    console.warn('Tauri get_screen_time_today failed:', err);
  }
  if (!d) return;
  wgLastSt = d;
  wgStFetchedAt = Date.now();
  wgPaintScreenTime(d);
}

export function wgRingTip(e: MouseEvent): void {
  const svg = wgEl('wg-st-svg');
  const card = wgEl('wg-screentime');
  const tip = wgEl('wg-st-tip');
  if (!svg || !card || !tip) return;
  const r = svg.getBoundingClientRect();
  const k = r.width / 56;
  const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / k;
  let hit = -1;
  WG_RING_R.forEach((rr, i) => {
    if (Math.abs(d - rr) <= 3.2 && wgStRings[i]) hit = i;
  });
  if (hit < 0) {
    tip.classList.add('hidden');
    return;
  }
  tip.textContent = wgStRings[hit].name + ' \u2022 ' + wgFmtShort(wgStRings[hit].secs);
  const c = card.getBoundingClientRect();
  tip.classList.remove('hidden');
  tip.style.left = Math.max(4, Math.min(c.width - tip.offsetWidth - 4, e.clientX - c.left + 10)) + 'px';
  tip.style.top = Math.max(2, e.clientY - c.top - 22) + 'px';
}

export async function wgGet<T = unknown>(url: string): Promise<T> {
  const txt = await invokeTauri<string>('http_get', { url });
  if (!txt) throw new Error('empty http response');
  return JSON.parse(txt) as T;
}

export const WG_CUR_RGB: Record<string, string> = {
  USD: '48,209,88', INR: '255,159,10', EUR: '10,132,255', GBP: '191,90,242', BDT: '0,194,168',
  JPY: '255,69,58', AUD: '255,214,10', CAD: '255,55,95', AED: '100,210,255',
};

export const WG_COUNTRY_MAP: Record<string, string> = {
  'bangladesh': 'BDT', 'bd': 'BDT', 'taka': 'BDT', 'tk': 'BDT', 'bdt': 'BDT',
  'pakistan': 'PKR', 'pk': 'PKR', 'pakistani': 'PKR', 'pkr': 'PKR',
  'india': 'INR', 'in': 'INR', 'rupee': 'INR', 'rs': 'INR', 'bharat': 'INR', 'inr': 'INR',
  'uae': 'AED', 'dubai': 'AED', 'emirates': 'AED', 'dirham': 'AED', 'aed': 'AED',
  'saudi': 'SAR', 'saudi arabia': 'SAR', 'ksa': 'SAR', 'riyal': 'SAR', 'sar': 'SAR',
  'kuwait': 'KWD', 'kwd': 'KWD', 'qatar': 'QAR', 'qar': 'QAR',
  'oman': 'OMR', 'omr': 'OMR', 'bahrain': 'BHD', 'bhd': 'BHD',
  'japan': 'JPY', 'yen': 'JPY', 'jpy': 'JPY',
  'china': 'CNY', 'chinese': 'CNY', 'yuan': 'CNY', 'rmb': 'CNY', 'cny': 'CNY',
  'singapore': 'SGD', 'sgd': 'SGD', 'malaysia': 'MYR', 'ringgit': 'MYR', 'myr': 'MYR',
  'indonesia': 'IDR', 'rupiah': 'IDR', 'idr': 'IDR', 'thailand': 'THB', 'baht': 'THB', 'thb': 'THB',
  'philippines': 'PHP', 'peso': 'PHP', 'php': 'PHP', 'vietnam': 'VND', 'dong': 'VND', 'vnd': 'VND',
  'nepal': 'NPR', 'npr': 'NPR', 'sri lanka': 'LKR', 'lkr': 'LKR',
  'south korea': 'KRW', 'korea': 'KRW', 'won': 'KRW', 'krw': 'KRW',
  'hong kong': 'HKD', 'hkd': 'HKD', 'taiwan': 'TWD', 'twd': 'TWD',
  'euro': 'EUR', 'europe': 'EUR', 'germany': 'EUR', 'france': 'EUR', 'italy': 'EUR', 'spain': 'EUR',
  'netherlands': 'EUR', 'ireland': 'EUR', 'belgium': 'EUR', 'austria': 'EUR', 'portugal': 'EUR',
  'greece': 'EUR', 'finland': 'EUR', 'eur': 'EUR',
  'uk': 'GBP', 'united kingdom': 'GBP', 'britain': 'GBP', 'england': 'GBP', 'pound': 'GBP', 'sterling': 'GBP', 'gbp': 'GBP',
  'russia': 'RUB', 'ruble': 'RUB', 'rub': 'RUB',
  'turkey': 'TRY', 'turkish': 'TRY', 'lira': 'TRY', 'try': 'TRY',
  'switzerland': 'CHF', 'swiss': 'CHF', 'franc': 'CHF', 'chf': 'CHF',
  'sweden': 'SEK', 'krona': 'SEK', 'sek': 'SEK', 'norway': 'NOK', 'krone': 'NOK', 'nok': 'NOK',
  'denmark': 'DKK', 'dkk': 'DKK', 'poland': 'PLN', 'zloty': 'PLN', 'pln': 'PLN',
  'usa': 'USD', 'us': 'USD', 'united states': 'USD', 'america': 'USD', 'dollar': 'USD', 'usd': 'USD',
  'canada': 'CAD', 'canadian': 'CAD', 'cad': 'CAD',
  'australia': 'AUD', 'australian': 'AUD', 'aud': 'AUD',
  'new zealand': 'NZD', 'nz': 'NZD', 'nzd': 'NZD',
  'brazil': 'BRL', 'real': 'BRL', 'brl': 'BRL',
  'mexico': 'MXN', 'mxn': 'MXN', 'argentina': 'ARS', 'ars': 'ARS',
  'egypt': 'EGP', 'egp': 'EGP', 'south africa': 'ZAR', 'rand': 'ZAR', 'zar': 'ZAR',
  'nigeria': 'NGN', 'naira': 'NGN', 'ngn': 'NGN',
};

export const WG_REGION_CUR: Record<string, string> = ('AF AFN,AL ALL,DZ DZD,AO AOA,AR ARS,AM AMD,AU AUD,AT EUR,AZ AZN,BS BSD,BH BHD,BD BDT,BB BBD,BY BYN,BE EUR,BZ BZD,BJ XOF,BT BTN,BO BOB,BA BAM,BW BWP,BR BRL,BN BND,BG BGN,BF XOF,BI BIF,KH KHR,CM XAF,CA CAD,CV CVE,CF XAF,TD XAF,CL CLP,CN CNY,CO COP,KM KMF,CG XAF,CD CDF,CR CRC,CI XOF,HR EUR,CU CUP,CY EUR,CZ CZK,DK DKK,DJ DJF,DO DOP,EC USD,EG EGP,SV USD,GQ XAF,ER ERN,EE EUR,SZ SZL,ET ETB,FJ FJD,FI EUR,FR EUR,GA XAF,GM GMD,GE GEL,DE EUR,GH GHS,GR EUR,GT GTQ,GN GNF,GW XOF,GY GYD,HT HTG,HN HNL,HK HKD,HU HUF,IS ISK,IN INR,ID IDR,IR IRR,IQ IQD,IE EUR,IL ILS,IT EUR,JM JMD,JP JPY,JO JOD,KZ KZT,KE KES,KW KWD,KG KGS,LA LAK,LV EUR,LB LBP,LS LSL,LR LRD,LY LYD,LT EUR,LU EUR,MO MOP,MG MGA,MW MWK,MY MYR,MV MVR,ML XOF,MT EUR,MR MRU,MU MUR,MX MXN,MD MDL,MN MNT,ME EUR,MA MAD,MZ MZN,MM MMK,NA NAD,NP NPR,NL EUR,NZ NZD,NI NIO,NE XOF,NG NGN,MK MKD,NO NOK,OM OMR,PK PKR,PA PAB,PG PGK,PY PYG,PE PEN,PH PHP,PL PLN,PT EUR,QA QAR,RO RON,RU RUB,RW RWF,SA SAR,SN XOF,RS RSD,SC SCR,SL SLE,SG SGD,SK EUR,SI EUR,SO SOS,ZA ZAR,KR KRW,SS SSP,ES EUR,LK LKR,SD SDG,SR SRD,SE SEK,CH CHF,SY SYP,TW TWD,TJ TJS,TZ TZS,TH THB,TG XOF,TT TTD,TN TND,TR TRY,TM TMT,UG UGX,UA UAH,AE AED,GB GBP,US USD,UY UYU,UZ UZS,VE VES,VN VND,YE YER,ZM ZMW,ZW ZWL,PS ILS,XK EUR,KP KPW,BM BMD,KY KYD,PR USD,GU USD').split(',')
  .reduce<Record<string, string>>((m, p) => { const [r, c] = p.split(' '); m[r] = c; return m; }, {});

let wgNameIdx: Record<string, string> | null = null;
let wgNameIdxHasRates = false;

export function wgBuildNameIdx(): Record<string, string> {
  const idx: Record<string, string> = {};
  try {
    const cn = new window.Intl.DisplayNames(['en'], { type: 'currency' });
    for (const code of Object.keys(wgRates || {})) {
      const n = cn.of(code);
      if (n && n !== code) idx[n.toLowerCase()] = code;
    }
  } catch (err) {
    console.warn('Intl currency DisplayNames failed:', err);
  }
  try {
    const rn = new window.Intl.DisplayNames(['en'], { type: 'region' });
    for (const [r, c] of Object.entries(WG_REGION_CUR)) {
      const n = rn.of(r);
      if (n) idx[n.toLowerCase()] = c;
    }
  } catch (err) {
    console.warn('Intl region DisplayNames failed:', err);
  }
  return idx;
}

export function wgResolveCurrency(inputStr: string): string | null {
  if (!inputStr) return null;
  const raw = String(inputStr).trim().toLowerCase();
  if (!raw) return null;
  if (WG_COUNTRY_MAP[raw]) return WG_COUNTRY_MAP[raw];
  const upper = raw.toUpperCase();
  if (wgRates && wgRates[upper]) return upper;
  if (!wgNameIdx || (wgRates && !wgNameIdxHasRates)) {
    wgNameIdx = wgBuildNameIdx();
    wgNameIdxHasRates = !!wgRates;
  }
  if (wgNameIdx[raw]) return wgNameIdx[raw];
  if (raw.length === 2 && WG_REGION_CUR[upper]) return WG_REGION_CUR[upper];
  if (raw.length >= 3) {
    for (const [k, v] of Object.entries(WG_COUNTRY_MAP)) if (k.startsWith(raw)) return v;
    for (const [k, v] of Object.entries(wgNameIdx)) if (k.startsWith(raw)) return v;
    for (const [k, v] of Object.entries(wgNameIdx)) if (k.includes(raw)) return v;
  }
  if (upper.length === 3) return upper;
  return null;
}

export function wgNum(v: unknown): number {
  return parseFloat(String(v).replace(/,/g, ''));
}

export function wgFmtNum(n: number): string {
  if (!isFinite(n)) return '--';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : (n >= 1 ? 2 : 4) });
}

export function wgCurCode(id: string): string {
  const e = wgEl(id) as HTMLInputElement | null;
  if (!e) return '';
  const res = wgResolveCurrency(e.value);
  return res || (e.value || '').toUpperCase().trim();
}

export function wgSaveCur(): void {
  try {
    const aInput = wgEl('wg-cur-a') as HTMLInputElement | null;
    localStorage.setItem('inex.wg.cur', JSON.stringify({
      a: wgCurCode('wg-cur-a-code') || 'USD',
      b: wgCurCode('wg-cur-b-code') || 'INR',
      amt: aInput?.value || '1'
    }));
  } catch (err) {
    console.warn('Storage save cur failed:', err);
  }
}

export function wgCurTint(): void {
  const codeA = wgCurCode('wg-cur-a-code');
  const codeB = wgCurCode('wg-cur-b-code');
  const card = wgEl('wg-currency');
  if (!card) return;
  const getRgb = (c: string): string => {
    if (WG_CUR_RGB[c]) return WG_CUR_RGB[c];
    let h = 0;
    for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
    const palette = ['48,209,88', '255,159,10', '10,132,255', '191,90,242', '0,194,168', '255,69,58', '255,214,10', '100,210,255'];
    return palette[h % palette.length];
  };
  const ra = getRgb(codeA);
  const rb = getRgb(codeB);
  card.style.setProperty('--ca', ra);
  card.style.setProperty('--cb', rb);
  wgEl('wg-cur-row-a')?.style.setProperty('--cc', ra);
  wgEl('wg-cur-row-b')?.style.setProperty('--cc', rb);
}

export function wgRateBadge(): void {
  const e = wgEl('wg-cur-rate');
  const codeA = wgCurCode('wg-cur-a-code');
  const codeB = wgCurCode('wg-cur-b-code');
  if (!e || !codeA || !codeB) return;
  if (!wgRates || !wgRates[codeA] || !wgRates[codeB]) {
    e.textContent = 'Loading rate\u2026';
    e.title = '';
    return;
  }
  e.textContent = '1 ' + codeA + ' = ' + wgFmtNum(wgRates[codeB] / wgRates[codeA]) + ' ' + codeB;
  e.title = 'Updated ' + wgAgo(wgRatesAt);
}

export function wgConvert(from: 'a' | 'b'): void {
  const a = wgEl('wg-cur-a') as HTMLInputElement | null;
  const b = wgEl('wg-cur-b') as HTMLInputElement | null;
  const codeA = wgCurCode('wg-cur-a-code');
  const codeB = wgCurCode('wg-cur-b-code');
  wgCurTint();
  if (!a || !b || !codeA || !codeB || !wgRates) return;
  const ra = wgRates[codeA];
  const rb = wgRates[codeB];
  if (!ra || !rb) return;
  if (from === 'a') {
    const n = wgNum(a.value);
    b.value = isFinite(n) ? wgFmtNum(n * rb / ra) : '--';
  } else {
    const n = wgNum(b.value);
    a.value = isFinite(n) ? wgFmtNum(n * ra / rb) : '--';
  }
  wgRateBadge();
  wgSaveCur();
}

export async function wgLoadRates(): Promise<void> {
  if (wgRatesBusy) return;
  wgRatesBusy = true;
  try {
    const j = await wgGet<{ rates?: Record<string, number> }>('https://open.er-api.com/v6/latest/USD');
    if (j && j.rates) {
      wgRates = j.rates;
      wgRatesAt = Date.now();
      wgConvert('a');
    }
  } catch (err) {
    console.warn('wgLoadRates error:', err);
  }
  wgRatesBusy = false;
}

export const WG_MK_PRESETS: Array<[string, string]> = [
  ['BTC', 'BTC-USD'], ['ETH', 'ETH-USD'], ['SOL', 'SOL-USD'],
  ['NIFTY', '^NSEI'], ['SENSEX', '^BSESN'],
  ['S&P 500', '^GSPC'], ['NASDAQ', '^IXIC'], ['DOW', '^DJI'],
  ['TSLA', 'TSLA'], ['AAPL', 'AAPL'], ['NVDA', 'NVDA'], ['MSFT', 'MSFT'], ['GOOGL', 'GOOGL'], ['AMZN', 'AMZN'],
  ['GOLD', 'GC=F'],
];

export function wgMkGetSym(i: number): string {
  const SET = loadSettings();
  if (SET?.deckMenu) {
    if (i === 0 && SET.deckMenu.market1) return SET.deckMenu.market1;
    if (i === 1 && SET.deckMenu.market2) return SET.deckMenu.market2;
  }
  return i === 0 ? 'BTC-USD' : '^NSEI';
}

export function wgMkLabel(sym: string): string {
  const p = WG_MK_PRESETS.find((x) => x[1] === sym);
  return p ? p[0] : sym.replace(/^\^/, '');
}

export function wgMkRow(i: number): Element | null {
  return document.querySelector('#wg-markets .wg-mk-row[data-i="' + i + '"]');
}

export function wgMkSpark(row: Element, closes: Array<number | null> | undefined, up: boolean): void {
  const svg = row.querySelector('.wg-spark');
  if (!svg) return;
  const pts = (closes || []).filter((v): v is number => typeof v === 'number' && isFinite(v));
  if (pts.length < 2) {
    svg.textContent = '';
    return;
  }
  const W = 44;
  const H = 16;
  const pad = 1.5;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const xy = pts.map((v, k) => [
    (k / (pts.length - 1)) * W,
    pad + (1 - (v - lo) / span) * (H - pad * 2),
  ]);
  const line = xy.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const col = up ? '#30d158' : '#ff453a';
  svg.innerHTML = '<path class="l" d="' + line + '" stroke="' + col + '"/>';
}

const CURRENCY_SYM: Record<string, string> = { USD: '$', INR: '\u20B9', EUR: '\u20AC', GBP: '\u00A3', JPY: '\u00A5' };

export function wgMkPrice(meta: MarketMeta, px: number): string {
  const sym = String(meta.symbol || '');
  const idx = sym.startsWith('^');
  const sign = idx ? '' : ((meta.currency && CURRENCY_SYM[meta.currency]) || '');
  return sign + px.toLocaleString('en-US', { maximumFractionDigits: px >= 1000 ? 0 : 2, minimumFractionDigits: px >= 1000 ? 0 : 2 });
}

interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: MarketMeta;
      indicators: { quote: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

export async function wgMkFetch(sym: string): Promise<MarketFetchResult> {
  const j = await wgGet<YahooChartResponse>('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=15m');
  const r = j.chart.result[0];
  const meta = r.meta;
  const closes = (r.indicators.quote[0].close || []).filter((v): v is number => typeof v === 'number');
  const px = meta.regularMarketPrice;
  if (typeof px !== 'number') throw new Error('no price');
  const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : (closes.length ? closes[0] : null);
  return { meta, closes, px, pct: prev ? (px / prev - 1) * 100 : null };
}

export async function wgMkUpdateRow(i: number): Promise<void> {
  const row = wgMkRow(i);
  if (!row) return;
  const sym = wgMkGetSym(i);
  const symEl = row.querySelector('.wg-sym');
  if (symEl) symEl.textContent = wgMkLabel(sym);
  const pxEl = row.querySelector('.wg-px');
  const chg = row.querySelector('.wg-chg');
  try {
    const d = await wgMkFetch(sym);
    if (symEl) symEl.textContent = wgMkLabel(sym);
    if (pxEl) pxEl.textContent = wgMkPrice(d.meta, d.px);
    if (chg) {
      if (typeof d.pct === 'number' && isFinite(d.pct)) {
        chg.textContent = (d.pct >= 0 ? '+' : '\u2212') + Math.abs(d.pct).toFixed(2) + '%';
        chg.className = 'wg-chg ' + (d.pct >= 0 ? 'up' : 'down');
      } else {
        chg.textContent = '--';
        chg.className = 'wg-chg';
      }
    }
    wgMkSpark(row, d.closes, !(d.pct !== null && d.pct < 0));
  } catch {
    if (symEl) symEl.textContent = wgMkLabel(sym);
  }
}

export async function wgRefreshMarkets(): Promise<void> {
  if (wgMkBusy) return;
  wgMkBusy = true;
  wgMkAt = Date.now();
  await Promise.all([wgMkUpdateRow(0), wgMkUpdateRow(1)]);
  wgMkBusy = false;
}

export const WG_GO_C = 2 * Math.PI * 22;
export const WG_DL_CHUNK = 25000000;
export const WG_UL_CHUNK = 4000000;
export const WG_STREAMS = 4;
export const WG_PHASE_MAX_MS = 8000;
export const WG_WARM_MS = 1000;

export function wgSpeedPhase(txt: string): void {
  wgText('wg-speed-phase', txt);
}

export function wgSpeedArc(p: number): void {
  const a = wgEl('wg-go-arc');
  if (a) a.style.strokeDashoffset = String(WG_GO_C * (1 - Math.max(0, Math.min(1, p))));
}

export function wgSpeedCancel(): void {
  try { wgSpeedCtl?.abort(); } catch (err) { console.warn('Speed cancel abort error:', err); }
  try { wgSpeedXhr?.abort(); } catch (err) { console.warn('Speed cancel xhr abort error:', err); }
}

export interface SpeedResult {
  ping: number | null;
  down: number | null;
  up: number | null;
  t: number;
}

export function wgSpeedSaveLast(r: SpeedResult): void {
  try {
    localStorage.setItem('inex.wg.speed', JSON.stringify(r));
  } catch (err) {
    console.warn('Speed save last failed:', err);
  }
}

export function wgSpeedRestore(): void {
  try {
    const r = JSON.parse(localStorage.getItem('inex.wg.speed') || 'null') as SpeedResult | null;
    if (!r || !r.t) return;
    wgText('wg-ping', r.ping != null ? String(r.ping) : '--');
    wgText('wg-down', r.down != null ? r.down.toFixed(1) : '--');
    wgText('wg-up', r.up != null ? r.up.toFixed(1) : '--');
    wgSpeedPhase('Last test \u00B7 ' + wgAgo(r.t));
  } catch (err) {
    console.warn('Speed restore failed:', err);
  }
}

export function wgMeter(): { mbps: (bytes: number) => number } {
  const t0 = performance.now();
  let wt = 0;
  let wb = 0;
  let warmed = false;
  return {
    mbps(bytes: number): number {
      const el = performance.now() - t0;
      if (!warmed && el >= WG_WARM_MS) {
        warmed = true;
        wt = el;
        wb = bytes;
      }
      if (warmed && el - wt > 150) return ((bytes - wb) * 8) / 1e6 / ((el - wt) / 1000);
      return el > 80 ? (bytes * 8) / 1e6 / (el / 1000) : 0;
    }
  };
}

export async function wgSpeedDownload(
  base: string,
  signal: AbortSignal,
  onProgress: (mbps: number, frac: number) => void
): Promise<number> {
  const streams = WG_STREAMS;
  const chunk = WG_DL_CHUNK;
  const byStream = new Array<number>(streams).fill(0);
  const meter = wgMeter();
  const t0 = performance.now();
  let lastUI = 0;

  const runStream = async (idx: number): Promise<void> => {
    while (!signal.aborted && performance.now() - t0 < WG_PHASE_MAX_MS) {
      const url = base + '__down?bytes=' + chunk + '&r=' + Math.random();
      const res = await fetch(url, { cache: 'no-store', signal });
      if (!res.body) break;
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) byStream[idx] += value.byteLength;
        const now = performance.now();
        if (now - lastUI > 80) {
          lastUI = now;
          const total = byStream.reduce((a, b) => a + b, 0);
          onProgress(meter.mbps(total), Math.min(1, (now - t0) / WG_PHASE_MAX_MS));
        }
        if (now - t0 >= WG_PHASE_MAX_MS) {
          try { void reader.cancel(); } catch { /* ignore */ }
          break;
        }
      }
    }
  };

  await Promise.all(new Array(streams).fill(0).map((_, i) => runStream(i).catch(() => {})));
  const total = byStream.reduce((a, b) => a + b, 0);
  return meter.mbps(total);
}

export function wgSpeedUpload(
  base: string,
  signal: AbortSignal,
  onProgress: (mbps: number, frac: number) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const streams = WG_STREAMS;
    const chunk = WG_UL_CHUNK;
    const buf = new Uint8Array(chunk);
    for (let i = 0; i < chunk; i += 4096) buf[i] = (Math.random() * 255) | 0;
    const byStream = new Array<number>(streams).fill(0);
    const active = new Set<XMLHttpRequest>();
    const meter = wgMeter();
    const t0 = performance.now();
    let lastUI = 0;
    let settled = false;
    let endTimer: ReturnType<typeof setTimeout> | 0 = 0;

    const totalSent = (): number => byStream.reduce((a, b) => a + b, 0);

    const abortAll = (): void => {
      for (const x of active) {
        try { x.abort(); } catch { /* ignore */ }
      }
      active.clear();
      wgSpeedXhr = null;
    };

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = 0;
      }
      signal.removeEventListener('abort', onAbort);
      abortAll();
      if (err) reject(err);
      else resolve(meter.mbps(totalSent()));
    };

    const onAbort = (): void => finish(new Error('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);

    endTimer = setTimeout(() => finish(), WG_PHASE_MAX_MS);

    const runStream = (idx: number): Promise<void> =>
      new Promise((streamDone) => {
        const pump = (): void => {
          if (settled || signal.aborted || performance.now() - t0 >= WG_PHASE_MAX_MS) {
            streamDone();
            return;
          }
          const xhr = new window.XMLHttpRequest();
          active.add(xhr);
          wgSpeedXhr = xhr;
          let prevLoaded = 0;
          xhr.open('POST', base + '__up?r=' + Math.random(), true);
          xhr.upload.onprogress = (e) => {
            if (settled) return;
            const delta = e.loaded - prevLoaded;
            if (delta > 0) {
              byStream[idx] += delta;
              prevLoaded = e.loaded;
            }
            const now = performance.now();
            if (now - lastUI > 80) {
              lastUI = now;
              onProgress(meter.mbps(totalSent()), Math.min(1, (now - t0) / WG_PHASE_MAX_MS));
            }
            if (now - t0 >= WG_PHASE_MAX_MS) {
              finish();
            }
          };
          const next = (): void => {
            active.delete(xhr);
            pump();
          };
          const stop = (): void => {
            active.delete(xhr);
            streamDone();
          };
          xhr.onload = next;
          xhr.onabort = stop;
          xhr.onerror = stop;
          xhr.send(buf);
        };
        pump();
      });

    void Promise.all(new Array(streams).fill(0).map((_, i) => runStream(i))).then(() => finish());
  });
}

export function wgSpeedRestoreValues(): void {
  try {
    const r = JSON.parse(localStorage.getItem('inex.wg.speed') || 'null') as SpeedResult | null;
    wgText('wg-ping', r && r.ping != null ? String(r.ping) : '--');
    wgText('wg-down', r && r.down != null ? r.down.toFixed(1) : '--');
    wgText('wg-up', r && r.up != null ? r.up.toFixed(1) : '--');
  } catch (err) {
    console.warn('Storage operation failed in widgets/index.js:', err);
  }
}

export async function wgSpeedTest(): Promise<void> {
  const card = wgEl('wg-speed');
  const btn = wgEl('wg-speed-btn');
  const label = btn ? (btn.querySelector('.wg-go-lbl') || btn.querySelector('#wg-go-label') || btn.querySelector('span')) : null;
  if (!card || !btn || !label) return;

  if (wgSpeedBusy) {
    wgSpeedCancel();
    return;
  }
  wgSpeedBusy = true;
  wgSpeedCtl = new window.AbortController();
  const signal = wgSpeedCtl.signal;

  card.classList.remove('done');
  card.classList.add('testing');
  label.textContent = '\u25A0';
  btn.title = 'Stop speed test';
  wgSpeedArc(0);
  wgText('wg-ping', '--');
  wgText('wg-down', '--');
  wgText('wg-up', '--');

  const base = 'https://speed.cloudflare.com/';
  const res: SpeedResult = { ping: null, down: null, up: null, t: 0 };

  try {
    wgSpeedPhase('Finding best server & ping\u2026');
    let best = 9999;
    for (let i = 0; i < 6; i++) {
      if (signal.aborted) throw new Error('aborted');
      const t0 = performance.now();
      await fetch(base + '__down?bytes=0&r=' + Math.random(), { cache: 'no-store', signal });
      if (i > 0) {
        best = Math.min(best, performance.now() - t0);
        wgText('wg-ping', String(Math.round(best)));
      }
      wgSpeedArc(0.10 * ((i + 1) / 6));
    }
    res.ping = Math.round(best);

    wgSpeedPhase('Testing Download\u2026');
    res.down = await wgSpeedDownload(base, signal, (v, p) => {
      label.textContent = v ? String(Math.round(v)) : '\u2026';
      wgText('wg-down', v ? v.toFixed(1) : '--');
      wgSpeedArc(0.10 + 0.50 * p);
    });
    wgText('wg-down', res.down.toFixed(1));

    wgSpeedPhase('Testing Upload\u2026');
    label.textContent = '\u2026';
    res.up = await wgSpeedUpload(base, signal, (v, p) => {
      label.textContent = v ? String(Math.round(v)) : '\u2026';
      wgText('wg-up', v ? v.toFixed(1) : '--');
      wgSpeedArc(0.60 + 0.40 * p);
    });
    wgText('wg-up', res.up.toFixed(1));
    wgSpeedArc(1);
    res.t = Date.now();
    wgSpeedSaveLast(res);
    card.classList.add('done');
    wgSpeedPhase('Done');
  } catch {
    if (signal.aborted) {
      wgSpeedPhase('Cancelled');
      wgSpeedRestoreValues();
    } else {
      wgSpeedPhase('Test failed \u2013 check connection');
      if (wgEl('wg-ping')?.textContent === '--') wgText('wg-ping', 'err');
    }
  }

  card.classList.remove('testing');
  label.textContent = 'GO';
  btn.title = 'Start speed test';
  if (!card.classList.contains('done')) wgSpeedArc(0);
  wgSpeedXhr = null;
  wgSpeedCtl = null;
  wgSpeedBusy = false;
}

export function wgCommitCurrency(inp: HTMLInputElement): void {
  const resolved = wgResolveCurrency(inp.value);
  if (resolved) {
    inp.value = resolved;
    inp.title = resolved;
  } else {
    inp.value = (inp.value || '').toUpperCase().trim();
  }
  wgCurTint();
  const a = wgEl('wg-cur-a') as HTMLInputElement | null;
  if (a && !isFinite(wgNum(a.value))) a.value = '1';
  wgConvert('a');
}

export function initWidgets(): void {
  window.wgSetTab = wgSetTab;
  window.deckWidgetsReset = deckWidgetsReset;
  wgEl('mx-tab-controls')?.addEventListener('click', () => wgSetTab('controls'));
  wgEl('mx-tab-widgets')?.addEventListener('click', () => wgSetTab('widgets'));
  wgEl('wg-speed-btn')?.addEventListener('click', wgSpeedTest);
  wgEl('wg-st-svg')?.addEventListener('mousemove', wgRingTip);
  wgEl('wg-st-svg')?.addEventListener('mouseleave', () => {
    const t = wgEl('wg-st-tip');
    if (t) t.classList.add('hidden');
  });
  wgEl('wg-markets')?.addEventListener('click', () => {
    try {
      localStorage.setItem('inex.settings.goto', 'menu');
    } catch (err) {
      console.warn('Storage setItem failed:', err);
    }
    void invokeTauri('open_settings');
  });

  wgEl('wg-cur-a')?.addEventListener('input', () => wgConvert('a'));
  wgEl('wg-cur-b')?.addEventListener('input', () => wgConvert('b'));
  (['a', 'b'] as const).forEach((side) => {
    const inp = wgEl('wg-cur-' + side + '-code') as HTMLInputElement | null;
    if (!inp) return;
    inp.addEventListener('focus', () => { inp.select(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        wgCommitCurrency(inp);
        inp.blur();
      }
    });
    inp.addEventListener('blur', () => {
      wgCommitCurrency(inp);
    });
  });

  wgEl('wg-cur-swap')?.addEventListener('click', () => {
    const a = wgEl('wg-cur-a') as HTMLInputElement | null;
    const b = wgEl('wg-cur-b') as HTMLInputElement | null;
    const ac = wgEl('wg-cur-a-code') as HTMLInputElement | null;
    const bc = wgEl('wg-cur-b-code') as HTMLInputElement | null;
    if (!a || !b || !ac || !bc) return;
    [a.value, b.value] = [b.value, a.value];
    [ac.value, bc.value] = [bc.value, ac.value];
    wgSwapDeg += 180;
    const sw = wgEl('wg-cur-swap');
    if (sw) sw.style.transform = 'rotate(' + wgSwapDeg + 'deg)';
    wgCurTint();
    wgRateBadge();
    wgSaveCur();
  });

  try {
    const saved = JSON.parse(localStorage.getItem('inex.wg.cur') || 'null') as { a?: string; b?: string; amt?: string } | null;
    const ac = wgEl('wg-cur-a-code') as HTMLInputElement | null;
    const bc = wgEl('wg-cur-b-code') as HTMLInputElement | null;
    const a = wgEl('wg-cur-a') as HTMLInputElement | null;
    if (saved) {
      if (saved.a && ac) ac.value = saved.a;
      if (saved.b && bc) bc.value = saved.b;
      if (saved.amt && a) a.value = saved.amt;
    } else {
      if (ac) ac.value = 'USD';
      if (bc) bc.value = 'INR';
      if (a) a.value = '1';
    }
  } catch (err) {
    console.warn('Unhandled exception in widgets/index.js:', err);
  }

  wgCurTint();
  wgSpeedRestore();
  applyScreenTimeSetting();
  bus.on<string>('view:change', (viewId) => {
    if (viewId === 'view-control-deck' && wgStOn() && Date.now() - wgStFetchedAt > 15_000) {
      void wgRefreshScreenTime(true);
    }
  });
}
