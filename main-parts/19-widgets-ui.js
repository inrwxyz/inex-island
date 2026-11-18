// Mac Control Deck: Widgets tab (Screen Time ring, Speed Test, Currency, Markets with sparklines).
// Everything here is ACTIVE ONLY while the Widgets tab is open: the 30 s timer starts when the tab opens and
// stops when you go back to Controls or the menu closes. Screen Time TRACKING itself lives in Rust (screentime.rs)
// and always runs (unless switched off in Settings > Screen Time).
// (functions + var on purpose: switchView / applySettings can call into this part before it has executed)
var wgOpen = false;
var wgTimer = 0;
var wgStLast = null;
var wgRates = null;
var wgRatesAt = 0;
var wgRatesBusy = false;
var wgMkAt = 0;
var wgMkBusy = false;
var wgSpeedBusy = false;
var wgSpeedCtl = null;
var wgSpeedXhr = null;
var wgStGoal = 6 * 3600;      // ring target in seconds: your recent daily average (falls back to 6 h)
var wgStGoalAt = 0;
var wgSwapDeg = 0;

function wgEl(id) { return document.getElementById(id); }
function wgText(id, txt) { const e = wgEl(id); if (e) e.textContent = txt; }
function wgStOn() { return true; }
function wgAgo(ms) {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

function applyScreenTimeSetting() {
  // Session-only tracking in Rust
}

// exact time: 45s / 12m 30s / 2h 05m
function wgFmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(r).padStart(2, '0') + 's';
  return s + 's';
}

// ---- tabs ----
function wgSetTab(name) {
  const deck = wgEl('view-control-mac');
  if (!deck) return;
  const w = name === 'widgets';
  if (w) {
    if (typeof closeMacTrayPane === 'function') closeMacTrayPane();
    if (typeof closeMacSub === 'function') closeMacSub();
  }
  deck.classList.toggle('widgets-open', w);
  document.querySelector('.mx-view-switcher')?.setAttribute('data-active', w ? 'widgets' : 'controls');
  wgEl('mx-tab-controls')?.classList.toggle('active', !w);
  wgEl('mx-tab-widgets')?.classList.toggle('active', w);
  wgOpen = w;
  if (w) wgStart(); else wgStop();
}
// called from switchView(): the menu always opens on "Controls" and widgets stop when it closes
function macWidgetsReset() { if (wgOpen) wgSetTab('controls'); }

function wgStart() {
  wgStop();
  wgTick(true);
  wgTimer = setInterval(() => wgTick(false), 30000);
}
function wgStop() {
  if (wgTimer) { clearInterval(wgTimer); wgTimer = 0; }
  wgSpeedCancel();   // leaving the tab stops a running speed test (saves data)
}
function wgTick(first) {
  if (!wgOpen || appState.currentView !== 'view-control-mac') { wgStop(); return; }
  wgRefreshScreenTime();
  if (first || Date.now() - wgMkAt > 55000) wgRefreshMarkets();
  if (first || !wgRates || Date.now() - wgRatesAt > 3600000) wgLoadRates();   // rates cached for 1 h
  wgRateBadge();
}

// ---- Screen Time card: one ring per top app (share of today) + top 3 list, tooltip on the rings ----
const WG_APP_COLORS = [
  [/code|studio|devenv|cursor|jetbrains|idea|pycharm|rider/i, '#0a84ff'],
  [/chrome|edge|firefox|brave|opera|browser|safari/i, '#ffd60a'],
  [/figma|photoshop|illustrator|xd|canva|blender/i, '#bf5af2'],
  [/spotify|music|vlc|media|youtube/i, '#30d158'],
  [/discord|slack|teams|zoom/i, '#5e5ce6'],
  [/whatsapp|telegram|signal|messenger/i, '#32d74b'],
  [/word|excel|powerpoint|notion|obsidian|onenote/i, '#ff9f0a'],
  [/claude|antigravity/i, '#ff6a3d'],
];
const WG_DOT_FALLBACK = ['#ff375f', '#64d2ff', '#ff9f0a', '#5e5ce6', '#30d158', '#bf5af2'];
const WG_RING_R = [25, 19.5, 14];
var wgStRings = [];
var wgIcons = {};
function wgAppColor(a) {
  const key = (a.name || '') + ' ' + (a.exe || '');
  for (const [re, c] of WG_APP_COLORS) if (re.test(key)) return c;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return WG_DOT_FALLBACK[h % WG_DOT_FALLBACK.length];
}
// short time for the card: 45s / 24m / 1h 05m
function wgFmtShort(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm';
  return s + 's';
}
function wgDrawRings(total) {
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
function wgDrawStList(apps) {
  const list = wgEl('wg-st-list');
  if (!list) return;
  list.textContent = '';
  if (!apps.length) {
    const row = document.createElement('div'); row.className = 'wg-st-app';
    const n = document.createElement('span'); n.textContent = 'No data yet';
    row.append(n); list.append(row);
    return;
  }
  apps.forEach((a) => {
    const row = document.createElement('div'); row.className = 'wg-st-app';
    let mark;
    if (wgIcons[a.exe]) { mark = new Image(); mark.alt = ''; mark.draggable = false; mark.src = wgIcons[a.exe]; }
    else { mark = document.createElement('i'); mark.style.setProperty('--dc', wgAppColor(a)); }
    const n = document.createElement('span'); n.textContent = a.name;
    const t = document.createElement('em'); t.textContent = wgFmtShort(a.secs);
    row.append(mark, n, t); list.append(row);
  });
}
function wgLoadIcons(apps) {
  const need = apps.map((a) => a.exe).filter((e) => !(e in wgIcons));
  if (!need.length) return;
  need.forEach((e) => { wgIcons[e] = ''; });
  invokeTauri('get_app_icons', { exes: need }).then((map) => {
    if (!map) return;
    Object.keys(map).forEach((k) => { wgIcons[k] = map[k]; });
    wgDrawStList(apps);
  }).catch(() => {});
}
async function wgRefreshScreenTime() {
  if (!wgStOn()) return;
  let d = null;
  try { d = await invokeTauri('get_screen_time_today'); } catch (_) {}
  if (!d) return;
  wgText('wg-st-total', wgFmtShort(d.total));
  const apps = (d.apps || []).slice(0, 3);
  wgStRings = apps.map((a) => ({ name: a.name, secs: a.secs, color: wgAppColor(a) }));
  wgDrawRings(d.total || 0);
  wgDrawStList(apps);
  wgLoadIcons(apps);
}
// hover on a ring -> small label with the app name and its time
function wgRingTip(e) {
  const svg = wgEl('wg-st-svg'), card = wgEl('wg-screentime'), tip = wgEl('wg-st-tip');
  if (!svg || !card || !tip) return;
  const r = svg.getBoundingClientRect();
  const k = r.width / 56;
  const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / k;
  let hit = -1;
  WG_RING_R.forEach((rr, i) => { if (Math.abs(d - rr) <= 3.2 && wgStRings[i]) hit = i; });
  if (hit < 0) { tip.style.display = 'none'; return; }
  tip.textContent = wgStRings[hit].name + ' \u2022 ' + wgFmtShort(wgStRings[hit].secs);
  const c = card.getBoundingClientRect();
  tip.style.display = 'block';
  tip.style.left = Math.max(4, Math.min(c.width - tip.offsetWidth - 4, e.clientX - c.left + 10)) + 'px';
  tip.style.top = Math.max(2, e.clientY - c.top - 22) + 'px';
}

// ---- http helper (Rust, curl.exe, allow-listed hosts) ----
async function wgGet(url) {
  const txt = await invokeTauri('http_get', { url });
  return JSON.parse(txt);
}

// ---- Currency ----
const WG_CUR_RGB = {
  USD: '48,209,88', INR: '255,159,10', EUR: '10,132,255', GBP: '191,90,242', BDT: '0,194,168',
  JPY: '255,69,58', AUD: '255,214,10', CAD: '255,55,95', AED: '100,210,255',
};
const WG_COUNTRY_MAP = {
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
// ISO country -> currency, so any country name (or its 2-letter code) resolves to a currency code.
const WG_REGION_CUR = ('AF AFN,AL ALL,DZ DZD,AO AOA,AR ARS,AM AMD,AU AUD,AT EUR,AZ AZN,BS BSD,BH BHD,BD BDT,BB BBD,BY BYN,BE EUR,BZ BZD,BJ XOF,BT BTN,BO BOB,BA BAM,BW BWP,BR BRL,BN BND,BG BGN,BF XOF,BI BIF,KH KHR,CM XAF,CA CAD,CV CVE,CF XAF,TD XAF,CL CLP,CN CNY,CO COP,KM KMF,CG XAF,CD CDF,CR CRC,CI XOF,HR EUR,CU CUP,CY EUR,CZ CZK,DK DKK,DJ DJF,DO DOP,EC USD,EG EGP,SV USD,GQ XAF,ER ERN,EE EUR,SZ SZL,ET ETB,FJ FJD,FI EUR,FR EUR,GA XAF,GM GMD,GE GEL,DE EUR,GH GHS,GR EUR,GT GTQ,GN GNF,GW XOF,GY GYD,HT HTG,HN HNL,HK HKD,HU HUF,IS ISK,IN INR,ID IDR,IR IRR,IQ IQD,IE EUR,IL ILS,IT EUR,JM JMD,JP JPY,JO JOD,KZ KZT,KE KES,KW KWD,KG KGS,LA LAK,LV EUR,LB LBP,LS LSL,LR LRD,LY LYD,LT EUR,LU EUR,MO MOP,MG MGA,MW MWK,MY MYR,MV MVR,ML XOF,MT EUR,MR MRU,MU MUR,MX MXN,MD MDL,MN MNT,ME EUR,MA MAD,MZ MZN,MM MMK,NA NAD,NP NPR,NL EUR,NZ NZD,NI NIO,NE XOF,NG NGN,MK MKD,NO NOK,OM OMR,PK PKR,PA PAB,PG PGK,PY PYG,PE PEN,PH PHP,PL PLN,PT EUR,QA QAR,RO RON,RU RUB,RW RWF,SA SAR,SN XOF,RS RSD,SC SCR,SL SLE,SG SGD,SK EUR,SI EUR,SO SOS,ZA ZAR,KR KRW,SS SSP,ES EUR,LK LKR,SD SDG,SR SRD,SE SEK,CH CHF,SY SYP,TW TWD,TJ TJS,TZ TZS,TH THB,TG XOF,TT TTD,TN TND,TR TRY,TM TMT,UG UGX,UA UAH,AE AED,GB GBP,US USD,UY UYU,UZ UZS,VE VES,VN VND,YE YER,ZM ZMW,ZW ZWL,PS ILS,XK EUR,KP KPW,BM BMD,KY KYD,PR USD,GU USD').split(',')
  .reduce((m, p) => { const [r, c] = p.split(' '); m[r] = c; return m; }, {});
let wgNameIdx = null;
function wgBuildNameIdx() {
  const idx = {};
  try {
    const cn = new Intl.DisplayNames(['en'], { type: 'currency' });
    for (const code of Object.keys(wgRates || {})) {
      const n = cn.of(code);
      if (n && n !== code) idx[n.toLowerCase()] = code;
    }
  } catch (_) {}
  try {
    const rn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (const [r, c] of Object.entries(WG_REGION_CUR)) {
      const n = rn.of(r);
      if (n) idx[n.toLowerCase()] = c;
    }
  } catch (_) {}
  return idx;
}
function wgResolveCurrency(inputStr) {
  if (!inputStr) return null;
  const raw = String(inputStr).trim().toLowerCase();
  if (!raw) return null;
  if (WG_COUNTRY_MAP[raw]) return WG_COUNTRY_MAP[raw];
  const upper = raw.toUpperCase();
  if (wgRates && wgRates[upper]) return upper;
  if (!wgNameIdx || (wgRates && !wgNameIdx.__rates)) { wgNameIdx = wgBuildNameIdx(); if (wgRates) wgNameIdx.__rates = true; }
  if (wgNameIdx[raw]) return wgNameIdx[raw];
  if (raw.length === 2 && WG_REGION_CUR[upper]) return WG_REGION_CUR[upper];
  if (raw.length >= 3) {
    // partial text ("bangla", "japan", "dollar"): first name that starts with it, else contains it
    for (const [k, v] of Object.entries(WG_COUNTRY_MAP)) if (k.startsWith(raw)) return v;
    for (const [k, v] of Object.entries(wgNameIdx)) if (k !== '__rates' && k.startsWith(raw)) return v;
    for (const [k, v] of Object.entries(wgNameIdx)) if (k !== '__rates' && k.includes(raw)) return v;
  }
  if (upper.length === 3) return upper;
  return null;
}
function wgNum(v) { return parseFloat(String(v).replace(/,/g, '')); }
function wgFmtNum(n) {
  if (!isFinite(n)) return '--';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : (n >= 1 ? 2 : 4) });
}
function wgCurCode(id) {
  const e = wgEl(id);
  if (!e) return '';
  const res = wgResolveCurrency(e.value);
  return res || (e.value || '').toUpperCase().trim();
}
function wgSaveCur() {
  try {
    localStorage.setItem('inex.wg.cur', JSON.stringify({
      a: wgCurCode('wg-cur-a-code') || 'USD', b: wgCurCode('wg-cur-b-code') || 'INR', amt: wgEl('wg-cur-a')?.value || '1'
    }));
  } catch (_) {}
}
function wgCurTint() {
  const codeA = wgCurCode('wg-cur-a-code'), codeB = wgCurCode('wg-cur-b-code');
  const card = wgEl('wg-currency');
  if (!card) return;
  const getRgb = (c) => {
    if (WG_CUR_RGB[c]) return WG_CUR_RGB[c];
    let h = 0;
    for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
    const palette = ['48,209,88', '255,159,10', '10,132,255', '191,90,242', '0,194,168', '255,69,58', '255,214,10', '100,210,255'];
    return palette[h % palette.length];
  };
  const ra = getRgb(codeA), rb = getRgb(codeB);
  card.style.setProperty('--ca', ra); card.style.setProperty('--cb', rb);
  wgEl('wg-cur-row-a')?.style.setProperty('--cc', ra);
  wgEl('wg-cur-row-b')?.style.setProperty('--cc', rb);
}
function wgRateBadge() {
  const e = wgEl('wg-cur-rate');
  const codeA = wgCurCode('wg-cur-a-code'), codeB = wgCurCode('wg-cur-b-code');
  if (!e || !codeA || !codeB) return;
  if (!wgRates || !wgRates[codeA] || !wgRates[codeB]) { e.textContent = 'Loading rate\u2026'; e.title = ''; return; }
  e.textContent = '1 ' + codeA + ' = ' + wgFmtNum(wgRates[codeB] / wgRates[codeA]) + ' ' + codeB;
  e.title = 'Updated ' + wgAgo(wgRatesAt);
}
function wgConvert(from) {
  const a = wgEl('wg-cur-a'), b = wgEl('wg-cur-b');
  const codeA = wgCurCode('wg-cur-a-code'), codeB = wgCurCode('wg-cur-b-code');
  wgCurTint();
  if (!a || !b || !codeA || !codeB || !wgRates) return;
  const ra = wgRates[codeA], rb = wgRates[codeB];
  if (!ra || !rb) return;
  if (from === 'a') { const n = wgNum(a.value); b.value = isFinite(n) ? wgFmtNum(n * rb / ra) : '--'; }
  else { const n = wgNum(b.value); a.value = isFinite(n) ? wgFmtNum(n * ra / rb) : '--'; }
  wgRateBadge();
  wgSaveCur();
}
async function wgLoadRates() {
  if (wgRatesBusy) return;
  wgRatesBusy = true;
  try {
    const j = await wgGet('https://open.er-api.com/v6/latest/USD');
    if (j && j.rates) { wgRates = j.rates; wgRatesAt = Date.now(); wgConvert('a'); }
  } catch (_) {}
  wgRatesBusy = false;
}

// ---- Markets: pick any 2 tickers (Yahoo Finance), 1-day sparkline, configured in Settings ----
const WG_MK_PRESETS = [
  ['BTC', 'BTC-USD'], ['ETH', 'ETH-USD'], ['SOL', 'SOL-USD'],
  ['NIFTY', '^NSEI'], ['SENSEX', '^BSESN'],
  ['S&P 500', '^GSPC'], ['NASDAQ', '^IXIC'], ['DOW', '^DJI'],
  ['TSLA', 'TSLA'], ['AAPL', 'AAPL'], ['NVDA', 'NVDA'], ['MSFT', 'MSFT'], ['GOOGL', 'GOOGL'], ['AMZN', 'AMZN'],
  ['GOLD', 'GC=F'],
];

function wgMkGetSym(i) {
  if (typeof SET !== 'undefined' && SET?.macMenu) {
    if (i === 0 && SET.macMenu.market1) return SET.macMenu.market1;
    if (i === 1 && SET.macMenu.market2) return SET.macMenu.market2;
  }
  return i === 0 ? 'BTC-USD' : '^NSEI';
}

function wgMkLabel(sym) {
  const p = WG_MK_PRESETS.find((x) => x[1] === sym);
  return p ? p[0] : sym.replace(/^\^/, '');
}
function wgMkRow(i) { return document.querySelector('#wg-markets .wg-mk-row[data-i="' + i + '"]'); }

function wgMkSpark(row, closes, up) {
  const svg = row.querySelector('.wg-spark');
  if (!svg) return;
  const pts = (closes || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (pts.length < 2) { svg.textContent = ''; return; }
  const W = 44, H = 16, pad = 1.5;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const xy = pts.map((v, k) => [
    (k / (pts.length - 1)) * W,
    pad + (1 - (v - lo) / span) * (H - pad * 2),
  ]);
  const line = xy.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const col = up ? '#30d158' : '#ff453a';
  svg.innerHTML = '<path class="l" d="' + line + '" stroke="' + col + '"/>';
}

function wgMkPrice(meta, px) {
  const sym = String(meta.symbol || '');
  const idx = sym.startsWith('^');
  const sign = idx ? '' : ({ USD: '$', INR: '\u20B9', EUR: '\u20AC', GBP: '\u00A3', JPY: '\u00A5' }[meta.currency] || '');
  return sign + px.toLocaleString('en-US', { maximumFractionDigits: px >= 1000 ? 0 : 2, minimumFractionDigits: px >= 1000 ? 0 : 2 });
}

async function wgMkFetch(sym) {
  const j = await wgGet('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=15m');
  const r = j.chart.result[0];
  const meta = r.meta;
  const closes = (r.indicators.quote[0].close || []).filter((v) => typeof v === 'number');
  const px = meta.regularMarketPrice;
  if (typeof px !== 'number') throw new Error('no price');
  const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : (closes.length ? closes[0] : null);
  return { meta, closes, px, pct: prev ? (px / prev - 1) * 100 : null };
}

async function wgMkUpdateRow(i) {
  const row = wgMkRow(i);
  if (!row) return;
  const sym = wgMkGetSym(i);
  const symEl = row.querySelector('.wg-sym');
  if (symEl) symEl.textContent = wgMkLabel(sym);
  const pxEl = row.querySelector('.wg-px'), chg = row.querySelector('.wg-chg');
  try {
    const d = await wgMkFetch(sym);
    if (symEl) symEl.textContent = wgMkLabel(sym);
    pxEl.textContent = wgMkPrice(d.meta, d.px);
    if (typeof d.pct === 'number' && isFinite(d.pct)) {
      chg.textContent = (d.pct >= 0 ? '+' : '\u2212') + Math.abs(d.pct).toFixed(2) + '%';
      chg.className = 'wg-chg ' + (d.pct >= 0 ? 'up' : 'down');
    } else { chg.textContent = '--'; chg.className = 'wg-chg'; }
    wgMkSpark(row, d.closes, !(d.pct < 0));
  } catch (_) {
    if (symEl) symEl.textContent = wgMkLabel(sym);
  }
}

async function wgRefreshMarkets() {
  if (wgMkBusy) return;
  wgMkBusy = true;
  wgMkAt = Date.now();
  await Promise.all([wgMkUpdateRow(0), wgMkUpdateRow(1)]);
  wgMkBusy = false;
}

// ---- Speed Test: Ping -> Download -> Upload with a live arc (Cloudflare speed endpoints, ~30 MB max) ----
const WG_GO_C = 2 * Math.PI * 22;
const WG_DL_CHUNK = 25000000, WG_UL_CHUNK = 1000000, WG_STREAMS = 4, WG_PHASE_MAX_MS = 8000, WG_WARM_MS = 1000;

function wgSpeedPhase(txt) { wgText('wg-speed-phase', txt); }
function wgSpeedArc(p) {
  const a = wgEl('wg-go-arc');
  if (a) a.style.strokeDashoffset = String(WG_GO_C * (1 - Math.max(0, Math.min(1, p))));
}
function wgSpeedCancel() {
  try { wgSpeedCtl?.abort(); } catch (_) {}
  try { wgSpeedXhr?.abort(); } catch (_) {}
}
function wgSpeedSaveLast(r) { try { localStorage.setItem('inex.wg.speed', JSON.stringify(r)); } catch (_) {} }
function wgSpeedRestore() {
  try {
    const r = JSON.parse(localStorage.getItem('inex.wg.speed') || 'null');
    if (!r || !r.t) return;
    wgText('wg-ping', r.ping != null ? String(r.ping) : '--');
    wgText('wg-down', r.down != null ? r.down.toFixed(1) : '--');
    wgText('wg-up', r.up != null ? r.up.toFixed(1) : '--');
    wgSpeedPhase('Last test \u00B7 ' + wgAgo(r.t));
  } catch (_) {}
}

// Mbps meter: ignores the first WG_WARM_MS (TCP slow start), then averages the rest
function wgMeter() {
  const t0 = performance.now();
  let wt = 0, wb = 0, warmed = false;
  return {
    mbps(bytes) {
      const el = performance.now() - t0;
      if (!warmed && el >= WG_WARM_MS) { warmed = true; wt = el; wb = bytes; }
      if (warmed && el - wt > 150) return ((bytes - wb) * 8) / 1e6 / ((el - wt) / 1000);
      return el > 80 ? (bytes * 8) / 1e6 / (el / 1000) : 0;
    },
    elapsed() { return performance.now() - t0; },
  };
}

// Download: 4 parallel streams (like Ookla / Fast.com), bytes counted as they arrive
async function wgSpeedDownload(base, signal, onLive) {
  const m = wgMeter();
  let got = 0, last = 0, stop = false;
  const worker = async () => {
    while (!stop && m.elapsed() < WG_PHASE_MAX_MS) {
      const r = await fetch(base + '__down?bytes=' + WG_DL_CHUNK + '&r=' + Math.random(), { cache: 'no-store', signal });
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        got += value.length;
        const v = m.mbps(got); last = v || last;
        onLive(last, Math.min(1, m.elapsed() / WG_PHASE_MAX_MS));
        if (m.elapsed() > WG_PHASE_MAX_MS) { stop = true; try { await rd.cancel(); } catch (_) {} break; }
      }
    }
  };
  await Promise.all(Array.from({ length: WG_STREAMS }, worker));
  return m.mbps(got) || last;
}

// Upload: 4 parallel streams of 1 MB POSTs. A chunk only counts AFTER the server has answered, so the number is the
// real speed (the old single XHR counted bytes that were still sitting in the browser's send buffer = wrong/too high).
async function wgSpeedUpload(base, signal, onLive) {
  const m = wgMeter();
  const body = new Uint8Array(WG_UL_CHUNK);
  for (let i = 0; i < body.length; i += 65536) crypto.getRandomValues(body.subarray(i, Math.min(i + 65536, body.length)));
  let sent = 0, last = 0;
  const worker = async () => {
    while (m.elapsed() < WG_PHASE_MAX_MS) {
      const r = await fetch(base + '__up?r=' + Math.random(), { method: 'POST', body, cache: 'no-store', signal });
      await r.arrayBuffer();
      sent += body.length;
      const v = m.mbps(sent); last = v || last;
      onLive(last, Math.min(1, m.elapsed() / WG_PHASE_MAX_MS));
    }
  };
  await Promise.all(Array.from({ length: WG_STREAMS }, worker));
  return m.mbps(sent) || last;
}

async function wgSpeedTest() {
  if (wgSpeedBusy) { wgSpeedCancel(); return; }   // pressing the button again cancels
  wgSpeedBusy = true;
  const card = wgEl('wg-speed'), label = wgEl('wg-go-label'), btn = wgEl('wg-speed-btn');
  card?.classList.remove('done'); card?.classList.add('testing');
  if (btn) btn.title = 'Stop';
  wgText('wg-ping', '--'); wgText('wg-down', '--'); wgText('wg-up', '--');
  wgSpeedArc(0);
  wgSpeedCtl = new AbortController();
  const signal = wgSpeedCtl.signal;
  const base = 'https://speed.cloudflare.com/';
  const res = { ping: null, down: null, up: null, t: 0 };
  try {
    // 1) Ping (first request only warms the connection)
    wgSpeedPhase('Ping\u2026'); label.textContent = '\u2026';
    let best = Infinity;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      await fetch(base + '__down?bytes=0&r=' + Math.random(), { cache: 'no-store', signal });
      if (i > 0) { best = Math.min(best, performance.now() - t0); wgText('wg-ping', String(Math.round(best))); }
      wgSpeedArc(0.10 * ((i + 1) / 6));
    }
    res.ping = Math.round(best);
    // 2) Download
    wgSpeedPhase('Testing Download\u2026');
    res.down = await wgSpeedDownload(base, signal, (v, p) => {
      label.textContent = v ? String(Math.round(v)) : '\u2026';
      wgText('wg-down', v ? v.toFixed(1) : '--');
      wgSpeedArc(0.10 + 0.50 * p);
    });
    wgText('wg-down', res.down.toFixed(1));
    // 3) Upload
    wgSpeedPhase('Testing Upload\u2026'); label.textContent = '\u2026';
    res.up = await wgSpeedUpload(base, signal, (v, p) => {
      label.textContent = v ? String(Math.round(v)) : '\u2026';
      wgText('wg-up', v ? v.toFixed(1) : '--');
      wgSpeedArc(0.60 + 0.40 * p);
    });
    wgText('wg-up', res.up.toFixed(1));
    wgSpeedArc(1);
    res.t = Date.now();
    wgSpeedSaveLast(res);
    card?.classList.add('done');
    wgSpeedPhase('Done');
  } catch (_) {
    if (signal.aborted) { wgSpeedPhase('Cancelled'); wgSpeedRestoreValues(); }
    else { wgSpeedPhase('Test failed \u2013 check connection'); if (wgEl('wg-ping')?.textContent === '--') wgText('wg-ping', 'err'); }
  }
  card?.classList.remove('testing');
  label.textContent = 'GO';
  if (btn) btn.title = 'Start speed test';
  if (!card?.classList.contains('done')) wgSpeedArc(0);
  wgSpeedXhr = null; wgSpeedCtl = null; wgSpeedBusy = false;
}
function wgSpeedRestoreValues() {
  try {
    const r = JSON.parse(localStorage.getItem('inex.wg.speed') || 'null');
    wgText('wg-ping', r && r.ping != null ? String(r.ping) : '--');
    wgText('wg-down', r && r.down != null ? r.down.toFixed(1) : '--');
    wgText('wg-up', r && r.up != null ? r.up.toFixed(1) : '--');
  } catch (_) {}
}

// ---- wiring ----
wgEl('mx-tab-controls')?.addEventListener('click', () => wgSetTab('controls'));
wgEl('mx-tab-widgets')?.addEventListener('click', () => wgSetTab('widgets'));
wgEl('wg-speed-btn')?.addEventListener('click', wgSpeedTest);
wgEl('wg-st-svg')?.addEventListener('mousemove', wgRingTip);
wgEl('wg-st-svg')?.addEventListener('mouseleave', () => { const t = wgEl('wg-st-tip'); if (t) t.style.display = 'none'; });
wgEl('wg-markets')?.addEventListener('click', () => {
  try { localStorage.setItem('inex.settings.goto', 'menu'); } catch (_) {}
  invokeTauri('open_settings');
});
function wgCommitCurrency(inp, from) {
  const resolved = wgResolveCurrency(inp.value);
  if (resolved) {
    inp.value = resolved;
    inp.title = resolved;
  } else {
    inp.value = (inp.value || '').toUpperCase().trim();
  }
  wgCurTint();
  // Changing a currency code must recalculate from the amount box (A), never from an empty/"--" box:
  // converting from B when it was empty filled both boxes with "--" and left them blank.
  const a = wgEl('wg-cur-a');
  if (a && !isFinite(wgNum(a.value))) a.value = '1';
  wgConvert('a');
}
wgEl('wg-cur-a')?.addEventListener('input', () => wgConvert('a'));
wgEl('wg-cur-b')?.addEventListener('input', () => wgConvert('b'));
['a', 'b'].forEach((side) => {
  const inp = wgEl('wg-cur-' + side + '-code');
  if (!inp) return;
  inp.addEventListener('focus', () => { inp.select(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      wgCommitCurrency(inp, side);
      inp.blur();
    }
  });
  inp.addEventListener('blur', () => {
    wgCommitCurrency(inp, side);
  });
});
wgEl('wg-cur-swap')?.addEventListener('click', () => {
  const a = wgEl('wg-cur-a'), b = wgEl('wg-cur-b'), ac = wgEl('wg-cur-a-code'), bc = wgEl('wg-cur-b-code');
  if (!a || !b || !ac || !bc) return;
  [a.value, b.value] = [b.value, a.value];
  [ac.value, bc.value] = [bc.value, ac.value];
  wgSwapDeg += 180;
  const sw = wgEl('wg-cur-swap');
  if (sw) sw.style.transform = 'rotate(' + wgSwapDeg + 'deg)';
  wgCurTint(); wgRateBadge(); wgSaveCur();
});
try {
  const saved = JSON.parse(localStorage.getItem('inex.wg.cur') || 'null');
  if (saved) {
    if (saved.a && wgEl('wg-cur-a-code')) wgEl('wg-cur-a-code').value = saved.a;
    if (saved.b && wgEl('wg-cur-b-code')) wgEl('wg-cur-b-code').value = saved.b;
    if (saved.amt && wgEl('wg-cur-a')) wgEl('wg-cur-a').value = saved.amt;
  } else {
    if (wgEl('wg-cur-a-code')) wgEl('wg-cur-a-code').value = 'USD';
    if (wgEl('wg-cur-b-code')) wgEl('wg-cur-b-code').value = 'INR';
    if (wgEl('wg-cur-a')) wgEl('wg-cur-a').value = '1';
  }
} catch (_) {}
wgCurTint();
wgSpeedRestore();
applyScreenTimeSetting();
